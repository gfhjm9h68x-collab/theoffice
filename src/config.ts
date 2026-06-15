import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineConfig } from "./types.js";

/**
 * Layered configuration: PLATFORM defaults (here in code) are overlaid by an
 * optional PRODUCT config (product/config.json) and then by TENANT overrides
 * (tenant/config/overrides.json). Tenant wins. A few keys can be overridden by
 * env for ops convenience.
 *
 * HARD RULE: nothing tenant-specific is hardcoded here. All tenant paths derive
 * from a single `tenantRoot`, which is env-overridable. (A CI lint should fail
 * the build on any new hardcoded absolute tenant path in src/.)
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up from this module to find the repo root (the dir holding package.json). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "..");
}

const REPO_ROOT = process.env.OFFICE_HOME ?? findRepoRoot(HERE);

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: nested objects merge recursively, scalars/arrays replace. Tenant wins. */
function deepMerge<T>(base: T, ...overlays: Array<DeepPartial<T> | undefined>): T {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const overlay of overlays) {
    if (!overlay) continue;
    for (const [k, v] of Object.entries(overlay)) {
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    }
  }
  return out as T;
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

let cached: EngineConfig | undefined;

export function loadConfig(): EngineConfig {
  if (cached) return cached;

  const tenantRoot = process.env.OFFICE_TENANT_ROOT ?? join(REPO_ROOT, "tenant");
  const storeDir = join(tenantRoot, "store");

  // PLATFORM defaults — generic, no tenant content.
  const platform: EngineConfig = {
    mainAgentId: "main",
    paths: {
      tenantRoot,
      storeDir,
      dbFile: join(storeDir, "theoffice.db"),
      agentsDir: join(tenantRoot, "agents"),
      secretsDir: join(tenantRoot, "secrets"),
      scheduledTasksDir: join(tenantRoot, "scheduled-tasks"),
      skillsDir: join(tenantRoot, "skills"),
      vaultKeyFile: join(storeDir, ".vault-key"),
      dashboardTokenFile: join(storeDir, ".dashboard-token"),
    },
    web: { 
      host: "127.0.0.1", 
      port: 3430,
      rateLimit: {
        maxFails: 5,
        windowMs: 15 * 60 * 1000, // 15 mins
        blockMs: 60 * 1000, // base block = 1 min; escalates on repeated lockouts
        maxBlockMs: 60 * 60 * 1000, // escalation cap = 1 hour
      }
    },
    tmux: { socket: "theoffice" },
    owner: { displayName: "Owner", locale: "en", timezone: "UTC" },
    channel: { provider: "none" },
  };

  const product = readJsonIfExists(join(REPO_ROOT, "product", "config.json")) as DeepPartial<EngineConfig> | undefined;
  const tenant = readJsonIfExists(join(tenantRoot, "config", "overrides.json")) as DeepPartial<EngineConfig> | undefined;

  let cfg = deepMerge(platform, product, tenant);

  // Select env overrides (ops convenience; never for secrets).
  if (process.env.OFFICE_PORT) cfg.web.port = Number(process.env.OFFICE_PORT);
  if (process.env.OFFICE_HOST) cfg.web.host = process.env.OFFICE_HOST;
  if (process.env.OFFICE_MAIN_AGENT) cfg.mainAgentId = process.env.OFFICE_MAIN_AGENT;
  if (process.env.OFFICE_TMUX_SOCKET) cfg.tmux.socket = process.env.OFFICE_TMUX_SOCKET;
  if (process.env.TZ) cfg.owner.timezone = process.env.TZ;
  
  if (!cfg.web.rateLimit) {
    cfg.web.rateLimit = { maxFails: 5, windowMs: 900000, blockMs: 60000, maxBlockMs: 3600000 };
  }
  if (process.env.OFFICE_RL_MAX_FAILS) cfg.web.rateLimit.maxFails = Number(process.env.OFFICE_RL_MAX_FAILS);
  if (process.env.OFFICE_RL_WINDOW_MS) cfg.web.rateLimit.windowMs = Number(process.env.OFFICE_RL_WINDOW_MS);
  if (process.env.OFFICE_RL_BLOCK_MS) cfg.web.rateLimit.blockMs = Number(process.env.OFFICE_RL_BLOCK_MS);
  if (process.env.OFFICE_RL_MAX_BLOCK_MS) cfg.web.rateLimit.maxBlockMs = Number(process.env.OFFICE_RL_MAX_BLOCK_MS);

  cached = cfg;
  return cfg;
}

/** test hook */
export function _resetConfigCache(): void {
  cached = undefined;
}

export { REPO_ROOT };
