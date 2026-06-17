import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import {
  enqueueInbound,
  listQueued,
  markDelivering,
  markDelivered,
  requeue,
  requeueNoPenalty,
  markFailed,
  reapStaleDelivering,
  enqueueOutbound,
  listOutboundQueued,
  markOutboundSent,
  markOutboundFailed,
} from "./index.js";

let dir: string;
const row = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM inbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };
const orow = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM outbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-queue-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("inbound attempt-math", () => {
  it("markDelivering charges exactly one attempt and flips to delivering", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    markDelivering(id);
    expect(row(id)).toEqual({ status: "delivering", attempts: 1 });
  });

  it("requeue returns to queued WITHOUT refunding the attempt (bounded retry)", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    markDelivering(id);
    requeue(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 1 });
  });

  it("requeueNoPenalty refunds the attempt (usage cap never burns budget) and floors at 0", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    markDelivering(id); // attempts 1
    requeueNoPenalty(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    requeueNoPenalty(id); // already 0 -> stays 0, never negative
    expect(row(id).attempts).toBe(0);
  });

  it("markDelivered / markFailed are terminal (drop out of the queued list)", () => {
    const d = enqueueInbound({ agentId: "a", source: "manual", prompt: "d" })!;
    markDelivering(d);
    markDelivered(d);
    expect(row(d).status).toBe("delivered");
    const f = enqueueInbound({ agentId: "a", source: "manual", prompt: "f" })!;
    markDelivering(f);
    markFailed(f, "boom");
    expect(row(f).status).toBe("failed");
    const queuedIds = listQueued("a").map((i) => i.id);
    expect(queuedIds).not.toContain(d);
    expect(queuedIds).not.toContain(f);
  });
});

describe("boot reaper (P0#2)", () => {
  it("requeues orphaned 'delivering' rows and preserves their attempt count", () => {
    const id = enqueueInbound({ agentId: "reap", source: "manual", prompt: "x" })!;
    markDelivering(id); // simulate process death mid-delivery: left in 'delivering', attempts=1
    expect(row(id).status).toBe("delivering");
    const n = reapStaleDelivering();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(row(id)).toEqual({ status: "queued", attempts: 1 }); // recoverable + budget intact
    expect(listQueued("reap").map((i) => i.id)).toContain(id);
  });

  it("is idempotent — a second run with nothing delivering recovers 0", () => {
    expect(reapStaleDelivering()).toBe(0);
  });
});

describe("outbound state-machine", () => {
  it("enqueue -> queued -> sent", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    expect(orow(id).status).toBe("queued");
    expect(listOutboundQueued().map((i) => i.id)).toContain(id);
    markOutboundSent(id);
    expect(orow(id).status).toBe("sent");
    expect(listOutboundQueued().map((i) => i.id)).not.toContain(id);
  });

  it("markOutboundFailed requeues with +1 attempt until the cap, then fails (CASE sees pre-increment attempts)", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    // attempts 0->5 all stay 'queued' (CASE WHEN attempts>=5 is evaluated on the OLD value); the call that
    // sees attempts already at 5 is the one that flips to 'failed' (attempts then 6).
    for (let i = 1; i <= 5; i++) {
      markOutboundFailed(id, "net");
      expect(orow(id)).toEqual({ status: "queued", attempts: i }); // still retryable
    }
    markOutboundFailed(id, "net"); // now sees attempts=5 -> failed terminal
    expect(orow(id).status).toBe("failed");
    expect(orow(id).attempts).toBe(6);
  });
});
