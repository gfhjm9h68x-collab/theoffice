import { describe, it, expect } from "vitest";
import {
  parseManifest,
  detectPendingNotices,
  shouldNotify,
  renderOffer,
  hashNotice,
} from "./setup-notices.js";

const MANIFEST = `---
capability: watchd
installed-check: systemctl --user is-active watchd.service
install: tools/watchd/install.sh
---
watchd is a trigger service: register "wake me when X" and release your session
instead of sitting in a poll loop. Run its installer to enable it.`;

describe("parseManifest", () => {
  it("extracts front-matter + body", () => {
    const m = parseManifest(MANIFEST)!;
    expect(m.capability).toBe("watchd");
    expect(m.installedCheck).toBe("systemctl --user is-active watchd.service");
    expect(m.install).toBe("tools/watchd/install.sh");
    expect(m.notice).toContain("trigger service");
  });
  it("returns null when capability is missing", () => {
    expect(parseManifest("---\ninstall: x\n---\nbody")).toBeNull();
  });
});

describe("detectPendingNotices — generic across capabilities", () => {
  const files = [
    "tools/watchd/POST_UPDATE.md",
    "tools/backupd/POST_UPDATE.md",
    "src/index.ts", // ignored — not a manifest
    "tools/watchd/watchd.py", // ignored
  ];
  const manifest = (cap: string) =>
    `---\ncapability: ${cap}\ninstalled-check: is-active ${cap}\ninstall: tools/${cap}/install.sh\n---\nset up ${cap}`;
  const readFile = (p: string) =>
    p.endsWith("POST_UPDATE.md") ? manifest(p.split("/")[1]) : null;

  it("emits one pending notice per changed manifest whose capability is NOT installed", () => {
    const isInstalled = () => false; // neither installed
    const pending = detectPendingNotices(files, readFile, isInstalled, 1000);
    expect(pending.map((p) => p.capability).sort()).toEqual(["backupd", "watchd"]);
    expect(pending.every((p) => p.installCmd.startsWith("tools/"))).toBe(true);
  });

  it("skips a capability that is already installed (installed-check side-effect-free)", () => {
    const isInstalled = (check: string) => check.includes("watchd"); // watchd already up
    const pending = detectPendingNotices(files, readFile, isInstalled, 1000);
    expect(pending.map((p) => p.capability)).toEqual(["backupd"]);
  });

  it("ignores non-manifest changed files", () => {
    const pending = detectPendingNotices(["src/index.ts", "tools/x/x.py"], readFile, () => false, 1);
    expect(pending).toEqual([]);
  });
});

describe("shouldNotify — once-only + dismissible marker", () => {
  const HASH = "abc123";
  it("notifies when there is no marker yet", () => {
    expect(shouldNotify(undefined, HASH)).toBe(true);
  });
  it("does NOT re-notify once notified at the same hash", () => {
    expect(shouldNotify({ notice_hash: HASH, state: "notified", at: 1 }, HASH)).toBe(false);
  });
  it("does NOT notify a dismissed capability at the same hash", () => {
    expect(shouldNotify({ notice_hash: HASH, state: "dismissed", at: 1 }, HASH)).toBe(false);
  });
  it("does NOT notify an installed capability at the same hash", () => {
    expect(shouldNotify({ notice_hash: HASH, state: "installed", at: 1 }, HASH)).toBe(false);
  });
  it("RE-notifies exactly once when a genuinely new notice arrives (hash changed)", () => {
    expect(shouldNotify({ notice_hash: HASH, state: "dismissed", at: 1 }, "newhash")).toBe(true);
  });
});

describe("renderOffer — offer-first, no office-say foot-gun", () => {
  const p = { capability: "watchd", noticeHash: "h", noticeText: "does cool things", installCmd: "tools/watchd/install.sh" };
  it("is offer-first (asks, does not auto-install) and names the install command", () => {
    const s = renderOffer(p);
    expect(s.toLowerCase()).toContain("want me to set it up");
    expect(s).toContain("tools/watchd/install.sh");
    expect(s).toContain("watchd");
  });
  it("contains NO backticks (they blank office-say via command substitution)", () => {
    expect(renderOffer(p)).not.toContain("`");
  });
});

describe("hashNotice", () => {
  it("is stable and content-sensitive", () => {
    expect(hashNotice("a")).toBe(hashNotice("a"));
    expect(hashNotice("a")).not.toBe(hashNotice("b"));
  });
});
