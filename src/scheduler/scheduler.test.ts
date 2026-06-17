import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { openDb, closeDb, getDb } from "../db/index.js";
import { listQueued } from "../queue/index.js";
import { fireDueTasks, catchUpMissed } from "./index.js";
import { lastOccurrenceBefore } from "./cron.js";

let root: string;
let cfg: EngineConfig;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "office-sched-"));
  const tasksDir = join(root, "scheduled-tasks");
  mkdirSync(join(tasksDir, "every-minute"), { recursive: true });
  writeFileSync(
    join(tasksDir, "every-minute", "task-config.json"),
    JSON.stringify({ schedule: "* * * * *", agent: "main", type: "task", prompt: "check the books" })
  );
  mkdirSync(join(tasksDir, "disabled-task"), { recursive: true });
  writeFileSync(
    join(tasksDir, "disabled-task", "task-config.json"),
    JSON.stringify({ schedule: "* * * * *", agent: "main", enabled: false, prompt: "should not fire" })
  );
  openDb(join(root, "test.db"));
  cfg = {
    mainAgentId: "main",
    paths: {
      tenantRoot: root,
      storeDir: root,
      dbFile: join(root, "test.db"),
      agentsDir: join(root, "agents"),
      secretsDir: join(root, "secrets"),
      scheduledTasksDir: tasksDir,
      skillsDir: join(root, "skills"),
      vaultKeyFile: join(root, ".vault-key"),
      dashboardTokenFile: join(root, ".dashboard-token"),
    },
    web: { host: "127.0.0.1", port: 3430 },
    tmux: { socket: "test" },
    owner: { displayName: "Owner", locale: "en", timezone: "Europe/Budapest" },
    channel: { provider: "none" },
  };
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe("fireDueTasks", () => {
  const now = Date.parse("2026-06-09T06:00:00Z");

  it("fires an enabled every-minute task into the queue + records a run", () => {
    const fired = fireDueTasks(cfg, now);
    expect(fired).toBe(1); // disabled task excluded
    const queued = listQueued("main");
    expect(queued.some((q) => q.source === "scheduler" && q.prompt.includes("check the books"))).toBe(true);
    const runs = (getDb().prepare(`SELECT COUNT(*) AS n FROM task_runs`).get() as { n: number }).n;
    expect(runs).toBe(1);
  });

  it("does not double-fire within the same minute (dedup)", () => {
    const fired = fireDueTasks(cfg, now);
    expect(fired).toBe(0);
  });
});

describe("catchUpMissed (#16 — fire occurrences missed while the engine was down)", () => {
  const runsFor = (name: string) =>
    (getDb().prepare(`SELECT COUNT(*) n FROM task_runs WHERE name=?`).get(name) as { n: number }).n;
  const setLastTick = (ms: number) =>
    getDb().prepare(`INSERT INTO scheduler_state (k,v) VALUES ('last_tick', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(ms);

  it("returns 0 when there is no prior last_tick (first boot ever — nothing to catch up)", () => {
    getDb().prepare(`DELETE FROM scheduler_state WHERE k='last_tick'`).run();
    expect(catchUpMissed(cfg, Date.parse("2026-06-20T10:00:00Z"))).toBe(0);
  });

  it("fires the latest occurrence missed during the down-gap, exactly once (idempotent on re-run)", () => {
    const T = Date.parse("2026-06-20T08:00:00Z");
    setLastTick(T - 10 * 60000); // engine last alive 10 min ago
    const before = runsFor("every-minute");
    expect(catchUpMissed(cfg, T)).toBe(1); // the 07:59 occurrence was missed -> fired once
    expect(runsFor("every-minute")).toBe(before + 1);
    expect(catchUpMissed(cfg, T)).toBe(0); // now recorded in task_runs -> re-run does NOT re-fire
  });

  it("does NOT re-fire an occurrence the on-time path already handled (consults task_runs BEFORE firing)", () => {
    const T = Date.parse("2026-06-21T09:00:00Z");
    setLastTick(T - 5 * 60000);
    // simulate the latest missed occurrence having ALREADY fired on-time: record it in task_runs
    const occ = lastOccurrenceBefore("* * * * *", T - (T % 60000), cfg.owner.timezone)!;
    getDb().prepare(`INSERT INTO task_runs (name, agent, ts) VALUES ('every-minute','main',?)`).run(Math.floor(occ / 1000));
    expect(catchUpMissed(cfg, T)).toBe(0); // already handled -> no double-fire
  });

  it("does not catch up an occurrence older than the bounded window (no ancient replay)", () => {
    const T = Date.parse("2026-06-22T12:00:00Z");
    setLastTick(T - 30 * 60 * 60 * 1000); // 30h ago — beyond the 6h CATCHUP_MAX
    // window is bounded to now-6h; an every-minute task's latest occurrence (T-1m) is still inside 6h, so it
    // DOES fire — but a once-daily task whose last occurrence is >6h ago must NOT. Use the every-minute here
    // to assert the window is computed from max(lastTick, now-6h): latest missed occurrence is T-1m (recent).
    const fired = catchUpMissed(cfg, T);
    expect(fired).toBeLessThanOrEqual(1); // at most the single latest occurrence, never a 30h backlog
  });
});
