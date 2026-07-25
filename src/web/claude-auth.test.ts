import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentialState, paneLooksSignedOut, extractOAuthUrl, formatDuration } from "./claude-auth.js";

const tmps: string[] = [];
function credFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-test-"));
  tmps.push(dir);
  const f = join(dir, ".credentials.json");
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("readCredentialState", () => {
  it("reports a live credential and never leaks token material", () => {
    const f = credFile({
      claudeAiOauth: {
        expiresAt: Date.now() + HOUR,
        refreshTokenExpiresAt: Date.now() + 29 * DAY,
        refreshToken: "rt-secret",
        accessToken: "at-secret",
      },
    });
    const s = readCredentialState(f);
    expect(s.present).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.refreshExpired).toBe(false);
    expect(s.hasRefreshToken).toBe(true);
    // the whole point of returning a shape instead of the object: no secret can reach the dashboard
    expect(JSON.stringify(s)).not.toContain("rt-secret");
    expect(JSON.stringify(s)).not.toContain("at-secret");
  });

  // The distinction that keeps this from becoming a nightly false alarm: the ACCESS token lapses
  // every ~8h by design and Claude Code renews it silently. Only the REFRESH token forces a login.
  it("an expired access token with a live refresh token is NOT a refresh-expiry", () => {
    const s = readCredentialState(
      credFile({
        claudeAiOauth: { expiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() + 20 * DAY, refreshToken: "x" },
      }),
    );
    expect(s.expired).toBe(true); // access token is stale...
    expect(s.refreshExpired).toBe(false); // ...but it can still renew itself: no alarm
    expect(s.refreshExpiringSoon).toBe(false);
  });

  it("flags an expired refresh token — the state that forces an interactive login", () => {
    const s = readCredentialState(
      credFile({
        claudeAiOauth: { expiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() - 1000, refreshToken: "x" },
      }),
    );
    expect(s.refreshExpired).toBe(true);
  });

  it("treats a missing refresh token as expired (nothing can renew)", () => {
    const s = readCredentialState(credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR } }));
    expect(s.hasRefreshToken).toBe(false);
    expect(s.refreshExpired).toBe(true);
  });

  it("warns only inside the refresh-expiry window, not on a fresh 30-day token", () => {
    const soon = readCredentialState(
      credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshTokenExpiresAt: Date.now() + 2 * DAY, refreshToken: "x" } }),
    );
    expect(soon.refreshExpiringSoon).toBe(true);
    const fresh = readCredentialState(
      credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshTokenExpiresAt: Date.now() + 29 * DAY, refreshToken: "x" } }),
    );
    expect(fresh.refreshExpiringSoon).toBe(false);
  });

  it("stays quiet when the refresh expiry field is absent (older credential shape)", () => {
    const s = readCredentialState(credFile({ claudeAiOauth: { expiresAt: Date.now() + HOUR, refreshToken: "x" } }));
    expect(s.refreshExpired).toBe(false);
    expect(s.refreshExpiringSoon).toBe(false);
  });

  it("treats a missing or unparseable file as absent rather than throwing", () => {
    expect(readCredentialState("/nope/does/not/exist.json").present).toBe(false);
    expect(readCredentialState(credFile("{ not json")).present).toBe(false);
    expect(readCredentialState(credFile({ somethingElse: true })).present).toBe(false);
  });
});

describe("paneLooksSignedOut", () => {
  // These are the exact banners observed during the 2026-07-25 outage.
  it("detects every signed-out banner Claude Code prints", () => {
    expect(paneLooksSignedOut("  ▘▘ ▝▝    Opus 4.8 · API Usage Billing\n   Not logged in · Run /login")).toBe(true);
    expect(paneLooksSignedOut("● Login expired · Please run /login")).toBe(true);
    expect(paneLooksSignedOut("API Error: 401 Invalid authentication credentials")).toBe(true);
  });

  it("does not fire on a healthy signed-in pane", () => {
    expect(paneLooksSignedOut(" ▐▛███▜▌   Claude Code v2.1.220\n▝▜█████▛▘  Opus 4.8 · Claude Max\n❯ Try \"edit types.ts\"")).toBe(false);
  });
});

describe("extractOAuthUrl", () => {
  const FULL =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=Sa_tEq&code_challenge_method=S256&state=xyz";

  it("pulls the authorize URL out of the login pane", () => {
    const pane = `Opening browser to sign in…
If the browser didn't open, visit: ${FULL}
Paste code here if prompted >`;
    expect(extractOAuthUrl(pane)).toBe(FULL);
  });

  it("re-joins a URL hard-wrapped across pane rows, stopping at the prose that follows", () => {
    const pane = `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code
_challenge=Sa_tEq&code_challenge_method=S256&state=xyz
Paste code here if prompted >`;
    expect(extractOAuthUrl(pane)).toBe(FULL);
  });

  it("refuses to return a TRUNCATED url — a dead link is worse than none", () => {
    // Missing code_challenge/state => not fully printed yet; caller must keep polling.
    const pane = "visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc";
    expect(extractOAuthUrl(pane)).toBeNull();
  });

  it("returns null when no URL is present yet", () => {
    expect(extractOAuthUrl("Opening browser to sign in…")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders human units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7200)).toBe("2.0 h");
    expect(formatDuration(4 * 86400)).toBe("4 d");
  });
});
