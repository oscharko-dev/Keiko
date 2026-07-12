# Governed Feedback Intake Reuse Analysis

## Scope and conclusion

This review maps Epic #2070 to the current `dev` architecture before implementation. The proposed
flow should reuse Keiko's deterministic redaction, text-safety, hashing, outbound egress, local
request guards, content-free evidence conventions, and narrow provider-adapter patterns. It still
has real capability gaps: Keiko has no remote anonymous intake service, remote maintainer identity,
multi-user review queue, abuse limiter, feedback retention store, or GitHub App issue adapter.

Those gaps require a separately deployed service. They do not justify turning the loopback BFF into
a hosted listener, duplicating Keiko's local workspace/evidence/memory systems, or widening the
governed pull-request gateway. The normative outcomes are in the [privacy contract](privacy-contract.md),
[threat model](threat-model.md), and
[ADR-0134](../adr/ADR-0134-governed-feedback-intake.md).

The hosted maintainer HTML cannot import the local product `globals.css` across this deployment boundary.
Its package therefore emits byte-for-byte copies of the canonical Design System token artifacts
`design-system/keiko-tokens.css` and `design-system/keiko-semantic-tokens.css`. This is a deployment adapter,
not a fork: canonical ownership remains in `design-system/`, the copy step adds no values or namespace, and a
focused byte-sync test fails if either emitted file drifts. The hosted component stylesheet consumes only the
existing semantic/component tokens.

## Capability map

| Existing capability                            | Evidence                                                                                                                                                                                                                                                                                                                                                                             | Decision                                                                                                                                                                                                                                          | Constraint or required extension                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret and literal redaction                   | [`keiko-security/redaction.ts`](../../packages/keiko-security/src/redaction.ts) provides `redact`, `createAuditRedactor`, and `deepRedactStrings`.                                                                                                                                                                                                                                   | **Reuse for proven complete spans.** Preserve its markers/counting where boundaries are exact; do not use a partial match to dispose ambiguous credential-like input.                                                                             | Generalize shared detection only where necessary, then route ambiguity to the feedback disposition layer. It is not a semantic customer-data classifier. Wire provenance remains engine version plus rule-code/count pairs only.                                                                                                             |
| Text-safety and path handling                  | [`keiko-contracts/text-safety.ts`](../../packages/keiko-contracts/src/text-safety.ts) identifies/removes unsafe controls/bidi characters and redacts absolute paths.                                                                                                                                                                                                                 | **Reuse as validation and redaction primitives.** Normalize CRLF/CR, require `stripUnsafeFormatChars(value) === value` to reject unsafe text, then apply path/secret redaction to every string, including browser description.                    | Feedback admits only TAB/LF controls after normalization and must reject NUL, other C0, DEL/C1, invalid scalars, and unsafe format characters rather than silently accepting a stripped value. Do not add a second Unicode/path regex family.                                                                                                |
| Capture safety and secret scanning             | [`capture-safety.ts`](../../packages/keiko-memory-capture/src/capture-safety.ts) and its secret scanner reject known secret/customer-identifier patterns.                                                                                                                                                                                                                            | **Reuse selectively / generalize detection only.** Extract a generic leaf detector with parity tests if feedback needs it; let feedback own the disposition decision.                                                                             | Do not import memory sensitivity/proposal/approval semantics or copy scanner grammars. A local ambiguous hit quarantines the smallest safe unit. A hosted residual hit rejects drift rather than silently changing previewed bytes.                                                                                                          |
| Deterministic canonical JSON and SHA-256       | [`keiko-security/hashing.ts`](../../packages/keiko-security/src/hashing.ts) provides `canonicalise` and `sha256Hex`.                                                                                                                                                                                                                                                                 | **Reuse.** Canonicalize validated, sanitized JSON and use SHA-256 only for the exact preview/submit body integrity digest.                                                                                                                        | The local disposition sidecar is paired with the digest but excluded from canonical bytes. Semantic dedupe and abuse identities require separate domain-separated service HMAC keys; neither may use plain SHA-256 or the other's key.                                                                                                       |
| Proxy/custom-CA-aware outbound HTTP            | [`gatewayFetch`](../../packages/keiko-model-gateway/src/http.ts) implements the [ADR-0038](../adr/ADR-0038-outbound-egress.md) egress seam, including proxy/CA handling, DNS-rebinding protection, timeouts, and response caps.                                                                                                                                                      | **Reuse and wrap.** The local BFF uses it for submission.                                                                                                                                                                                         | `gatewayFetch` is transport, not feedback destination policy. Add a feedback-specific wrapper that accepts no caller URL and allows only the configured normalized HTTPS origin plus `POST /v1/feedback/reports`, omits credentials, and rejects every redirect. Unset/invalid configuration disables submission.                            |
| Loopback HTTP request guards                   | [`server.ts`](../../packages/keiko-server/src/server.ts), [`host-check.ts`](../../packages/keiko-server/src/host-check.ts), and [`routes.ts`](../../packages/keiko-server/src/routes.ts) enforce loopback Host/Origin, JSON, CSRF, typed routing, correlation ids, and safe errors.                                                                                                  | **Reuse unchanged for local feedback routes.** The browser talks only to the same-origin loopback BFF.                                                                                                                                            | These assumptions make `createUiServer` unsuitable as the hosted intake runtime. Do not add remote hosts to `LOOPBACK_HOSTS`, bind a public interface, exempt feedback from CSRF, or place anonymous/maintainer routes in the local registry. The hosted service needs its own external-edge and OIDC guards.                                |
| Content-free evidence and diagnostic redaction | [`keiko-evidence/redaction.ts`](../../packages/keiko-evidence/src/redaction.ts), [ADR-0022](../adr/ADR-0022-connected-context-privacy.md), and [`security-and-audit-boundaries.md`](../security-and-audit-boundaries.md) establish redacted/hash/count metadata patterns.                                                                                                            | **Reuse the minimization pattern.** Disposition records use closed codes and stable content-free targets; durable outcome evidence/audit stores only approved ids, digests, counts, enums, versions, times, and outcomes.                         | The recovery sidecar is local-memory-only and never evidence: no raw unit, excerpt, offset, path, filename, or user label. Never write report text or `receiptSecret` into durable UI/evidence/diagnostics; the returned capability is memory-only unless explicitly copied.                                                                 |
| Quality Intelligence review governance         | [`stateMachine.ts`](../../packages/keiko-quality-intelligence/src/review/stateMachine.ts), [`fourEyes.ts`](../../packages/keiko-quality-intelligence/src/review/fourEyes.ts), and [`reviewStore.ts`](../../packages/keiko-server/src/qualityIntelligence/reviewStore.ts) demonstrate pure fail-closed transitions, pairing rules, version/integrity patterns, and append-only audit. | **Reuse patterns, not types or storage.** Preserve immutable payloads, versioned dispositions, CAS writes, typed errors, and content-free audit. Issue #2075 defines the feedback-specific closed state/action table.                             | QI contracts are a different domain. Its [`reviewPrincipal.ts`](../../packages/keiko-server/src/qualityIntelligence/reviewPrincipal.ts) permits a local-operator fallback that is expressly forbidden in the hosted service. Feedback maintainer actors must come from validated OIDC and server-side RBAC.                                  |
| Governed GitHub provider adapter               | [ADR-0086](../adr/ADR-0086-governed-github-pull-request-gateway.md) and [`git-pr-gateway.ts`](../../packages/keiko-tools/src/git-pr-gateway.ts) establish narrow typed ports, closed method/endpoint allowlists, content-free evidence, classified failures, and fake-adapter tests.                                                                                                 | **Reuse the pattern only.** Add a dedicated hosted `GitHubIssueAdapter` with create plus narrowly bounded idempotency reconciliation. Generate the random reconciliation marker before approval and include it in the reviewed projection digest. | Do not widen `GitPullRequestAdapter`, `GitDeliveryActionKind`, its `gh api` allowlist, or local `GH_TOKEN` semantics. The hosted adapter uses a GitHub App private key and memory-only installation tokens, Issues read/write plus mandatory Metadata read only, server-configured repositories/labels, and no generic request escape hatch. |
| Public user-finding issue form                 | [`.github/ISSUE_TEMPLATE/user_finding.yml`](../../.github/ISSUE_TEMPLATE/user_finding.yml) defines the current public field ids and mandatory safety attestation.                                                                                                                                                                                                                    | **Reuse unchanged.** Compose a fixed form link using only known public ids and allowlisted query keys; cap the URL and provide copy/open-form fallback.                                                                                           | Never pre-check `safety`, populate maintainer-only fields, set labels/assignees/projects, select a user-controlled repository, or auto-submit. If GitHub does not honor a field prefill, fall back rather than inventing query keys.                                                                                                         |
| Private vulnerability process                  | [`SECURITY.md`](../../SECURITY.md) defines GitHub Security Advisories as the private route.                                                                                                                                                                                                                                                                                          | **Reuse as the only security-report destination.** Link it before report entry and on every security block.                                                                                                                                       | Do not copy vulnerability details into an intake/public URL, queue, telemetry, or ordinary issue. The deterministic indicator scan is a guardrail, not exhaustive semantic classification.                                                                                                                                                   |
| Native local file selection and containment    | [ADR-0118](../adr/ADR-0118-native-file-dialog-boundary.md) and existing local file boundaries provide reviewed selection/validation patterns.                                                                                                                                                                                                                                        | **Reuse the local selection boundary where applicable.** Read a bounded candidate locally, then admit only text satisfying the strict UTF-8 scalar/control/magic/size/raw-log predicate.                                                          | MIME/extension may reject but never prove safety. Feedback transmits final redacted text, not a file: no source bytes/name/path/metadata cross. Treat a passing byte sequence as text without claiming perfect binary-origin classification. Do not add a remote upload/parser subsystem.                                                    |

## Extend versus introduce

### Extend existing Keiko surfaces

- Add versioned, browser-safe report/provenance contracts and a typed preparation-result contract in
  the existing contracts layer. The canonical wire report keeps summary title and description as
  independently verified members, contains only sanitized fields and rule-code/count provenance,
  and retains the 4 KiB combined summary budget including the reserved two-LF display boundary. The
  paired local sidecar contains closed disposition/reason/unit-kind codes plus a source draft-field
  id or attachment ordinal, never source content or offsets. Keep IO, crypto, storage, and provider
  details out under
  [ADR-0019](../adr/ADR-0019-modular-package-architecture.md).
- Compose the report builder and detection/disposition engine in an existing Node-capable layer that
  may depend on contracts and security. Reuse exact-span redaction; add a bounded structural scanner
  only for the gap; do not duplicate redaction, text-safety, canonicalization, hashing, or credential
  grammars.
- Add loopback report-preview/submit coordination through the existing route registration and
  Host/Origin/JSON/CSRF/correlation envelope. The remote call remains behind the local BFF and fixed
  feedback egress wrapper.
- Add the in-app surface through existing desktop/design-system/i18n patterns. The preview shows the
  exact canonical semantic content plus local content-free redacted/quarantined/omitted notices.
  Draft-field ids focus the matching `title` or `description` member; attachment ordinals focus the
  snapshotted card. Render title then description while preserving their independently verified
  values. Recovery is edit/rescan, remove an optional unit, or continue with safe omission—never
  `send anyway`.
- Reuse the existing local evidence/diagnostic sinks only for content-free submission outcome
  metadata. The disposition sidecar, raw/quarantined units, and report text must not enter those
  sinks or become report queues/retry spools.

### Introduce only for proven gaps

- A separate operator-hosted intake runtime with an anonymous submit plane and independently guarded
  OIDC/RBAC maintainer plane. It has its own deployable entrypoint, configuration, database,
  migrations, retention/deletion workers, health/readiness, and operational runbook.
- A bounded redacted intake store whose payload is immutable and whose state/projections use
  versioned CAS. This store is not the Keiko local UI SQLite store, evidence ledger, memory vault,
  Local Knowledge graph, or Quality Intelligence review store.
- A trusted-proxy parser, rotating keyed-HMAC abuse identity, per-identity/global/concurrency
  limiting, separate 90-day rotating dedupe-HMAC key ring/index, exact receipt capability registry,
  uniform receipt failures, and bounded retry/dead-letter path.
- Server-validated OIDC/RBAC and a plain-text maintainer queue. Local environment/user fallbacks are
  invalid for a multi-user hosted trust boundary.
- A narrow GitHub App issue adapter with approval-bound target policy, transactional outbox,
  pre-approval marker-bound projection, idempotency reconciliation, short-lived token custody, and
  typed provider failures.

New code should remain small and ownership-specific. The feedback disposition layer is a bounded
policy adapter over shared detectors, not a second credential grammar or evidence system. A generic
telemetry platform, arbitrary webhook client, generalized remote-control service, binary artifact
service, second policy engine, or second evidence framework is outside the proven gaps.

## Surfaces to leave untouched

- Keiko's `127.0.0.1` bind, `LOOPBACK_HOSTS`, CSP same-origin posture, and `createUiServer` remote
  reachability assumptions.
- Model Gateway provider selection and SDK ownership. Feedback redaction/dedupe is deterministic and
  must not call a model or use model output as a privacy decision.
- Workspace containment, patch, command, model, workflow, memory, relationship, and Local Knowledge
  authority. A feedback report grants none of them.
- `QualityIntelligenceReview*` contracts, local QI principal fallback, and QI store schema.
- ADR-0086 PR contracts, adapters, endpoint allowlist, credential posture, action kinds, and evidence
  schema. The issue adapter is a sibling hosted boundary, not an extension.
- The `user_finding.yml` safety checkbox and maintainer-only field. Public-link composition consumes
  the current ids but does not weaken the form.
- `SECURITY.md` disclosure policy. Ordinary feedback cannot become an alternative vulnerability
  channel.

## Rejected reuse shortcuts

| Shortcut                                                      | Why it is rejected                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expose an ordinary `createUiServer` route as the intake API   | It converts a loopback, single-user, CSRF/Host-guarded BFF into a hosted multi-user service and invalidates the documented security boundary.                               |
| Let the browser call an arbitrary intake URL                  | It bypasses local same-origin mediation, corporate egress policy, exact destination allowlisting, and submit-time authority; it also creates a credential/CORS surface.     |
| Upload raw content and redact on the service                  | The user could not preview what crossed the network. Rejected bodies and raw content would become a new privacy/retention surface.                                          |
| Upload or paste raw logs                                      | The epic forbids raw logs. There is no raw-log field or automatic capture; recognized log signatures fail closed and only a handwritten sanitized summary is admitted.      |
| Treat existing redaction as a customer-data classifier        | Pattern redaction cannot recognize arbitrary business context or all personal/customer data. Human review and explicit limitations remain mandatory.                        |
| Extend a partial regex match across ambiguous credential text | It can retain a sensitive suffix or overmatch safe prose. Separate detection from disposition; redact only proven spans and quarantine the smallest structurally safe unit. |
| Persist or submit disposition records with the report         | Recovery targets are needed only by the local draft UI. Keep the content-free, digest-paired sidecar in memory and the canonical wire/public projection minimal.            |
| Use plain SHA-256 of IP for rate limiting                     | Address space is enumerable, making the digest reversible. Use a rotating keyed HMAC and never persist/log the raw address.                                                 |
| Use plain SHA-256 or the abuse key for semantic dedupe        | Low-entropy reports are enumerable and cross-purpose keys couple privacy domains. Use the separate 90-day rotating, domain-separated service HMAC ring.                     |
| Reuse the QI review types/database/principal                  | The lifecycle, identity, retention, payload, and deployment semantics differ; the local principal fallback is unsafe remotely. Reuse pure-state/audit design ideas only.    |
| Add issue creation to ADR-0086's PR adapter                   | It widens a deliberately PR-only action/endpoint/credential boundary and uses the wrong authentication model. Add a sibling issue-only GitHub App port.                     |
| Accept images, PDFs, archives, or generic multipart evidence  | It creates parsers, malware/content-sniffing risks, metadata leakage, and storage complexity that v1 does not need. Decode bounded UTF-8 text locally instead.              |
| Use a model to classify/redact reports                        | It would send sensitive input across another egress boundary and provide non-deterministic safety. No model call belongs in the privacy gate.                               |

## Child-by-child reuse obligations

| Issue | Must reuse                                                                                                            | New capability permitted                                                                                                       | Must remain unchanged                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| #2072 | Exact-span redaction, text-safety rejection, generalized leaf detectors, canonicalise/SHA-256, validation conventions | Versioned sanitized projection; local typed sidecar; bounded smallest-safe-unit disposition; false-positive/performance corpus | Memory/QI semantics; evidence bodies; binary parsers; duplicate scanner grammars |
| #2073 | Loopback guards, desktop/design-system/i18n, current issue form and `SECURITY.md`                                     | Exact preview plus notices; draft-target recovery; fixed public-link/copy from the safe projection                             | `send anyway`; CSP widening; safety auto-check; browser-direct egress            |
| #2074 | `gatewayFetch`, request/body caps, canonicalise/SHA-256, security crypto patterns                                     | Hosted validator; exact receipt routes; UTC abuse HMAC; separate dedupe HMAC ring; store/TTL workers                           | `createUiServer` remote boundary; local SQLite/evidence as queue                 |
| #2075 | Pure transition/CAS/audit patterns from QI                                                                            | Feedback-specific closed state/action table, OIDC/RBAC, immutable queue/inert UI, legal holds                                  | QI types/store/local principal fallback                                          |
| #2076 | ADR-0086 narrow-port/allowlist/fake-adapter patterns                                                                  | GitHub App issue adapter, configured target/labels, pre-approval marker, outbox/reconciliation                                 | PR gateway, git action taxonomy, local `gh` auth                                 |
| #2077 | Existing verification/receipt/release-evidence conventions                                                            | Integrated privacy/security/deletion/provider-permission proof                                                                 | Any gate, evidence-redaction, or human-review weakening                          |

Each implementation PR must state whether it reused, generalized, or introduced the listed surface
and link tests that prove the boundary. If a child needs a different owner package, destination,
credential model, attachment class, retention period, or GitHub permission, it must stop for an ADR
amendment rather than silently drifting from this map.

## Targeted verification map

- Unit tests: complete-span redaction; quoted/structured/unterminated-line quarantine; optional
  omission; required-empty rewrite; safe-remainder preservation; content-free draft/attachment
  targets; sidecar/body separation; idempotence; password-policy/reset negative fixtures; malformed
  separator/nesting storms and maximum-size linear time; canonical byte stability, provenance
  minimization, strict text gates, pre/post limits, exact-body SHA-256, and semantic dedupe projection.
- Local server tests: Host/Origin/JSON/CSRF enforcement, exact approved-buffer dispatch, disabled
  configuration, fixed origin/path, credential/query/fragment/wildcard rejection, and redirect
  denial with injected transport.
- Hosted service tests: independent sanitized-payload drift rejection without redisposition; no raw body/IP/receipt-secret logs;
  trusted-proxy chains; abuse bucket/key activation at 00:00 UTC, close at next 00:00, exact
  start+48-hour digest/count expiry, current/previous lookup, and destruction only after the last
  bucket expires; separate 90-day active-plus-two dedupe keys and non-refreshing 180-day entries;
  exact receipt POST/GET/auth, constant-time hash, uniform 404, coarse response, and one receipt per
  accepted duplicate; #2075 CAS table; OIDC/RBAC negatives; retention/legal holds; and backup
  deletion replay.
- GitHub adapter tests: permission/target/label fail-closed behavior, no generic endpoints, token
  non-persistence, 90-day private-key rotation, marker generation before review and inclusion in the
  approved projection digest, outbox uniqueness, response-loss reconciliation, and fake-adapter
  integration without live credentials.
- UI/e2e tests: exact preview/submit/public projection, redaction/quarantine/omission notices,
  draft-control/attachment-card focus, edit/rescan/remove/continue-safe-omission recovery, absent
  `send anyway`, vulnerability routing, receipt-secret memory-only handling, inert queue rendering,
  8 KiB URL fallback, no safety auto-check, and no issue creation before maintainer approval.
