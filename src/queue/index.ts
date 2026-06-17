import { getDb } from "../db/index.js";
import type { QueueSource } from "../types.js";

/**
 * Max delivery attempts before an inbound item is failed. Single source of truth — the runtimes import
 * this for their per-turn budget, and the boot reaper uses it to fail items whose budget is already spent.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * The single durable inbound queue. EVERYTHING that becomes a prompt to an agent
 * — channel messages, scheduled tasks, inter-agent messages, manual — lands here,
 * and exactly one consumer (the Session Manager deliverer) drains it. There is no
 * other writer to a tmux pane, which is what removes the v1 "parked draft" races.
 */

export interface InboundItem {
  id: number;
  agent_id: string;
  source: QueueSource;
  prompt: string;
  reply_channel: string | null;
  reply_user: string | null;
  attempts: number;
}

export interface EnqueueArgs {
  agentId: string;
  source: QueueSource;
  prompt: string;
  replyChannel?: string;
  replyUser?: string;
  /** optional idempotency key; a (agentId, dedupKey) pair is enqueued at most once */
  dedupKey?: string;
}

/** Returns the new row id, or undefined if a dedup_key collision suppressed it. */
export function enqueueInbound(a: EnqueueArgs): number | undefined {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO inbound_queue (agent_id, source, prompt, reply_channel, reply_user, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(a.agentId, a.source, a.prompt, a.replyChannel ?? null, a.replyUser ?? null, a.dedupKey ?? null);
  return r.changes > 0 ? Number(r.lastInsertRowid) : undefined;
}

/** Oldest queued items, optionally for one agent. */
export function listQueued(agentId?: string, limit = 50): InboundItem[] {
  const db = getDb();
  const sql = agentId
    ? `SELECT id, agent_id, source, prompt, reply_channel, reply_user, attempts FROM inbound_queue
       WHERE status='queued' AND agent_id=? ORDER BY id ASC LIMIT ?`
    : `SELECT id, agent_id, source, prompt, reply_channel, reply_user, attempts FROM inbound_queue
       WHERE status='queued' ORDER BY id ASC LIMIT ?`;
  const stmt = db.prepare(sql);
  return (agentId ? stmt.all(agentId, limit) : stmt.all(limit)) as InboundItem[];
}

export function markDelivering(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='delivering', attempts=attempts+1 WHERE id=?`)
    .run(id);
}

export interface ReapResult {
  /** over-budget rows failed (poison-message guard) */
  failed: number;
  /** rows returned to 'queued' for redelivery */
  requeued: number;
}

/**
 * Boot reaper (P0#2): any row left in 'delivering' when the engine died never got a terminal
 * markDelivered/markFailed/requeue, so it is orphaned and would sit forever. MUST run BEFORE
 * startDeliverer, while nothing else writes the queue, so it is race-free. Idempotent.
 *
 * Poison-message guard (Toby): a message that crashes the ENGINE mid-delivery never reaches a runtime's
 * terminal handler, so decideOutcome never gets to fail it on budget — an unconditional requeue would
 * loop reap->deliver->markDelivering(attempts++)->crash->reap forever. So FAIL the rows that have already
 * burned the full budget first, THEN requeue the rest for a normal bounded retry.
 */
export function reapStaleDelivering(): ReapResult {
  const db = getDb();
  const failed = db
    .prepare(
      `UPDATE inbound_queue SET status='failed', last_error='reaped: exceeded max delivery attempts (engine crash mid-delivery)'
       WHERE status='delivering' AND attempts>=?`
    )
    .run(MAX_DELIVERY_ATTEMPTS).changes;
  const requeued = db.prepare(`UPDATE inbound_queue SET status='queued' WHERE status='delivering'`).run().changes;
  return { failed, requeued };
}

export function markDelivered(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='delivered', delivered_at=unixepoch() WHERE id=?`)
    .run(id);
}

/** Re-queue (transient: pane busy) or fail (permanent). */
export function requeue(id: number): void {
  getDb().prepare(`UPDATE inbound_queue SET status='queued' WHERE id=?`).run(id);
}

/**
 * Re-queue WITHOUT charging an attempt (refunds the +1 that markDelivering added).
 * For transient external limits that are not the message's fault — e.g. a ChatGPT
 * usage cap on a codex-runtime agent — so a cap window never burns the failure budget.
 */
export function requeueNoPenalty(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='queued', attempts=MAX(0, attempts-1) WHERE id=?`)
    .run(id);
}

export function markFailed(id: number, err: string): void {
  getDb().prepare(`UPDATE inbound_queue SET status='failed', last_error=? WHERE id=?`).run(err, id);
}

// ---- outbound (agent -> Slack) ----

export function enqueueOutbound(agentId: string, channel: string, text: string): number {
  const r = getDb()
    .prepare(`INSERT INTO outbound_queue (agent_id, channel, text) VALUES (?, ?, ?)`)
    .run(agentId, channel, text);
  return Number(r.lastInsertRowid);
}

export interface OutboundItem {
  id: number;
  agent_id: string;
  channel: string;
  text: string;
  attempts: number;
}

export function listOutboundQueued(limit = 50): OutboundItem[] {
  return getDb()
    .prepare(`SELECT id, agent_id, channel, text, attempts FROM outbound_queue WHERE status='queued' ORDER BY id ASC LIMIT ?`)
    .all(limit) as OutboundItem[];
}

export function markOutboundSent(id: number): void {
  getDb().prepare(`UPDATE outbound_queue SET status='sent', sent_at=unixepoch() WHERE id=?`).run(id);
}

export function markOutboundFailed(id: number, err: string): void {
  getDb()
    .prepare(`UPDATE outbound_queue SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END, attempts=attempts+1, last_error=? WHERE id=?`)
    .run(err, id);
}
