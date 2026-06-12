# ADR-0038: Shared proxy- and custom-CA-aware outbound HTTP egress

## Status

Accepted (retroactive record, 2026-06-12). Documents the platform seam requested by issue #802,
implemented in `packages/keiko-model-gateway/src/http.ts` (`gatewayFetch`) and hardened by the
production-readiness pass on branch `feature/figma-snapshot-extraction-production-ready`.

## Context

Enterprise customers run Keiko behind corporate firewalls: all outbound HTTP(S) must traverse a
forward proxy, frequently with TLS interception (a private corporate CA). Node's `fetch`
(undici) honours neither `HTTPS_PROXY` nor the operating-system trust store, so both the model
gateway and the Figma connector (Epic #750) failed in exactly the environments the product
targets — the 0.2.0-beta audit reproduced this as user finding #884. Connectors must keep a
single-credential posture: the proxy layer may not introduce additional secrets.

## Decision

1. **One shared egress function.** `gatewayFetch(url, options)` is the single outbound HTTP
   entrypoint for the model gateway and the Figma transport ports. Options carry
   `egress: OutboundHttpEgressConfig` (`httpProxy`, `httpsProxy`, `noProxy`, `caBundlePath`),
   `timeoutMs` and `maxResponseBytes`.
2. **Configuration.** The gateway config file accepts a top-level `egress` block; environment
   variables override per field with `KEIKO_*` precedence over the standard names
   (`KEIKO_HTTPS_PROXY` > `HTTPS_PROXY` > `https_proxy`, same for HTTP/NO_PROXY, plus
   `KEIKO_CA_BUNDLE_PATH`). The four fields parse INDEPENDENTLY and fail closed: one malformed
   variable is warned about by NAME (values are never logged) and does not discard the others —
   a typo cannot silently bypass a mandated corporate proxy.
3. **Trust composition.** Trusted CAs = Node bundled roots ∪ OS trust store
   (`tls.getCACertificates("system")` — macOS keychain) ∪ `NODE_EXTRA_CA_CERTS` ∪
   `caBundlePath`. On a TLS trust failure of the direct path, `gatewayFetch` retries once via a
   `node:https` fallback carrying that composed CA set; in many corporate-CA environments the
   system trust store alone suffices with zero configuration. An unreadable configured bundle
   warns once instead of silently degrading.
4. **Proxy semantics.** HTTPS targets tunnel via CONNECT (with connect/header timeouts mapping to
   `PROXY_UNREACHABLE`); the in-tunnel request sends a default-port-free `Host` header so
   pre-signed (SigV4) URLs survive proxying. `NO_PROXY` supports `*`, exact host, `.suffix` and
   `host:port` rules. Proxy URLs must not embed credentials (`PROXY_AUTH_REQUIRED` at use time);
   proxy auth, if ever needed, will be a separate explicit secret — not a URL userinfo field.
5. **Coded, attributable failures.** The egress layer throws `OutboundHttpEgressError` with codes
   `PROXY_UNREACHABLE`, `PROXY_AUTH_REQUIRED`, `PROXY_BLOCKED_BY_POLICY`, `PROXY_EGRESS_FAILED`,
   `TLS_CA_FAILURE` — thrown ONLY on the proxy/CA paths. Connector-tier classifiers (e.g.
   `classifyFigmaTransportError`) map proxy codes to proxy-attributed errors exclusively via this
   error type; direct-path network failures map to neutral codes
   (`FIGMA_NETWORK_UNREACHABLE`, `FIGMA_EGRESS_TIMEOUT`, `FIGMA_EGRESS_FAILED`). This fixes the
   #884 misattribution where a no-proxy runtime reported "the forward proxy rejected the
   request".

## Consequences

- The Figma connector reaches Figma through a firewall with exactly one key (the PAT) and no
  bespoke proxy layer of its own (#802 acceptance criteria).
- Egress failures are operator-actionable: the UI renders per-family remediation (proxy wording
  only for `FIGMA_PROXY_*`, CA-bundle wording for TLS, neutral wording for direct failures).
- No silent hangs: every path (direct, CA-fallback, CONNECT, in-tunnel) honours `timeoutMs`;
  response bodies are size-capped on the streamed paths and at the connector ports.
- Residual scope: streaming SSE through the CONNECT tunnel inherits the same byte cap as the
  buffered path; proxy authentication remains intentionally unsupported until a concrete
  customer requirement defines its secret-handling story.
