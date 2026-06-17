import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { enqueueInbound, markDelivering, listQueued, reapStaleDelivering, MAX_DELIVERY_ATTEMPTS } from "./index.js";

/**
 * Boot reaper (P0#2) — its OWN database so the reaper's `WHERE status='delivering'` (which spans the whole
 * table) can't be perturbed by rows other queue tests leave behind. Order-independent.
 */

let dir: string;
const row = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM inbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };
const setDelivering = (id: number, attempts: number) =>
  getDb().prepare(`UPDATE inbound_queue SET status='delivering', attempts=? WHERE id=?`).run(attempts, id);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-reaper-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
// Per-test isolation (Toby): the reaper's UPDATE spans the whole table, so a row one test leaves in
// 'delivering' (e.g. if a guard regressed) would otherwise perturb a sibling's exact-count asserts.
// Truncating before each test keeps a broken-reaper failure contained to its own case.
beforeEach(() => {
  getDb().prepare(`DELETE FROM inbound_queue`).run();
});

describe("reapStaleDelivering", () => {
  it("requeues an orphaned delivering row and preserves its attempt count", () => {
    const id = enqueueInbound({ agentId: "reap", source: "manual", prompt: "x" })!;
    markDelivering(id); // process died mid-delivery: left 'delivering', attempts=1
    const n = reapStaleDelivering();
    expect(n).toEqual({ failed: 0, requeued: 1 });
    expect(row(id)).toEqual({ status: "queued", attempts: 1 }); // recoverable + budget intact
    expect(listQueued("reap").map((i) => i.id)).toContain(id);
  });

  it("boundary: a delivering row at attempts == MAX-1 reaps to QUEUED (still under budget)", () => {
    const id = enqueueInbound({ agentId: "boundary", source: "manual", prompt: "x" })!;
    setDelivering(id, MAX_DELIVERY_ATTEMPTS - 1);
    const n = reapStaleDelivering();
    expect(n.failed).toBe(0);
    expect(n.requeued).toBe(1);
    expect(row(id).status).toBe("queued"); // under budget -> retried, not failed
  });

  it("boundary: a delivering row at attempts == MAX reaps to FAILED (poison-message guard)", () => {
    const id = enqueueInbound({ agentId: "poison", source: "manual", prompt: "boom" })!;
    setDelivering(id, MAX_DELIVERY_ATTEMPTS);
    const n = reapStaleDelivering();
    expect(n.failed).toBe(1);
    expect(n.requeued).toBe(0);
    expect(row(id).status).toBe("failed"); // budget spent -> failed, NOT requeued forever
    expect(listQueued("poison").map((i) => i.id)).not.toContain(id);
  });

  it("is idempotent — nothing delivering recovers nothing", () => {
    expect(reapStaleDelivering()).toEqual({ failed: 0, requeued: 0 });
  });
});
