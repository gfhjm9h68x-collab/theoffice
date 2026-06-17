import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { hasSession, sessionNameFor } from "./tmux.js";
import { listQueued } from "../queue/index.js";
import { loadAgents } from "../agents.js";
import { runtimeFor } from "./runtime.js";

const logger = log("session");

const DELIVERER_TICK_MS = 2000; // queue drain cadence

// Re-exported so existing importers (the web server) keep a stable import path.
export { sessionNameFor } from "./tmux.js";

/**
 * Launch an agent via its configured runtime. The runtime ("claude" default, "codex", or any future
 * provider) owns the actual spawn; this is just the provider-agnostic entry point.
 */
export function launchAgent(cfg: EngineConfig, agent: AgentDef): boolean {
  return runtimeFor(agent).launch(cfg, agent);
}

/**
 * Launch every enabled agent that isn't already running. Called once at boot so
 * the fleet comes up on its own after a reboot — without this, a fresh tmux
 * server (only __keepalive) has no agent sessions and nothing relaunches them,
 * so inbound messages pile up undelivered until someone clicks "start" in the
 * dashboard. Idempotent: skips agents whose session already exists. Provider-agnostic:
 * each agent launches via its own runtime.
 */
export function launchEnabledAgents(cfg: EngineConfig): void {
  const socket = cfg.tmux.socket;
  let launched = 0;
  for (const agent of loadAgents(cfg)) {
    if (!agent.enabled) continue;
    if (hasSession(socket, sessionNameFor(agent.id))) continue; // already up — leave it
    if (launchAgent(cfg, agent)) launched++;
  }
  logger.info({ launched }, "autostart: launched enabled agents");
}

/**
 * The single deliverer loop. Drains the inbound queue: for each queued item whose target session is
 * running, hand it to that agent's runtime to deliver. The runtime owns readiness gating and ALL queue
 * bookkeeping (markDelivered / markFailed / requeue); this loop only skips agents that are not running
 * or busy, so one stuck or in-flight agent never blocks delivery for the others.
 */
export function startDeliverer(cfg: EngineConfig): () => void {
  const socket = cfg.tmux.socket;
  let stopped = false;
  let running = false; // reentrancy guard: a tick can outlast DELIVERER_TICK_MS (await rt.deliver)

  const tick = async () => {
    if (stopped) return;
    // P0#4: if the previous tick is still in flight, skip this one. Without this, a slow tick lets the
    // next interval fire concurrently and the same queued item is read+delivered twice (double-inject).
    if (running) return;
    running = true;
    try {
      const byId = new Map(loadAgents(cfg).map((a) => [a.id, a]));
      for (const item of listQueued()) {
        const session = sessionNameFor(item.agent_id);
        if (!hasSession(socket, session)) continue; // agent not running -> leave queued
        const agent = byId.get(item.agent_id);
        if (!agent) continue; // unknown agent (roster changed) -> leave queued
        const rt = runtimeFor(agent);
        if (rt.isBusy(item.agent_id)) continue; // async turn in flight / usage back-off -> leave queued
        await rt.deliver(cfg, agent, item); // runtime owns readiness + queue bookkeeping
      }
    } catch (err) {
      logger.error({ err }, "deliverer tick error");
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), DELIVERER_TICK_MS);
  logger.info({ socket, tickMs: DELIVERER_TICK_MS }, "deliverer started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
