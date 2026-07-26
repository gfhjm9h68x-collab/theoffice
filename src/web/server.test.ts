import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startServer, _setClock } from "./server.js";
import { openDb, closeDb } from "../db/index.js";
import type { EngineConfig } from "../types.js";
import { spawnSync } from "node:child_process";

/** Throwaway tmux socket for the tuning tests; torn down in afterEach so runs can't poison each other. */
const TEST_TMUX_SOCKET = "theoffice-vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as netCreateServer } from "node:net";

const MOCK_TOKEN = "test-token";

// Grab a free OS-assigned port per test. The server binds a FIXED port and only
// LOGS an EADDRINUSE (never throws), so a hardcoded port that another process is
// squatting would silently route the test's requests to the squatter — the exact
// flake that made the 429 assertion read 401. An ephemeral port can't collide.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

describe("Dashboard Rate Limiting", () => {
  let tempDir: string;
  let cfg: any;
  let stopServer: () => void;
  let currentMs: number;

  beforeEach(async () => {
    tempDir = join(tmpdir(), "theoffice-test-" + Math.random().toString(36).slice(2));
    mkdirSync(join(tempDir, "store"), { recursive: true });
    writeFileSync(join(tempDir, "store", ".dashboard-token"), MOCK_TOKEN);

    currentMs = 1000000;
    _setClock(() => currentMs);

    cfg = {
      web: { host: "127.0.0.1", port: await freePort(), rateLimit: { maxFails: 3, windowMs: 1000, blockMs: 5000 } },
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

describe("static file serving", () => {
  let tempDir: string;
  let cfg: any;
  let stopServer: () => void;
  let base: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), "theoffice-static-test-" + Math.random().toString(36).slice(2));
    mkdirSync(join(tempDir, "store"), { recursive: true });
    writeFileSync(join(tempDir, "store", ".dashboard-token"), MOCK_TOKEN);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cfg = {
      web: { host: "127.0.0.1", port },
      paths: { dashboardTokenFile: join(tempDir, "store", ".dashboard-token") },
      owner: { timezone: "UTC" },
      channel: { provider: "none" },
    };
    stopServer = startServer(cfg);
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    if (stopServer) stopServer();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  // A directory path passes existsSync but is not readable as a file: readFileSync throws EISDIR,
  // and an unauthenticated GET /mc would take the whole engine down with it.
  it("404s a directory path instead of crashing (EISDIR)", async () => {
    const res = await fetch(`${base}/mc`);
    expect(res.status).toBe(404);
  });

  it("still serves the directory index when the path ends in a slash", async () => {
    const res = await fetch(`${base}/mc/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<");
  });

  it("keeps serving after a directory request (the process must survive)", async () => {
    await fetch(`${base}/mc`).catch(() => undefined);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });
});

/**
 * Model/effort pins are written to agent.json FIRST and only then applied to the live pane, so a
 * pin is never lost just because the injection could not happen. These tests run with no tmux
 * session at all, which is exactly that case: applyTune reports no-session, and agent.json must
 * still be correct.
 */
describe("agent effort/model tuning", () => {
  let tempDir: string;
  let cfg: EngineConfig;
  let stopServer: () => void;
  let base: string;

  const agentJson = () =>
    JSON.parse(readFileSync(join(tempDir, "agents", "home", "agent.json"), "utf8"));

  const tune = (action: string, body: unknown) =>
    fetch(`${base}/api/agents/home/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tempDir = join(tmpdir(), "theoffice-tune-" + Math.random().toString(36).slice(2));
    mkdirSync(join(tempDir, "store"), { recursive: true });
    mkdirSync(join(tempDir, "agents", "home"), { recursive: true });
    mkdirSync(join(tempDir, "secrets", "slack"), { recursive: true });
    writeFileSync(join(tempDir, "store", ".dashboard-token"), MOCK_TOKEN);
    // handleApi opens with getDb() on every request, so an authenticated route needs a live db
    openDb(join(tempDir, "store", "test.db"));
    writeFileSync(
      join(tempDir, "agents", "home", "agent.json"),
      JSON.stringify({ displayName: "Home", model: "claude-opus-4-8" }),
    );
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cfg = {
      web: { host: "127.0.0.1", port, rateLimit: { maxFails: 50, windowMs: 1000, blockMs: 1000 } },
      paths: {
        dashboardTokenFile: join(tempDir, "store", ".dashboard-token"),
        agentsDir: join(tempDir, "agents"),
        secretsDir: join(tempDir, "secrets"),
        tenantRoot: tempDir,
      },
      owner: { timezone: "UTC" },
      channel: { provider: "none" },
      // dedicated throwaway socket: no session exists here, so applyTune reports no-session
      tmux: { socket: TEST_TMUX_SOCKET },
    } as unknown as EngineConfig;
    stopServer = startServer(cfg);
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    if (stopServer) stopServer();
    closeDb();
    // The non-claude restart path calls launchAgent for real, which CREATES a session on this
    // socket. Left behind, the next run's hasSession() returns true and applyTune waits on a pane
    // that never goes idle — a self-inflicted 5s timeout. Kill the whole test tmux server.
    spawnSync("tmux", ["-L", TEST_TMUX_SOCKET, "kill-server"], { stdio: "ignore" });
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an unknown effort level with 400 and does not touch agent.json", async () => {
    const res = await tune("effort", { effort: "banana" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown effort/i);
    expect(agentJson().effort).toBeUndefined();
  });

  it("persists a valid effort even when the live pane cannot be tuned", async () => {
    const res = await tune("effort", { effort: "xhigh" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effort).toBe("xhigh");
    expect(body.applied).toBe(false); // no session -> not live, but…
    expect(agentJson().effort).toBe("xhigh"); // …durable truth is written regardless
  });

  it('clears the pin when given "default"', async () => {
    await tune("effort", { effort: "xhigh" });
    const res = await tune("effort", { effort: "default" });
    expect(res.status).toBe(200);
    expect(agentJson().effort).toBeUndefined();
  });

  it("a model change no longer kills the session — agent.json is written and the pin persists", async () => {
    const res = await tune("model", { model: "claude-opus-5" });
    expect(res.status).toBe(200);
    expect(agentJson().model).toBe("claude-opus-5");
  });

  // C1: the model value is typed into the live pane as `/model <value>`. A value with an interior
  // newline would submit the model line then inject arbitrary keystrokes/slash-commands. It must be
  // rejected BEFORE anything is persisted or typed.
  it("rejects a model with an interior newline (pane-injection) with 400 and does not persist it", async () => {
    const res = await tune("model", { model: "claude-sonnet-5\n/effort max" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid model/i);
    expect(agentJson().model).toBe("claude-opus-4-8"); // unchanged from setup — never reached the pane
  });

  it("rejects an off-menu / non-allowlisted model with 400 and does not persist it", async () => {
    const res = await tune("model", { model: "claude-opus-1000-ultra-expensive" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown model/i);
    expect(agentJson().model).toBe("claude-opus-4-8"); // unchanged — cost/allowlist guard held
  });

  it("refuses effort on a non-claude runtime — the knob does not exist there", async () => {
    writeFileSync(
      join(tempDir, "agents", "home", "agent.json"),
      JSON.stringify({ displayName: "Home", runtime: "gemini" }),
    );
    const res = await tune("effort", { effort: "xhigh" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/claude-only/i);
    expect(agentJson().effort).toBeUndefined();
  });

  it("applies a non-claude model change by restarting, not by injecting a slash command", async () => {
    writeFileSync(
      join(tempDir, "agents", "home", "agent.json"),
      JSON.stringify({ displayName: "Home", runtime: "gemini" }),
    );
    const res = await tune("model", { model: "gemini-3.6-flash-high" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toMatch(/restarted/i);
    expect(agentJson().model).toBe("gemini-3.6-flash-high");
  });
});
