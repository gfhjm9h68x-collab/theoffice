// Claude sign-in, from the dashboard — no terminal required.
//
// WHY THIS EXISTS (incident 2026-07-25): the Claude OAuth credential expired and every agent in the
// fleet went silent at once. Each pane sat at `Not logged in · Run /login` — alive, but unable to make
// a single API call. Two things made that outage far worse than it needed to be:
//
//   1. NOTHING DETECTED IT. /api/agents happily reported `running=true state=idle` for all 10 agents,
//      because the health check only proves a process is alive in the pane — it never tests whether
//      that process can authenticate. The dashboard was fully green during a total outage.
//   2. THE ONLY FIX NEEDED A TERMINAL. Emergency Restart cannot help: restarting a pane just makes it
//      re-read ~/.claude/.credentials.json, so if the on-disk credential is still expired the fresh
//      pane comes up equally dead. The owner restarted three times before the credential was renewed
//      and reasonably concluded the button was broken. The real fix — `/login` — was terminal-only.
//
// So this module does three things, all reachable from a phone:
//   - DETECT   getAuthHealth(): reads the credential AND scans the live panes for the signed-out banner.
//   - REPAIR   startLogin()/submitCode(): drives `claude auth login` inside a dedicated tmux session,
//              scrapes the OAuth URL out for the browser, and types the pasted code back in.
//   - RESTART  restartSignedOutAgents(): re-launches panes so they pick up the new credential.
//
// ORDER MATTERS and is enforced by the flow: credential first, panes second. Reversed, it never works.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { loadAgents } from "../agents.js";
import { capturePane, hasSession, killSession, newSession, sendKey, sendText, sessionNameFor } from "../session/tmux.js";
import { launchAgent } from "../session/session-manager.js";
import { log } from "../logger.js";

const logger = log("claude-auth");

/** The tmux session the interactive `claude auth login` runs in. Dedicated + disposable. */
const LOGIN_SESSION = "__office-login";

/** Panes are created wide so the OAuth URL isn't hard-wrapped; capture also passes -J as a belt-and-braces de-wrap. */
const LOGIN_COLS = 500;
const LOGIN_ROWS = 50;

/** Credential file every agent on this box shares (agents inherit HOME=szoszo). */
export const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");

/**
 * There are TWO expiries in the credential and only one of them matters for alerting:
 *
 *   accessToken  / expiresAt              — ~8 HOURS. Claude Code silently refreshes this on its own,
 *                                           so it lapses harmlessly every night. Alerting on it would
 *                                           page the owner daily for a non-event and train them to
 *                                           ignore the alarm.
 *   refreshToken / refreshTokenExpiresAt  — ~30 DAYS. When THIS lapses nothing can self-renew and a
 *                                           full interactive `/login` is the only way back. This is
 *                                           what actually took the fleet down on 2026-07-25.
 *
 * So: warn on the refresh token, days ahead, and judge "is the fleet actually broken right now?" from
 * the live panes rather than from the access token's clock.
 */
const REFRESH_WARN_SEC = 3 * 86400;

/** Substrings Claude Code prints in a pane when it cannot authenticate. */
const SIGNED_OUT_MARKERS = [
  "Not logged in",
  "Login expired",
  "Invalid authentication credentials",
  "Please run /login",
];

export interface CredentialState {
  present: boolean;
  /** access token expiry, epoch ms; 0 when unknown. Self-refreshing — informational only. */
  expiresAt: number;
  /** access token is past its ~8h life. NOT an outage on its own: Claude Code renews it silently. */
  expired: boolean;
  /** seconds until access-token expiry (negative once expired); null when unknown */
  expiresInSec: number | null;
  hasRefreshToken: boolean;
  /** refresh token expiry, epoch ms; 0 when unknown. THE deadline that forces an interactive login. */
  refreshExpiresAt: number;
  /** refresh token is gone/expired => nothing can self-renew => full sign-in required. */
  refreshExpired: boolean;
  refreshExpiresInSec: number | null;
  /** refresh token still valid but inside the warning window — sign in now, on your own schedule. */
  refreshExpiringSoon: boolean;
  /** file mtime epoch ms — the reliable "the credential actually changed" signal */
  mtime: number;
}

export interface AgentAuthState {
  id: string;
  displayName: string;
  runtime: string;
  /** pane shows a signed-out banner */
  signedOut: boolean;
  /** no tmux session at all (can't tell, and it isn't running anyway) */
  noSession: boolean;
}

export interface AuthHealth {
  /** false when the owner needs to do something */
  ok: boolean;
  /** machine-readable: "healthy" | "no-credential" | "expired" | "agents-signed-out" | "expiring-soon" */
  status: string;
  /** one line, written for a phone screen */
  message: string;
  credential: CredentialState;
  agents: AgentAuthState[];
  signedOutCount: number;
  /** true when credential is GOOD but panes are stale — a plain restart fixes it, no login needed */
  restartWouldFix: boolean;
  checkedAt: string;
}

/**
 * Read the shared OAuth credential. Deliberately returns NO token material — only timing/shape — so
 * this can be served to the dashboard without ever putting a secret on the wire.
 */
export function readCredentialState(file: string = CREDENTIALS_FILE): CredentialState {
  const empty: CredentialState = {
    present: false,
    expiresAt: 0,
    expired: true,
    expiresInSec: null,
    hasRefreshToken: false,
    refreshExpiresAt: 0,
    refreshExpired: true,
    refreshExpiresInSec: null,
    refreshExpiringSoon: false,
    mtime: 0,
  };
  try {
    if (!existsSync(file)) return empty;
    const mtime = statSync(file).mtimeMs;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: Record<string, unknown> };
    const o = parsed.claudeAiOauth;
    if (!o) return { ...empty, mtime };
    const now = Date.now();
    const expiresAt = Number(o.expiresAt ?? 0);
    const expiresInSec = expiresAt > 0 ? Math.round((expiresAt - now) / 1000) : null;

    const hasRefreshToken = typeof o.refreshToken === "string" && o.refreshToken.length > 0;
    const refreshExpiresAt = Number(o.refreshTokenExpiresAt ?? 0);
    const refreshExpiresInSec = refreshExpiresAt > 0 ? Math.round((refreshExpiresAt - now) / 1000) : null;
    // An unknown refresh expiry (older credential shape) is treated as NOT expired — better to stay
    // quiet and let the live pane scan catch a real outage than to cry wolf on a missing field.
    const refreshExpired = !hasRefreshToken || (refreshExpiresAt > 0 && refreshExpiresAt <= now);

    return {
      present: true,
      expiresAt,
      expired: !(expiresAt > now),
      expiresInSec,
      hasRefreshToken,
      refreshExpiresAt,
      refreshExpired,
      refreshExpiresInSec,
      refreshExpiringSoon:
        !refreshExpired && refreshExpiresInSec !== null && refreshExpiresInSec < REFRESH_WARN_SEC,
      mtime,
    };
  } catch (err) {
    logger.warn({ err }, "could not read credential file");
    return empty;
  }
}

/** True when a captured pane is showing a "you are signed out" banner. */
export function paneLooksSignedOut(pane: string): boolean {
  return SIGNED_OUT_MARKERS.some((m) => pane.includes(m));
}

/**
 * Scan every enabled Claude-runtime agent's pane. Codex-runtime agents are skipped: they authenticate
 * against a different provider entirely and are unaffected by a Claude credential lapse.
 */
export function scanAgentAuth(cfg: EngineConfig): AgentAuthState[] {
  const out: AgentAuthState[] = [];
  for (const a of loadAgents(cfg).filter((x) => x.enabled)) {
    const runtime = a.runtime ?? "claude";
    if (runtime !== "claude") continue;
    const session = sessionNameFor(a.id);
    if (!hasSession(cfg.tmux.socket, session)) {
      out.push({ id: a.id, displayName: a.displayName, runtime, signedOut: false, noSession: true });
      continue;
    }
    // The banner sits on the status line but can scroll; read a little history so a busy pane
    // that has since printed output doesn't read as healthy.
    const pane = capturePane(cfg.tmux.socket, session, { join: true, start: -40 }) ?? "";
    out.push({
      id: a.id,
      displayName: a.displayName,
      runtime,
      signedOut: paneLooksSignedOut(pane),
      noSession: false,
    });
  }
  return out;
}

/** Combine credential + pane state into the single verdict the dashboard banner renders. */
export function getAuthHealth(cfg: EngineConfig): AuthHealth {
  const credential = readCredentialState();
  const agents = scanAgentAuth(cfg);
  const signedOut = agents.filter((a) => a.signedOut);
  const signedOutCount = signedOut.length;
  const names = signedOut.map((a) => a.displayName || a.id).join(", ");

  let status = "healthy";
  let message = "Signed in — all agents authenticated.";
  let ok = true;
  // A good credential with signed-out panes is the one case a plain restart fixes.
  let restartWouldFix = false;

  // Order matters: the states that need a full sign-in come first, then the ones a restart fixes,
  // then the purely advisory warning. Note the ACCESS token's expiry is never itself an alarm — it
  // lapses every ~8h by design and Claude Code renews it silently.
  if (!credential.present) {
    ok = false;
    status = "no-credential";
    message = "No Claude credential on this box. Sign in to bring the fleet up.";
  } else if (credential.refreshExpired) {
    ok = false;
    status = "expired";
    message = "Claude login EXPIRED — nothing can renew it automatically. Sign in to bring the agents back.";
  } else if (signedOutCount > 0) {
    ok = false;
    status = "agents-signed-out";
    // The credential can still renew itself, so these panes are merely stale — a restart is enough.
    restartWouldFix = true;
    message = `Login is valid but ${signedOutCount} agent${signedOutCount === 1 ? "" : "s"} still signed out (${names}). Restarting them picks the login up.`;
  } else if (credential.refreshExpiringSoon) {
    ok = false;
    status = "expiring-soon";
    message = `Claude login must be renewed within ${formatDuration(credential.refreshExpiresInSec ?? 0)} — sign in now, on your own schedule, instead of being caught out.`;
  }

  return {
    ok,
    status,
    message,
    credential,
    agents,
    signedOutCount,
    restartWouldFix,
    checkedAt: new Date().toISOString(),
  };
}

export function formatDuration(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = s / 3600;
  return h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`;
}

// ---------------------------------------------------------------------------
// Interactive login, driven through tmux
// ---------------------------------------------------------------------------

export interface LoginState {
  active: boolean;
  /** "starting" | "awaiting-code" | "verifying" | "success" | "error" | "idle" */
  phase: string;
  url: string | null;
  error: string | null;
  startedAt: string | null;
  /** credential mtime captured BEFORE the login began — success = this value changes */
  baselineMtime: number;
}

const idleState = (): LoginState => ({
  active: false,
  phase: "idle",
  url: null,
  error: null,
  startedAt: null,
  baselineMtime: 0,
});

/**
 * Exactly one login can be in flight at a time, and it MUST stay alive between "show URL" and
 * "submit code": the URL embeds a PKCE code_challenge that only this process can complete. Starting a
 * second login invalidates the first one's challenge, so a new start always kills the old session.
 */
let login: LoginState = idleState();

export function getLoginState(): LoginState {
  return { ...login };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the login pane, de-wrapping hard-wrapped lines (-J) so a wrapped URL comes back whole. */
function captureLoginPane(socket: string): string {
  const r = capturePane(socket, LOGIN_SESSION, { join: true, start: -200 });
  return r ?? "";
}

const OAUTH_START_RE = /https:\/\/claude\.com\/\S*oauth\S*/i;

/**
 * Pull the OAuth URL out of the login pane.
 *
 * A TRUNCATED url is worse than none: it would hand the owner a link that fails at exactly the moment
 * they cannot fall back to a terminal. So this only returns a URL it can prove is complete (the CLI
 * always emits both `code_challenge` and `state`); anything short is treated as "not printed yet" and
 * the caller keeps polling, eventually timing out with an honest error instead of a dead link.
 *
 * Wrapped panes: capture-pane -J plus a 500-column session normally prevents wrapping entirely. As a
 * fallback we re-join continuation rows — a wrapped URL's continuation contains NO spaces, whereas the
 * prose that follows it ("Paste code here if prompted >") does, which cleanly bounds the join.
 */
export function extractOAuthUrl(pane: string): string | null {
  const lines = pane.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(OAUTH_START_RE);
    if (!m) continue;
    let candidate = m[0];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (!next || /\s/.test(next)) break; // blank line or prose = end of the URL
      candidate += next;
    }
    const url = candidate.replace(/\s+/g, "");
    if (url.includes("code_challenge=") && url.includes("state=")) return url;
  }
  return null;
}

/**
 * Kick off `claude auth login` and return the URL for the owner's browser.
 * Idempotent-ish: any previous login session is torn down first.
 */
export async function startLogin(cfg: EngineConfig): Promise<{ ok: boolean; url?: string; error?: string }> {
  const socket = cfg.tmux.socket;
  cancelLogin(cfg); // never leave a stale PKCE challenge running

  const baselineMtime = readCredentialState().mtime;
  login = { ...idleState(), active: true, phase: "starting", startedAt: new Date().toISOString(), baselineMtime };

  // `claude auth login` prints the URL then blocks on "Paste code here". The trailing sleep keeps the
  // pane (and its scrollback) alive after the CLI exits so we can still read the outcome.
  //
  // PATH/HOME are set explicitly, exactly as the agent runtimes do. The engine runs under systemd with
  // a minimal PATH, and a tmux pane it spawns does NOT inherit an interactive shell's environment — so
  // without this the pane dies instantly with `sh: claude: not found` and the poll below just times out.
  // HOME must be right too: it decides which .credentials.json the login writes.
  const home = process.env.HOME ?? "";
  const ok = newSession(socket, LOGIN_SESSION, {
    cwd: cfg.paths.tenantRoot,
    command: ["/bin/sh", "-c", "claude auth login --claudeai; echo __OFFICE_LOGIN_EXIT=$?; sleep 900"],
    env: {
      PATH: `${home}/.local/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      HOME: home,
      TZ: cfg.owner.timezone,
    },
    width: LOGIN_COLS,
    height: LOGIN_ROWS,
  });
  if (!ok) {
    login = { ...idleState(), phase: "error", error: "could not start login session" };
    return { ok: false, error: "could not start login session" };
  }

  // Poll for the URL — the CLI takes a couple of seconds to reach the prompt.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const pane = captureLoginPane(socket);
    const url = extractOAuthUrl(pane);
    if (url) {
      login = { ...login, phase: "awaiting-code", url };
      logger.warn("dashboard login started — awaiting code from owner");
      return { ok: true, url };
    }
    // The CLI exited before printing a URL (bad PATH, missing binary, immediate error). Surface the
    // real reason now instead of stalling for the full timeout and reporting a generic "timed out".
    const dead = /__OFFICE_LOGIN_EXIT=(\d+)/.exec(pane);
    if (dead && dead[1] !== "0") {
      const detail = pane.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" | ");
      cancelLogin(cfg);
      const error = `the sign-in command failed (exit ${dead[1]}): ${detail}`;
      login = { ...idleState(), phase: "error", error };
      logger.error({ exit: dead[1], detail }, "dashboard login could not start");
      return { ok: false, error };
    }
  }

  cancelLogin(cfg);
  login = { ...idleState(), phase: "error", error: "timed out waiting for the sign-in URL" };
  return { ok: false, error: "timed out waiting for the sign-in URL" };
}

/** Codes are pasted by a human; keep it to plausible OAuth code characters and never echo it back. */
const CODE_RE = /^[A-Za-z0-9._~#\-/+=]{8,512}$/;

/**
 * Type the pasted code into the waiting prompt and wait for the credential to actually change.
 *
 * Success is decided by the CREDENTIAL FILE (mtime + a future expiresAt), not by scraping the pane for
 * a success string: the file changing is the thing that actually matters to the agents, and it does not
 * depend on CLI copy that could change between versions. Pane text is only consulted to surface a
 * useful error message on failure.
 */
export async function submitCode(
  cfg: EngineConfig,
  code: string,
): Promise<{ ok: boolean; error?: string; credential?: CredentialState }> {
  const socket = cfg.tmux.socket;
  const trimmed = (code ?? "").trim();

  if (!login.active || login.phase !== "awaiting-code") {
    return { ok: false, error: "no sign-in is waiting for a code — start one first" };
  }
  if (!CODE_RE.test(trimmed)) {
    return { ok: false, error: "that doesn't look like a valid code — copy the WHOLE code from the browser" };
  }
  if (!hasSession(socket, LOGIN_SESSION)) {
    login = { ...idleState(), phase: "error", error: "sign-in session disappeared" };
    return { ok: false, error: "the sign-in session expired — start again" };
  }

  login = { ...login, phase: "verifying" };
  const baseline = login.baselineMtime;

  // -l sends the code literally (no key interpretation); Enter is a SEPARATE send-keys because a
  // combined text+Enter is the known way to leave text parked unsubmitted in a TUI input box.
  sendText(socket, LOGIN_SESSION, trimmed);
  await sleep(150);
  sendKey(socket, LOGIN_SESSION, "Enter");

  for (let i = 0; i < 50; i++) {
    await sleep(400);
    const cred = readCredentialState();
    if (cred.present && !cred.expired && cred.mtime > baseline) {
      login = { ...idleState(), phase: "success" };
      killSession(socket, LOGIN_SESSION);
      logger.warn({ expiresAt: cred.expiresAt }, "dashboard login SUCCEEDED — credential renewed");
      return { ok: true, credential: cred };
    }
    const pane = captureLoginPane(socket);
    if (/Invalid code|failed|error/i.test(pane.slice(-400))) {
      const err = /Invalid code[^\n]*/i.exec(pane)?.[0] ?? "the code was rejected";
      login = { ...idleState(), phase: "error", error: err };
      killSession(socket, LOGIN_SESSION);
      return { ok: false, error: `${err} — start sign-in again to get a fresh link` };
    }
  }

  login = { ...idleState(), phase: "error", error: "timed out verifying the code" };
  killSession(socket, LOGIN_SESSION);
  return { ok: false, error: "timed out verifying the code — start sign-in again" };
}

/** Tear down any in-flight login session. Safe to call when nothing is running. */
export function cancelLogin(cfg: EngineConfig): void {
  try {
    if (hasSession(cfg.tmux.socket, LOGIN_SESSION)) killSession(cfg.tmux.socket, LOGIN_SESSION);
  } catch {
    /* best effort */
  }
  login = idleState();
}

/**
 * Relaunch panes so they re-read the credential. `all` restarts every enabled Claude agent; otherwise
 * only the ones currently showing a signed-out banner (or missing a session) are touched, so a healthy
 * agent mid-task is never interrupted for nothing.
 */
export function restartSignedOutAgents(cfg: EngineConfig, opts: { all?: boolean } = {}): { restarted: string[]; failed: string[] } {
  const states = scanAgentAuth(cfg);
  const wanted = new Set(
    opts.all === true
      ? states.map((s) => s.id)
      : states.filter((s) => s.signedOut || s.noSession).map((s) => s.id),
  );

  const restarted: string[] = [];
  const failed: string[] = [];
  for (const agent of loadAgents(cfg).filter((a) => a.enabled && wanted.has(a.id))) {
    try {
      killSession(cfg.tmux.socket, sessionNameFor(agent.id));
      launchAgent(cfg, agent);
      restarted.push(agent.id);
    } catch (err) {
      logger.error({ err, agent: agent.id }, "auth-restart: relaunch failed");
      failed.push(agent.id);
    }
  }
  logger.warn({ restarted, failed }, "auth-restart complete");
  return { restarted, failed };
}
