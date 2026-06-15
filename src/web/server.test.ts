import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startServer, _setClock } from "./server.js";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const MOCK_TOKEN = "test-token";

describe("Dashboard Rate Limiting", () => {
  let tempDir: string;
  let cfg: any;
  let stopServer: () => void;
  let currentMs: number;
  let port = 3431;

  beforeEach(async () => {
    tempDir = join(tmpdir(), "theoffice-test-" + Math.random().toString(36).slice(2));
    mkdirSync(join(tempDir, "store"), { recursive: true });
    writeFileSync(join(tempDir, "store", ".dashboard-token"), MOCK_TOKEN);

    currentMs = 1000000;
    _setClock(() => currentMs);

    cfg = {
      web: { host: "127.0.0.1", port: port++, rateLimit: { maxFails: 3, windowMs: 1000, blockMs: 5000 } },
      paths: { dashboardTokenFile: join(tempDir, "store", ".dashboard-token") },
      owner: { timezone: "UTC" },
      channel: { provider: "none" }
    };
    // Mock getDb, loadAgents, etc if they are hit, but we only hit 401s which don't reach handleApi
    stopServer = startServer(cfg);
    // wait a bit for server to start
    await new Promise(r => setTimeout(r, 100));
  });

  afterEach(() => {
    if (stopServer) stopServer();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    _setClock(() => Date.now()); // restore
  });

  async function req(token?: string, xff?: string) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (xff) headers["x-forwarded-for"] = xff;

    const res = await fetch(`http://${cfg.web.host}:${cfg.web.port}/api/overview`, { headers });
    return { status: res.status, retryAfter: res.headers.get("retry-after") };
  }

  it("blocks after maxFails, returns 429, resets after window", async () => {
    const ip = "1.2.3.4";
    // 1st fail
    expect((await req("bad", ip)).status).toBe(401);
    // 2nd fail
    expect((await req("bad", ip)).status).toBe(401);
    // 3rd fail (reaches maxFails 3)
    expect((await req("bad", ip)).status).toBe(401);
    
    // 4th req should be blocked
    const res = await req("bad", ip);
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBe("5"); // 5000ms / 1000

    // different IP is not blocked
    expect((await req("bad", "5.6.7.8")).status).toBe(401);

    // wait until block expires
    currentMs += 6000;
    // Window expired, should be 401 again
    expect((await req("bad", ip)).status).toBe(401);
  });

  it("successful auth resets the counter", async () => {
    const ip = "2.2.2.2";
    // 2 fails
    expect((await req("bad", ip)).status).toBe(401);
    expect((await req("bad", ip)).status).toBe(401);

    // mock successful auth (returns 500 because overview mock fails, but auth passes 401 check)
    const success = await req(MOCK_TOKEN, ip);
    expect(success.status).not.toBe(401);
    expect(success.status).not.toBe(429);

    // After success, it should be able to fail 3 times again
    expect((await req("bad", ip)).status).toBe(401);
    expect((await req("bad", ip)).status).toBe(401);
    expect((await req("bad", ip)).status).toBe(401);
    expect((await req("bad", ip)).status).toBe(429);
  });

  it("escalates the block duration on repeated lockouts", async () => {
    const ip = "9.9.9.9";
    // first lockout cycle -> base block (5000ms => Retry-After 5)
    await req("bad", ip); await req("bad", ip);
    expect((await req("bad", ip)).status).toBe(401); // 3rd fail triggers block
    const first = await req("bad", ip);
    expect(first.status).toBe(429);
    expect(first.retryAfter).toBe("5"); // base 5000ms / 1000

    // let the block + window expire (blocks count is preserved across the reset)
    currentMs += 6000;
    // second lockout cycle -> doubled block (10000ms => Retry-After 10)
    await req("bad", ip); await req("bad", ip);
    expect((await req("bad", ip)).status).toBe(401);
    const second = await req("bad", ip);
    expect(second.status).toBe(429);
    expect(second.retryAfter).toBe("10"); // escalated: 5000 * 2 / 1000
  });
});
