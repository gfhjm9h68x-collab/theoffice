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
  mkdirSync(join(tasksDir, "daily-3am"), { recursive: true });
  writeFileSync(
    join(tasksDir, "daily-3am", "task-config.json"),
    JSON.stringify({ schedule: "0 3 * * *", agent: "main", type: "task", prompt: "daily 3am job" })
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

  it("6h CUTOFF: a daily task whose last occurrence is ~11h ago is NOT caught up (proves the bound)", () => {
    // T = 14:00 Budapest; the daily 03:00 Budapest job last ran 11h ago — beyond the 6h window. Even though
    // it falls after lastTick (engine was down 30h), it must NOT be caught up. The shipped every-minute test
    // only asserted <=1; this proves the cutoff specifically against a real daily schedule.
    const T = Date.parse("2026-06-22T12:00:00Z"); // 14:00 Europe/Budapest
    setLastTick(T - 30 * 60 * 60 * 1000); // 30h ago, so the daily occurrence IS after lastTick...
    const before = runsFor("daily-3am");
    catchUpMissed(cfg, T);
    expect(runsFor("daily-3am")).toBe(before); // ...but it's >6h old -> bounded out, never fired
  });

  it("watermark guard (occ <= since): an occurrence at/before the cutoff is skipped, one just after fires", () => {
    const T = Date.parse("2026-06-25T10:00:00Z");
    // boundary: latest every-minute occurrence is T-1m. With lastTick = T-1m, since = T-1m, so occ == since -> skip.
    setLastTick(T - 1 * 60000);
    let b = runsFor("every-minute");
    catchUpMissed(cfg, T);
    expect(runsFor("every-minute")).toBe(b); // occ (T-1m) <= since (T-1m) -> not fired

    // one minute earlier watermark: lastTick = T-2m -> since = T-2m, occ (T-1m) > since -> fires once.
    getDb().prepare(`DELETE FROM task_runs WHERE name='every-minute' AND ts>=?`).run(Math.floor((T - 5 * 60000) / 1000));
    setLastTick(T - 2 * 60000);
    b = runsFor("every-minute");
    catchUpMissed(cfg, T);
    expect(runsFor("every-minute")).toBe(b + 1); // occ (T-1m) > since (T-2m) -> fired exactly once
  });
});
