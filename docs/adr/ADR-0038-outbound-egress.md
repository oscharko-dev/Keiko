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
6. **Proxied DNS pinning is opt-in (`egress.pinProxiedConnectTarget`), because the default posture
   cannot honestly claim it for every deployment.** `gatewayFetch` already resolves and vets a
   target's DNS itself and pins the actual connect to the validated address set on the direct
   (unproxied) path (AUDIT-SEC-001) — so a hostname that only looks safe as a literal string but
   *resolves* to a blocked address (a private/loopback/metadata range) is still refused, not just
   one that is blocked by its literal shape. Through a proxy, `gatewayFetch` cannot make that same
   guarantee by default: the proxy resolves the target hostname independently at its own CONNECT
   (or forwarded-request) time, so a lookup Keiko performs beforehand validates an address set that
   is never bound to use — a hostile or hijacked name can resolve to a public address for Keiko's
   own check and rebind to a blocked one for the proxy's connect a moment later. Pre-resolving DNS
   and trusting that lookup as protection would be a guarantee the code cannot keep, so by default
   the DNS-level check is skipped entirely when a proxy is configured (the literal-shape check in
   `outboundTargetBlockedReason` still always runs). Two fixes that look obvious were rejected: a
   plain pre-proxy lookup is the exact TOCTOU gap just described, not a fix for it; and refusing
   every proxied request outright breaks first-class, common proxied deployments (Atlassian per
   ADR-0128 D3, and the model gateway itself) that have nothing to do with the gap. Instead,
   `egress.pinProxiedConnectTarget` (off by default, never config-file/env-mapped — a caller must
   construct it explicitly, exactly like `denyLoopback`) makes `gatewayFetch` resolve and vet the
   target itself, the same way it already does for the direct path, and then hand the *vetted
   address* — not the hostname — to the proxy layer: the CONNECT tunnel's authority for an HTTPS
   target, or the forwarded absolute-URI's host for a plain-HTTP target. The proxy has nothing left
   to resolve, so there is no second, independent resolution to rebind. TLS server-name identity
   (SNI) and the `Host` header both still carry the real hostname regardless, so certificate
   validation and virtual-hosting on the origin are unaffected — only the wire-level dial target
   changes. Resolution returning no usable address fails closed (`PROXY_BLOCKED_BY_POLICY`) rather
   than silently falling back to an unpinned connect.
   **Correction (#3156, 2026-08-15).** `pinProxiedConnectTarget` does not itself permit or deny any
   address class, and it never lifts loopback (or any other) denial. Whether a resolved address is
   blocked stays entirely governed by that class's own flag — `denyLoopback`, `allowPrivateNetwork`,
   `allowLinkLocalAndMetadata` — evaluated by the same `outboundAddressBlockedReason` check the
   direct path already uses, once pinning makes that evaluation reachable at all on the proxied
   path. What pinning actually changes is narrower: `refuseUnpinnableResearchEgress` blanket-refuses
   an entire request pre-flight whenever it is proxied, unpinned, and `denyLoopback` is set — a
   fail-safe that exists only because, without pinning, Keiko cannot vet what the proxy will
   actually connect to, so it refuses outright rather than risk a silent bypass. Enabling
   `pinProxiedConnectTarget` removes the precondition for that blanket pre-flight refusal (Keiko can
   now vet the resolved address itself), so the request is no longer refused outright — but a
   loopback-resolving hostname with `denyLoopback: true` still set is still refused, now via the
   same granular, resolved-address policy check the direct path uses instead of an exemption from
   it. The two flags are meant to be set together: `pinProxiedConnectTarget` alone, without
   `denyLoopback`, resolves and pins the address but still permits loopback through (loopback is the
   one target class that defaults to allowed absent an explicit `denyLoopback: true` — every other
   class defaults to blocked); `denyLoopback` alone, proxied and left unpinned, hits the blanket
   pre-flight refusal above rather than being vetted per request. An earlier version of this
   paragraph read as "enabling the flag lifts the denyLoopback refusal," which two independent
   reviewers correctly read as a possible bypass; it was imprecise about *which* refusal — the
   blanket pre-flight one, not the per-address policy denial — and is corrected here.
   **Correction (#3156, 2026-08-15), pool identity.** The vetting guarantee above only holds if a
   vetted connection is never handed to a call other than the one that vetted it.
   `fetchHttpsViaProxy`'s CONNECT-tunnel pool (`idleHttpsProxyTunnels`, a short-lived, same-process
   keep-alive cache keyed by `httpsProxyTunnelKey`) reuses an already-established tunnel verbatim,
   including whatever peer it actually connected to, for up to
   `HTTPS_PROXY_TUNNEL_IDLE_TTL_MS` (30s).
   *Before this fix*, the key identified a pooled entry by `(proxy, target, ca)` alone, so an
   unpinned call and a pinned call to the identical triple computed the same key and could share
   one pooled tunnel: a pinned call could silently be served an earlier unpinned call's tunnel,
   whose peer the proxy chose entirely on its own — the pinning mechanism's own vetting never
   touched it, making the guarantee above hold for the call that *created* a tunnel but not
   necessarily for the call that *reused* it.
   *As implemented today* (verify directly against `httpsProxyTunnelKey` in `http.ts` rather than
   trusting this paragraph — it is pinned by the `"never serves a pinned request the pooled
   tunnel…"` test in `http.test.ts`), the key also carries the calling request's pinning posture
   (`"unpinned"`, or a digest of the exact vetted address when pinned — see the #3157 addendum
   below for why a digest rather than the literal address), so a pinned and an unpinned call — or
   two pinned calls that resolved to different addresses — can never be served from each other's
   pool entry.
   **Addendum (#3157, 2026-08-15), CA-set collision and address legibility.** Two Keiko for Quality
   findings examined this same key. One claimed the key was still `(proxy, target, ca)` only, with
   no pinning term at all — that describes the state *before* the pool-identity fix directly above
   and does not apply to the code as it exists now (the same confirmation applies: check
   `httpsProxyTunnelKey` and the pinning-posture test directly rather than this paragraph). The
   other was a real, separate defect the first finding's proximity had obscured: the CA term was
   `${cert.length}:${cert.slice(0, 32)}` per certificate — for PEM input that summary is almost
   entirely the shared `-----BEGIN CERTIFICATE-----` header, so two CA bundles that are
   byte-for-byte different but share one certificate's length routinely produced the identical
   summary (confirmed directly: two 1150-byte test certificates differing only after byte 32
   collided). A call that deliberately tightened or changed its trusted roots could then be served
   an idle tunnel authenticated under an earlier, unrelated call's trust set — the same class of
   defect as the pinning-posture gap above, one field over. Both the CA term and the pinned-address
   term are now collision-resistant SHA-256 digests rather than summaries or literals: the CA set
   is sorted first (so the same set in a different array order still hashes identically — order
   carries no trust meaning) and hashed in full, and the vetted address is hashed too, even though
   grepping confirmed it never surfaces as raw content outside this in-memory `Map` today (no log
   or thrown message references `tunnelKey`/`caKey`/`pinKey`; `httpsProxyTunnelKey` itself is
   exported, but only for direct unit testing — see the next correction — and its return value is
   these same digests, never the raw address or certificate bytes) — a digest costs nothing and
   permanently forecloses that mattering if a future diagnostic ever taps this key.
   **Correction (#3157, 2026-08-15), sort comparator locale-sensitivity.** The CA-set sort above,
   added to satisfy SonarJS S2871 (which requires an explicit comparator rather than default
   sort's coercion-based one), initially used `(a, b) => a.localeCompare(b)`. Two further Keiko for
   Quality findings caught that this reintroduced exactly the environment-dependence the digest
   exists to avoid: `localeCompare`'s result depends on the runtime's collation (locale, ICU data
   version), so the identical CA set could sort — and therefore hash — differently on two
   differently-configured hosts, or on the same host across an ICU upgrade. A pool key exists to
   make identical configurations match each other; a locale-sensitive comparator can silently stop
   that from happening for an affected configuration, dropping its pool hit rate to zero (wasted
   reconnects under load, not a security break — a missed pool hit only means a fresh, still
   correctly vetted tunnel, never an unvetted one). Replaced with `codeUnitCompare`, a plain
   UTF-16 code-unit comparator written with if-statements rather than a nested ternary (SonarJS
   S3358 flags those separately — satisfying one rule should not trip another): total, stable, and
   dependent on nothing but the two strings' own code units — no ICU, no locale, no `Intl` — while
   still satisfying S2871's actual requirement (a well-defined order) rather than merely its
   literal one (any explicit function). Pinned directly rather than only through `gatewayFetch`:
   `httpsProxyTunnelKey` is
   exported and unit-tested for order-insensitivity (the same CA set in different array orders
   must produce the same key), because the one real caller, `gatewayTrustedCaCertificates`, always
   assembles its array in a fixed sequence and so never itself exercises a reordering — the
   invariant belongs to the function, not to any one caller's incidental behavior.
   **Correction (#3156, 2026-08-15), plain-HTTP path fact-check.** This paragraph previously claimed
   the plain-HTTP absolute-URI proxy path (`fetchHttpViaProxy`) has no equivalent pool because
   Node's default global agent opens an unshared connection per call. Codex P2 caught that this is
   false on this repository's pinned Node (verified directly, not from memory: on the pinned
   24.18.0, `http.globalAgent.keepAlive` and `https.globalAgent.keepAlive` are both `true` — Node
   made the global singleton agents specifically default to keep-alive; a `new Agent()` a caller
   constructs explicitly still defaults to `false`, which is the easy way to misremember this).
   `fetchHttpViaProxy` passes no explicit `agent`, so it runs on that keep-alive-by-default global
   agent, and connection reuse to the proxy does happen. The conclusion — no matching gap — survives
   anyway, for a different reason: Node's `Agent.getName()` pooling key is `host:port:localAddress`
   only (verified directly: identical for two requests to the same proxy that differ solely in
   `path`), so what gets reused is the transport hop to the proxy, never the ultimate destination.
   Each request's real target lives entirely in that request's own absolute-URI
   (`proxyRequestTarget(target, pinnedAddress)`, computed fresh inside `fetchHttpViaProxy` from that
   call's own `pinnedAddress`, never cached or carried over from an earlier call), which the proxy
   reads and routes independently on every request it receives — unlike a CONNECT tunnel, reusing
   the hop to an already-trusted intermediary does not fix the ultimate peer, so there is nothing
   here for `resolveGatewayDns`'s per-call vetting to lose track of. A dedicated test now asserts
   this directly: one physical connection serves both an unpinned and a pinned call to the same
   proxy, and the second request line still carries only its own call's target.

## Consequences

- The Figma connector reaches Figma through a firewall with exactly one key (the PAT) and no
  bespoke proxy layer of its own (#802 acceptance criteria).
- Egress failures are operator-actionable: the UI renders per-family remediation (proxy wording
  only for `FIGMA_PROXY_*`, CA-bundle wording for TLS, neutral wording for direct failures).
- No silent hangs: every path (direct, CA-fallback, CONNECT, in-tunnel) honours `timeoutMs`;
  response bodies are size-capped on the streamed paths and at the connector ports.
- Residual scope: streaming SSE through the CONNECT tunnel inherits the same byte cap as the
  buffered path; proxy authentication remains intentionally unsupported until a concrete
  customer requirement defines its secret-handling story. Without a caller explicitly setting
  D6's opt-in `pinProxiedConnectTarget` (paired with `denyLoopback`), a proxied request's
  DNS-resolved address is still not vetted by Keiko — this is the accepted default posture for a
  generic `gatewayFetch` caller, not an oversight, because a corporate proxy that filters
  CONNECT/forwarded requests by hostname (a legitimate, common pattern) would see an IP-literal
  target instead of a hostname and could reject it; an operator must confirm their proxy
  tolerates that before opting in.
  **Correction (#3156, 2026-08-15).** The Atlassian connector lane (ADR-0128 D3) now sets both
  flags by default: a DNS name that only resolves into loopback/private/link-local/metadata space
  after an operator has already configured it is a confirmed, silent SSRF and
  internal-reconnaissance path, and that risk outweighs the hostname-filtering-proxy compatibility
  concern for a lane whose target is a single, operator-configured host to begin with. No other v1
  caller defaults either flag on — that remains a separate, caller-specific call this record does
  not make on their behalf.
