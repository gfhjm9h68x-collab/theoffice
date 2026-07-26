import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreOwnerSettings } from "./claude-settings.js";

let home = "";
let realHome: string | undefined;
const settingsPath = () => join(home, ".claude", "settings.json");

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "office-settings-"));
  mkdirSync(join(home, ".claude"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("restoreOwnerSettings", () => {
  it("puts back the canonical effort the injection overwrote, leaving other keys alone", async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ theme: "dark", effortLevel: "xhigh", model: "claude-sonnet-5" }),
    );
    await restoreOwnerSettings({ effortLevel: "high" });
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.effortLevel).toBe("high");
    expect(after.theme).toBe("dark"); // untouched
    expect(after.model).toBeUndefined(); // canonical has no model -> key removed
  });

  it("is a no-op when there is no settings file, instead of creating one", async () => {
    rmSync(settingsPath(), { force: true });
    await restoreOwnerSettings({ effortLevel: "high" });
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("survives a corrupt settings file without throwing", async () => {
    writeFileSync(settingsPath(), "{not json");
    await expect(restoreOwnerSettings({ effortLevel: "high" })).resolves.toBeUndefined();
  });

  it("serializes concurrent restores so two agents switching at once can't interleave writes", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ effortLevel: "xhigh", theme: "dark" }));
    await Promise.all([
      restoreOwnerSettings({ effortLevel: "high" }),
      restoreOwnerSettings({ effortLevel: "high" }),
      restoreOwnerSettings({ effortLevel: "high" }),
    ]);
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.effortLevel).toBe("high");
    expect(after.theme).toBe("dark");
  });
});
