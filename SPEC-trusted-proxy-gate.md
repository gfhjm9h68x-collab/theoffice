# Spec — #6 trusted-proxy gate (IP-spoof hardening)

## Problem
`getClientIp(req)` honors `X-Real-IP` then the last hop of `X-Forwarded-For` UNCONDITIONALLY. Those headers
are only trustworthy when set by OUR reverse proxy (NPM/nginx). A client hitting the dashboard port directly
(not via the proxy) can FORGE `X-Real-IP` to:
- evade the per-IP rate limiter (rotate fake IPs → never get blocked), or
- frame a chosen IP (get a victim address blocked).
Today this is low-risk (the port is localhost/LAN behind the proxy) which is why it was deferred — but it is
real and cheap to close.

## Fix (opt-in, shared-secret gate)
Add an OPTIONAL trusted-proxy token. The real proxy is configured to send a secret header
`X-Proxy-Token: <token>` on every request. `getClientIp` only honors `X-Real-IP`/`X-Forwarded-For` when that
header is present AND matches the configured token (constant-time compare). Otherwise it uses the true peer
`req.socket.remoteAddress`. When NO token is configured, behavior is UNCHANGED (backward compatible).

- Config: `web.trustedProxyToken?: string` (default undefined). Env override `OFFICE_TRUSTED_PROXY_TOKEN`
  (through numEnv-style string handling — non-empty string only).
- `getClientIp(req, trustedProxyToken?)` — token threaded from cfg at the call site.
- Constant-time compare (avoid a timing oracle on the token).

## Behavior table
| token configured | X-Proxy-Token header | result |
|---|---|---|
| no  | (any)            | honor X-Real-IP/XFF (current behavior — backward compat) |
| yes | matches token    | honor X-Real-IP/XFF |
| yes | missing/wrong    | IGNORE forwarded headers → use socket.remoteAddress |

## Out of scope
IP-allowlist trust-by-source (an alternative); we use the token per the audit note ("256-bit token").

## Tests (TDD, red first)
1. token set + NO proxy-token header + spoofed X-Real-IP → returns socket addr (NOT the spoof). [the hardening]
2. token set + correct proxy-token header → honors X-Real-IP.
3. token set + WRONG proxy-token → socket addr.
4. NO token configured → honors X-Real-IP (backward compat).
5. token set + correct header, X-Real-IP absent → honors XFF last hop.
6. constant-time compare used (wrong-length token still rejected, no throw).
