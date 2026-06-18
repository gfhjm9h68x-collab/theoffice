import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { getClientIp } from "./server.js";

// Minimal req stub: only the bits getClientIp reads.
const req = (headers: Record<string, string>, remoteAddress = "10.0.0.9"): IncomingMessage =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

const TOKEN = "s3cret-proxy-token-256bit";

describe("getClientIp — trusted-proxy gate (#6)", () => {
  it("token configured + NO proxy-token header: IGNORES a spoofed X-Real-IP, uses the real peer", () => {
    const r = req({ "x-real-ip": "1.2.3.4" }); // attacker-forged, no proxy token
    expect(getClientIp(r, TOKEN)).toBe("10.0.0.9"); // socket addr, NOT the spoof
  });

  it("token configured + correct proxy-token header: honors X-Real-IP", () => {
    const r = req({ "x-real-ip": "1.2.3.4", "x-proxy-token": TOKEN });
    expect(getClientIp(r, TOKEN)).toBe("1.2.3.4");
  });

  it("token configured + WRONG proxy-token: uses the real peer", () => {
    const r = req({ "x-real-ip": "1.2.3.4", "x-proxy-token": "wrong" });
    expect(getClientIp(r, TOKEN)).toBe("10.0.0.9");
  });

  it("NO token configured: honors X-Real-IP (backward compatible)", () => {
    const r = req({ "x-real-ip": "1.2.3.4" });
    expect(getClientIp(r)).toBe("1.2.3.4");
  });

  it("token configured + correct header, X-Real-IP absent: honors XFF last hop", () => {
    const r = req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4", "x-proxy-token": TOKEN });
    expect(getClientIp(r, TOKEN)).toBe("1.2.3.4");
  });

  it("token configured + a wrong-length token: rejected cleanly (constant-time compare, no throw)", () => {
    const r = req({ "x-real-ip": "1.2.3.4", "x-proxy-token": "x" });
    expect(getClientIp(r, TOKEN)).toBe("10.0.0.9");
  });
});
