import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { EngineConfig } from "../types.js";
import { loadAgents, slackAgents } from "../agents.js";
import { enqueueInbound } from "../queue/index.js";
import { isAllowedSender } from "./access.js";
import { downloadFiles } from "./files.js";
import { log } from "../logger.js";

const logger = log("slack-ingest");

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload?: string;
}

export interface ParsedInbound {
  text: string;
  channel: string;
  user: string;
  ts: string;
  files: SlackFile[];
}

function parseFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const dl =
      typeof o.url_private_download === "string"
        ? o.url_private_download
        : typeof o.url_private === "string"
          ? o.url_private
          : undefined;
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : id,
      mimetype: typeof o.mimetype === "string" ? o.mimetype : "application/octet-stream",
      urlPrivateDownload: dl,
    });
  }
  return out;
}

const OCR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Scoped OCR trigger parser (deri6 tenant portal). This is the ONE narrow exception to the bot-drop:
 * it accepts ONLY a bot-posted message in the dedicated OCR channel whose JSON payload carries the
 * correct shared secret, and returns a strictly-validated submission_id. It NEVER returns bot-controlled
 * free text (only a UUID) and NEVER throws on hostile input. The global bot-drop in parseInbound is
 * unchanged; this runs before it. Pure + testable.
 */
export function parseOcrSignal(
  event: unknown,
  sig?: { channelId: string; secret: string }
): { submissionId: string; channel: string } | null {
  if (!sig) return null; // feature disabled (cfg.ocrSignal unset)
  const e = event as Record<string, unknown> | null;
  if (!e || e.type !== "message") return null;
  if (e.channel !== sig.channelId) return null; // ONLY the dedicated OCR channel
  if (!e.bot_id) return null; // the trigger IS a bot (webhook) post
  let p: unknown;
  try {
    p = JSON.parse(typeof e.text === "string" ? e.text : "{}");
  } catch {
    return null;
  }
  // JSON.parse("null")/true/1/"str"/[...] are valid JSON but not objects — reject, never throw.
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const payload = p as Record<string, unknown>;
  if (typeof payload.signal_secret !== "string" || payload.signal_secret !== sig.secret) return null;
  const id = typeof payload.submission_id === "string" ? payload.submission_id : "";
  if (!OCR_UUID_RE.test(id)) return null; // strict UUID; nothing else is trusted
  return { submissionId: id, channel: e.channel };
}

/**
 * Pure inbound parser (testable without Slack). Accepts real human messages —
 * DMs or channel posts, including ones that carry file attachments (subtype
 * "file_share") — and rejects anything from a bot (incl. the agent's own echoes),
 * edits, joins, and messages with neither text nor files.
 */
export function parseInbound(event: unknown, selfBotUserId?: string): ParsedInbound | null {
  const e = event as Record<string, unknown> | null;
  if (!e || e.type !== "message") return null;
  // allow plain messages and file uploads; reject edits / bot_message / joins / ...
  if (e.subtype && e.subtype !== "file_share") return null;
  if (e.bot_id) return null; // any bot, including self
  if (selfBotUserId && e.user === selfBotUserId) return null;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  const files = parseFiles(e.files);
  if (!text && files.length === 0) return null;
  if (typeof e.channel !== "string" || typeof e.user !== "string" || typeof e.ts !== "string") return null;
  return { text, channel: e.channel, user: e.user, ts: e.ts, files };
}

/**
 * Build the prompt delivered to the agent's session. When files were attached we
 * download them to the agent's inbox and point the agent at the local paths so it
 * can open them with the Read tool (images + PDFs). Failed downloads (e.g. the bot
 * lacks files:read) are surfaced to the agent rather than dropped silently.
 */
async function buildPrompt(parsed: ParsedInbound, agentDir: string, botToken: string): Promise<string> {
  if (parsed.files.length === 0) return parsed.text;
  const inbox = join(agentDir, "inbox");
  const dl = await downloadFiles(parsed.files, botToken, inbox, parsed.ts.replace(/\./g, "_"));
  const got = dl.filter((f) => f.ok);
  const failed = dl.filter((f) => !f.ok);
  const lines: string[] = [];
  if (got.length) {
    lines.push(`[The user attached ${got.length} file(s). Open them with the Read tool:`);
    for (const f of got) lines.push(`- ${f.path} (${f.mimetype})`);
    lines.push("]");
  }
  if (failed.length) {
    lines.push(
      `[${failed.length} attached file(s) could NOT be downloaded — the bot is likely missing the Slack files:read scope: ${failed
        .map((f) => f.name)
        .join(", ")}. Tell the user you can't open attachments until that scope is added.]`
    );
  }
  const block = lines.join("\n");
  return parsed.text ? `${parsed.text}\n\n${block}` : block;
}

/**
 * SECURITY banner. A non-owner allowed contact (e.g. a family member granted via allowFrom) must never be
 * mistaken for the owner — without this, an unlabeled DM looks identical to an owner DM and the agent can be
 * tricked into owner-only actions (cancelling the owner's tasks, health/finance). When the sender is NOT the
 * owner, prefix a clear banner that names them, states they are not the owner, and warns off owner authority.
 * Owner messages are returned UNCHANGED. Pure + testable (name resolution is done by the caller).
 */
export function tagSenderIdentity(
  basePrompt: string,
  opts: { isOwner: boolean; senderName: string; ownerName: string }
): string {
  if (opts.isOwner) return basePrompt; // owner flow unchanged
  const o = opts.ownerName;
  return (
    `[Message from ${opts.senderName} — this is NOT your owner (${o}); they are an allowed contact. ` +
    `Your reply goes to THEM, not ${o}'s DM. Do NOT assume owner authority for owner-only domains ` +
    `(health, finance, scheduling/cancelling ${o}'s tasks, etc.) — if they ask for something only ${o} ` +
    `should authorize, decline and confirm with ${o} first.]\n\n${basePrompt}`
  );
}

/**
 * Decide the delivered prompt + reply routing for an inbound human message. The reply ALWAYS routes to the
 * actual sender (never silently to the owner), and a non-owner sender is tagged via {@link tagSenderIdentity}.
 * Secure default: if no owner is configured, the sender is treated as NON-owner (never auto-granted owner
 * authority). Pure + testable.
 */
export function prepareInboundDelivery(opts: {
  basePrompt: string;
  senderId: string;
  ownerId: string | undefined;
  ownerName: string;
  senderName: string;
}): { prompt: string; replyUser: string } {
  const isOwner = !!opts.ownerId && opts.senderId === opts.ownerId;
  return {
    prompt: tagSenderIdentity(opts.basePrompt, {
      isOwner,
      senderName: opts.senderName,
      ownerName: opts.ownerName,
    }),
    replyUser: opts.senderId, // ALWAYS the real human sender — never rerouted to the owner
  };
}

// Per-id cache of resolved Slack display names (display-only; routing always uses the id). Only successful
// lookups are cached, so a transient users.info failure (or a missing users:read scope) retries next time
// rather than pinning the raw id forever.
const senderNameCache = new Map<string, string>();
async function resolveSenderName(web: WebClient | null, userId: string): Promise<string> {
  const cached = senderNameCache.get(userId);
  if (cached) return cached;
  if (!web) return userId;
  try {
    const r = await web.users.info({ user: userId });
    const p = r.user?.profile;
    const name =
      p?.display_name?.trim() || r.user?.real_name?.trim() || r.user?.name?.trim() || userId;
    senderNameCache.set(userId, name);
    return name;
  } catch (err) {
    logger.debug({ userId, err }, "users.info failed — using id as sender name (retried next message)");
    return userId;
  }
}

/**
 * Start the Slack ingest daemon: ONE Socket-Mode connection per slack-enabled
 * agent-app. Each connection is the sole consumer of its app's events (no
 * event-splitting). Inbound human messages are enqueued to the single inbound
 * queue with a Slack-ts dedup key, then drained by the Session Manager deliverer.
 */
export function startSlackIngest(cfg: EngineConfig): () => void {
  const agents = slackAgents(loadAgents(cfg));
  if (agents.length === 0) {
    logger.info("no slack-enabled agents — ingest idle");
    return () => {};
  }

  const ownerId = cfg.owner.slackUserId;
  const clients: SocketModeClient[] = [];
  for (const agent of agents) {
    const sm = new SocketModeClient({ appToken: agent.slack!.appToken! });
    // Reuse one Web client per agent for the "seen" 👀 reaction (reactions:write).
    const web = agent.slack!.botToken ? new WebClient(agent.slack!.botToken) : null;

    sm.on("message", async (args: { ack?: () => Promise<void>; event?: unknown; body?: { event?: unknown } }) => {
      if (args.ack) {
        try {
          await args.ack();
        } catch {
          /* ack best-effort */
        }
      }
      const event = args.event ?? args.body?.event;
      // Scoped OCR trigger (deri6): the ONLY bot message allowed through, and ONLY as a data-only re-OCR
      // wake. Runs BEFORE the human path; a fixed template + validated UUID is delivered (never bot text).
      const ocrSig = parseOcrSignal(event, cfg.ocrSignal);
      if (ocrSig && cfg.ocrSignal) {
        enqueueInbound({
          agentId: cfg.ocrSignal.agentId,
          source: "channel",
          prompt: `OCR-SIGNAL: run the deri6 OCR cross-check for submission ${ocrSig.submissionId}`,
          replyChannel: ocrSig.channel,
          replyUser: "ocr-signal", // synthetic — no human reply routing
          dedupKey: `ocr:${ocrSig.submissionId}`, // idempotent: a re-post never double-processes
        });
        logger.info({ submissionId: ocrSig.submissionId }, "OCR trigger accepted");
        return; // do NOT fall through to parseInbound / the human path
      }
      const parsed = parseInbound(event, agent.slack!.botUserId);
      if (!parsed) return;
      if (!isAllowedSender(parsed.user, agent.allowFrom, ownerId)) {
        logger.warn({ agent: agent.id, from: parsed.user }, "ignored DM from non-allowed user");
        return;
      }
      // Instant "I've seen this" feedback so the owner isn't left wondering — react
      // 👀 the moment we accept the message, well before the agent finishes thinking.
      // Best-effort: a missing reactions:write scope or an already-reacted message
      // must never block delivery.
      web?.reactions
        .add({ channel: parsed.channel, timestamp: parsed.ts, name: "eyes" })
        .catch((err: unknown) => logger.debug({ agent: agent.id, err }, "seen-reaction failed"));
      const basePrompt = await buildPrompt(parsed, agent.dir, agent.slack!.botToken!);
      // SECURITY: tag non-owner senders so the agent never mistakes an allowed contact for the owner.
      const isOwner = !!ownerId && parsed.user === ownerId;
      const senderName = isOwner ? cfg.owner.displayName : await resolveSenderName(web, parsed.user);
      const { prompt, replyUser } = prepareInboundDelivery({
        basePrompt,
        senderId: parsed.user,
        ownerId,
        ownerName: cfg.owner.displayName,
        senderName,
      });
      const id = enqueueInbound({
        agentId: agent.id,
        source: "channel",
        prompt,
        replyChannel: parsed.channel,
        replyUser,
        dedupKey: `slack:${parsed.ts}`,
      });
      logger.info(
        { agent: agent.id, enqueued: id != null, files: parsed.files.length },
        "inbound DM enqueued"
      );
    });

    sm.start().catch((err: unknown) => logger.error({ agent: agent.id, err }, "socket start failed"));
    clients.push(sm);
    logger.info({ agent: agent.id, name: agent.displayName }, "slack ingest socket up");
  }

  return () => {
    for (const c of clients) c.disconnect().catch(() => {});
  };
}
