import { describe, it, expect } from "vitest";
import { parseInbound, prepareInboundDelivery } from "./slack-ingest.js";

describe("prepareInboundDelivery (non-owner sender identity + routing safety)", () => {
  // SECURITY: a non-owner allowed contact (e.g. Hanga via allowFrom) must never be mistaken for the owner,
  // and a reply must always go to the actual sender — never to the owner's DM. (2026-06-20 orchid-cancel bug.)
  const base = "cancel the orchid watering task";
  const ownerName = "Szoszo";

  it("non-owner allowed sender: banner NAMES them, warns NOT-owner, reply routes to the SENDER", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_hanga", ownerId: "U_owner", ownerName, senderName: "Hanga",
    });
    expect(prompt).toContain("Hanga"); // names them
    expect(prompt).toContain("NOT your owner");
    expect(prompt).toContain(ownerName);
    expect(prompt).toMatch(/owner-only/i); // warns against owner-only authority
    expect(prompt.endsWith(base)).toBe(true); // original message preserved, after the banner
    expect(prompt).not.toBe(base);
    expect(replyUser).toBe("U_hanga"); // reply goes to the sender, NOT the owner
  });

  it("owner: NO banner, prompt unchanged, reply routes to owner", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_owner", ownerId: "U_owner", ownerName, senderName: ownerName,
    });
    expect(prompt).toBe(base); // owner flow unaffected
    expect(replyUser).toBe("U_owner");
  });

  it("no owner configured (setup mode): defaults to NON-owner (secure), still routes to sender", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_x", ownerId: undefined, ownerName, senderName: "X",
    });
    expect(prompt).toContain("NOT your owner"); // never silently grant owner authority
    expect(replyUser).toBe("U_x");
  });
});

describe("parseInbound", () => {
  const dm = { type: "message", channel_type: "im", channel: "D123", user: "U_owner", text: "hey Charly", ts: "1.1" };

  it("accepts a real DM", () => {
    expect(parseInbound(dm, "U_charly")).toEqual({ text: "hey Charly", channel: "D123", user: "U_owner", ts: "1.1", files: [] });
  });

  it("accepts a file upload (subtype file_share) with a caption", () => {
    const ev = {
      ...dm,
      subtype: "file_share",
      text: "look at this",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", url_private_download: "https://files.slack.com/F1/photo.png" }],
    };
    expect(parseInbound(ev, "U_charly")).toEqual({
      text: "look at this",
      channel: "D123",
      user: "U_owner",
      ts: "1.1",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/F1/photo.png" }],
    });
  });

  it("accepts a file upload with NO caption (empty text but files present)", () => {
    const ev = { ...dm, subtype: "file_share", text: "", files: [{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/F2/doc.pdf" }] };
    const out = parseInbound(ev, "U_charly");
    expect(out?.text).toBe("");
    expect(out?.files).toEqual([{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", urlPrivateDownload: "https://files.slack.com/F2/doc.pdf" }]);
  });

  it("rejects the agent's own echo", () => {
    expect(parseInbound({ ...dm, user: "U_charly" }, "U_charly")).toBeNull();
  });

  it("rejects bot messages", () => {
    expect(parseInbound({ ...dm, bot_id: "B1" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "bot_message" }, "U_charly")).toBeNull();
  });

  it("rejects edits / system subtypes", () => {
    expect(parseInbound({ ...dm, subtype: "message_changed" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "channel_join" }, "U_charly")).toBeNull();
  });

  it("rejects empty / non-message / malformed", () => {
    expect(parseInbound({ ...dm, text: "   " }, "U_charly")).toBeNull();
    expect(parseInbound({ type: "app_home_opened" }, "U_charly")).toBeNull();
    expect(parseInbound(null, "U_charly")).toBeNull();
    expect(parseInbound({ type: "message", text: "hi" }, "U_charly")).toBeNull(); // no channel/user/ts
  });

  it("trims text", () => {
    expect(parseInbound({ ...dm, text: "  spaced  " }, "U_charly")?.text).toBe("spaced");
  });
});
