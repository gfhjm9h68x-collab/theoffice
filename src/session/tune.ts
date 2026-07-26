import { hasSession, capturePane, sendText, sendKey } from "./tmux.js";
import { detectPaneState } from "./pane-state.js";
import { log } from "../logger.js";

const logger = log("tune");

export type TuneKind = "model" | "effort";

export interface TuneResult {
  ok: boolean;
  reason?: "no-session" | "not-ready" | "rejected" | "no-ack";
  /** The pane's own wording, for surfacing to the owner unchanged. */
  message?: string;
}

export interface TuneTimings {
  /** How long to wait for the current turn to finish before giving up. */
  readyWaitMs?: number;
  readyPollMs?: number;
  /** How long to wait for the CLI to acknowledge the command. */
  ackWaitMs?: number;
  ackPollMs?: number;
  /** Pause between typing the command and pressing Enter. */
  settleMs?: number;
}

const DEFAULTS: Required<TuneTimings> = {
  readyWaitMs: 120_000,
  readyPollMs: 1_000,
  ackWaitMs: 8_000,
  ackPollMs: 400,
  settleMs: 500,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acknowledgement wording, verified live against claude 2.1.220. */
const ACK_OK = [/Set effort level to /i, /Set model to /i];
const ACK_BAD = [/Invalid argument: /i, /Model '.*' not found/i];

const clean = (line: string) => line.replace(/^\s*⎿\s*/, "").trim();

/**
 * Find the CLI's reply to the command we just submitted.
 *
 * Scans from the BOTTOM up and returns the first line matching either an accept or a reject pattern,
 * whichever comes first. Direction matters: an earlier switch may still be scrolled into view, so
 * checking all-rejections-then-all-accepts (or vice versa) would let a stale line win over the fresh
 * one. The newest line is the lowest one.
 */
function matchAck(pane: string): { ok: boolean; message: string } | null {
  const lines = pane.split("\n").reverse();
  for (const line of lines) {
    for (const re of ACK_BAD) if (re.test(line)) return { ok: false, message: clean(line) };
    for (const re of ACK_OK) if (re.test(line)) return { ok: true, message: clean(line) };
  }
  return null;
}

/**
 * Switch a live agent's model or effort WITHOUT killing its tmux session, so it keeps its context.
 *
 * Waits for the pane to go idle first (finish the current turn, then switch), injects `/model <v>` or
 * `/effort <v>`, then READS THE ACKNOWLEDGEMENT BACK. The read-back is not optional: a command sent
 * while the pane is still busy is swallowed silently — no output, no error — so without it we would
 * report a success that never happened.
 *
 * The caller is expected to have already persisted the value to agent.json, so a `no-ack` here means
 * "not applied to the running session, but correct at next launch" rather than data loss.
 */
export async function applyTune(
  socket: string,
  session: string,
  kind: TuneKind,
  value: string,
  timings: TuneTimings = {},
): Promise<TuneResult> {
  const t = { ...DEFAULTS, ...timings };
  if (!hasSession(socket, session)) return { ok: false, reason: "no-session" };

  // wait for the current turn to finish rather than interleaving with it
  const readyDeadline = Date.now() + t.readyWaitMs;
  for (;;) {
    const pane = capturePane(socket, session);
    if (pane != null && detectPaneState(pane) === "idle") break;
    if (Date.now() >= readyDeadline) {
      logger.warn({ session, kind, value }, "pane never went idle — not tuning");
      return { ok: false, reason: "not-ready" };
    }
    await sleep(t.readyPollMs);
  }

  const before = capturePane(socket, session) ?? "";
  sendText(socket, session, `/${kind} ${value}`);
  await sleep(t.settleMs);
  sendKey(socket, session, "Enter");

  const ackDeadline = Date.now() + t.ackWaitMs;
  for (;;) {
    await sleep(t.ackPollMs);
    const pane = capturePane(socket, session) ?? "";
    if (pane !== before) {
      const ack = matchAck(pane);
      if (ack) {
        logger.info({ session, kind, value, ok: ack.ok }, "tune acknowledged");
        return ack.ok
          ? { ok: true, message: ack.message }
          : { ok: false, reason: "rejected", message: ack.message };
      }
    }
    if (Date.now() >= ackDeadline) {
      logger.warn({ session, kind, value }, "tune not acknowledged — swallowed?");
      return { ok: false, reason: "no-ack" };
    }
  }
}
