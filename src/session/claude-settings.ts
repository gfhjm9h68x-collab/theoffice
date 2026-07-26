import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

const logger = log("claude-settings");

export interface CanonicalSettings {
  model?: string;
  effortLevel?: string;
}

/**
 * `/model` and `/effort` do not only affect the running session — they also save themselves as the
 * default in ~/.claude/settings.json. Every agent AND the owner's own interactive CLI share that file
 * (one HOME for all runtimes, by design: the credentials live there too).
 *
 * Agents are unaffected either way, because the engine launches them with explicit --model/--effort
 * flags which override the file. This restore exists purely so the owner's own CLI does not silently
 * drift onto whatever an agent was last switched to.
 *
 * Serialized through a promise chain: several agents can be tuned at once, and a read-modify-write
 * race on a shared json would lose one of the edits.
 */
let queue: Promise<void> = Promise.resolve();

export function restoreOwnerSettings(canonical: CanonicalSettings): Promise<void> {
  queue = queue.then(() => {
    try {
      const path = join(process.env.HOME ?? "", ".claude", "settings.json");
      if (!existsSync(path)) return; // nothing to restore; never create the owner a file
      const cur = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const key of ["model", "effortLevel"] as const) {
        const want = canonical[key];
        if (want === undefined) delete cur[key];
        else cur[key] = want;
      }
      writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
    } catch (err) {
      logger.warn({ err }, "could not restore owner settings"); // never fail a tune over this
    }
  });
  return queue;
}
