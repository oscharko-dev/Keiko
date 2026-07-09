# Governed Feedback Intake Threat Model

## Scope

This threat model covers the Epic #2070 path from local report assembly through optional GitHub
Issue creation. It complements the normative [privacy contract](privacy-contract.md) and
[ADR-0125](../adr/ADR-0125-governed-feedback-intake.md). It does not turn the Keiko product into a
hosted service: the existing UI/BFF remains loopback-only, while intake is a separate
operator-deployed system.

Suspected vulnerabilities are outside this data path. They must be blocked from ordinary intake and
public issue composition and routed to the private process in [`SECURITY.md`](../../SECURITY.md).

## Assets and actors

Protected assets are:

- local repository/customer content, paths, logs, diagnostics, and credentials;
- the exact redacted report a user approved;
- intake queue confidentiality, integrity, disposition state, and deletion state;
- maintainer OIDC identity, role assignments, sessions, and review audit;
- GitHub App private keys, installation tokens, configured repository/label policy, and issue-create
  authority;
- keyed abuse identifiers, semantic dedupe HMACs, anonymous receipt capabilities, and service
  availability; and
- the integrity of linkage between local approval, immutable intake payload, maintainer approval,
  and a resulting GitHub Issue.

Relevant actors include an ordinary local user who may make a privacy mistake, a malicious anonymous
submitter, malicious report content, a network or proxy attacker, a compromised or over-privileged
maintainer account, an operator/insider, and a failing or compromised GitHub/provider boundary.

## Trust boundaries and data flow

| Boundary                               | Input crossing it                                                                    | Required control                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local browser -> loopback BFF          | User-entered fields, local text attachment selection, explicit preview/submit action | Existing loopback Host/Origin, JSON, CSRF, request-size, and correlation guards; no browser-direct remote intake call.                                           |
| Local content -> previewed report      | Potentially secret/customer-bearing text                                             | Strict accepted-text predicate, pre/post byte limits, path/secret redaction on every string including browser, raw-log rejection; source bytes/metadata omitted. |
| Loopback BFF -> hosted anonymous route | Exact approved canonical redacted bytes                                              | One configured HTTPS origin, fixed `POST /v1/feedback/reports`, `gatewayFetch`, no credentials, redirect denial, timeout/response caps.                          |
| Receipt caller -> hosted receipt route | Public receipt id plus secret capability                                             | Local memory/user copy only; fixed GET path and `Keiko-Receipt` auth; domain-separated stored hash/constant-time compare; coarse status only; uniform 404.       |
| Edge proxy -> intake service           | Untrusted request and forwarding headers                                             | Explicit trusted-proxy CIDRs, bounded chain parsing, raw-address-to-HMAC reduction before any log/persistence.                                                   |
| Anonymous handler -> queue             | Untrusted claimed schema/digest/provenance                                           | Independent parse, canonical-byte/digest/version/limit validation and residual scan; reject rather than mutate.                                                  |
| Maintainer browser -> maintainer API   | Review reads and disposition commands                                                | OIDC issuer/audience/signature/expiry validation, server-side RBAC, secure session/CSRF controls, no client actor or local fallback.                             |
| Queue -> maintainer display            | Attacker-controlled redacted text                                                    | Inert plain-text rendering; no HTML/Markdown, remote resources, automatic links, or formula/export interpretation.                                               |
| Approved item -> GitHub App            | Version-bound approved issue projection                                              | CAS transition, pre-approval marker-bound projection, outbox/reconciliation, configured target/labels, Issues read/write plus mandatory Metadata read only.      |
| Service -> backups/replicas            | Queue, audit, deletion state                                                         | Encryption/access control, maximum 35-day backup age, deletion ledger replay before restored data is served.                                                     |

The operator must configure TLS and a trusted reverse proxy at the public edge. Anonymous submit and
maintainer routes must use separate route groups and middleware; deployment may additionally isolate
them by hostname/network policy. No anonymous code path may dispatch a maintainer or GitHub action.
Issue #2075 owns the closed review state/action vocabulary and transition table; this document fixes
immutable-payload, server-identity, CAS, inert-rendering, approval, and authorization invariants, not
the final state names.

## STRIDE analysis

| Class                  | Threat                                                                                                             | Required prevention and evidence                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A request supplies a maintainer actor or uses Keiko's local-operator fallback.                                     | Ignore actor fields. Resolve a subject only from a verified OIDC token/session and server policy. No local fallback exists in the hosted service. Audit subject, issuer, role decision, and event without report text.                                                                                                                    |
| Spoofing               | An attacker forges `X-Forwarded-For` to evade limits or frame another address.                                     | Trust forwarding data only when the immediate peer is in configured trusted-proxy CIDRs; walk a bounded chain right-to-left; reject malformed chains. Ignore untrusted forwarding headers and exclude all raw address/header values from logs.                                                                                            |
| Spoofing               | A client selects a privileged GitHub repository, installation, labels, or app identity.                            | Client contracts have no raw target/label/installation fields. Resolve a server-issued target key through operator configuration after approval. App installation and labels are server-owned.                                                                                                                                            |
| Spoofing               | A guessed, leaked, or replayed receipt is used as reporter identity or broader authority.                          | POST returns a random 256-bit secret once; keep it only in local memory/user copy; GET uses `Keiko-Receipt`; store only a domain-separated hash, compare in constant time, and return only id/coarse `received\|closed`/expiry. Missing, invalid, and expired are indistinguishable 404. Each accepted duplicate gets a separate receipt. |
| Tampering              | Submitted bytes differ from the payload the user previewed.                                                        | Approval binds exact canonical UTF-8 bytes plus digest/schema/redaction version. Submit sends the same buffer. Hosted intake canonicalizes independently and rejects byte or digest mismatch. Any edit forces a new preview.                                                                                                              |
| Tampering              | A client lies about local redaction provenance or sends text the hosted scanner would alter.                       | Provenance is informational and untrusted. Hosted validation supports only known versions and reruns residual rules; if its result differs, reject before persistence rather than silently rewriting.                                                                                                                                     |
| Tampering              | Concurrent reviewers overwrite dispositions or issue creation uses a stale approval.                               | Keep payload immutable; store state/projection separately with monotone version. Require expected-version CAS for every disposition. Generate the random reconciliation marker before review and include it in the canonical projection digest; bind approval/outbox to payload, projection, target-policy, and record versions.          |
| Tampering              | A crash or retry creates duplicate GitHub Issues.                                                                  | Write approval and a unique outbox idempotency key transactionally. Reconcile the already-reviewed marker through the issue-only adapter before retry; never add it after approval. Ambiguous create results stop for human reconciliation. Unique constraints reject duplicate approval/create commands.                                 |
| Repudiation            | An anonymous reporter or maintainer disputes an action.                                                            | Anonymous intake intentionally does not assert reporter identity; its per-submission receipt is capability evidence only. For service actions, retain content-free linkage of item/digest/version/event/time/OIDC subject/result for at most 365 days. Do not claim non-repudiation stronger than OIDC and operator log custody provide.  |
| Information disclosure | Secrets, customer data, paths, private logs, or attachment metadata leave the machine.                             | No automatic/raw-log field. Enforce the strict UTF-8 scalar/control/magic/size/raw-log predicate and redact every string; only handwritten sanitized evidence summaries are eligible. No source bytes/metadata cross; hosted intake validates again; rejected bodies have zero retention.                                                 |
| Information disclosure | Raw IP or forwarding headers leak through access logs, traces, errors, or metrics.                                 | Disable framework client-address/header logging. Reduce the trusted address immediately to a daily HMAC. Persist key id, digest, UTC bucket start, and counts only until exactly 48 hours from bucket start; test log sinks with sentinel addresses.                                                                                      |
| Information disclosure | Maintainer UI executes stored HTML/Markdown, loads a tracking image, or exposes content in analytics.              | Render report text with text nodes/plain-text components only and a restrictive CSP; no third-party analytics, remote images, Markdown preview, linkification, or HTML insertion. Diagnostics are content-free.                                                                                                                           |
| Information disclosure | A semantic/dedupe digest is treated as anonymization or exposed as a public identifier.                            | Use a service-confined domain-separated HMAC, never SHA-256 alone or the abuse key. Hash only canonical already-redacted semantic fields, exclude volatile metadata, search a bounded active-plus-two-key ring, and delete entries after 180 days without duplicate-triggered refresh.                                                    |
| Information disclosure | GitHub App key/token enters logs, queue, crash report, or backup.                                                  | Private key lives in the service secret store and rotates within 90 days/immediately after suspected exposure; superseded keys are removed after cutover. Mint installation tokens after approval, keep them in memory for no more than provider TTL/one hour, redact errors, and never serialize token/key values.                       |
| Information disclosure | Deleted payload returns from a replica or restored backup.                                                         | Delete from all primary/index/cache/replica/outbox surfaces. Backups age out within 35 days. Restore replays deletion/expiry tombstones and current TTLs before accepting traffic; test this path.                                                                                                                                        |
| Denial of service      | Large bodies, decompression tricks, multipart parsing, slow clients, or expensive Unicode input exhaust resources. | Require JSON with a 256 KiB wire/canonical cap, bounded header count/length, read and processing deadlines, bounded concurrency, no multipart/decompression attachment path, linear/bounded redaction rules, and early rejection.                                                                                                         |
| Denial of service      | Distributed anonymous spam fills the queue or GitHub Issues.                                                       | Per-HMAC, global, and concurrency limits; UTC daily bucket/key, current/previous lookup, and exact start+48-hour expiry; separate 90-day rotating dedupe HMAC; bounded queue/storage and 90-day open-item expiry. GitHub creation remains authenticated human-approved.                                                                   |
| Denial of service      | Provider outage causes an unbounded retry/dead-letter backlog.                                                     | Bounded exponential retry only for classified safe failures, seven-day dead-letter expiry, circuit breaking, outbox metrics, and maintainer-visible reconciliation. Never hold installation tokens in retry records.                                                                                                                      |
| Elevation of privilege | Anonymous or low-role caller reaches review/disposition/create routes.                                             | Separate anonymous and maintainer route registries; deny by default; route-level OIDC/RBAC checks; network policy where available; negative authorization tests for every state-changing route.                                                                                                                                           |
| Elevation of privilege | The GitHub adapter gains PR, branch, merge, project, contents, workflow, or admin authority.                       | A new narrow issue adapter and closed endpoint/method allowlist; GitHub App permission inspection at startup/deploy permits only Issues read/write plus GitHub's mandatory Metadata read; configured repositories only; fail closed on broader/missing permission evidence. Do not widen ADR-0086's PR adapter.                           |
| Elevation of privilege | Report content injects Markdown mentions, hidden HTML, links, or issue-template control into GitHub.               | Compose from a fixed server template. Bound and normalize the title; neutralize mention/control syntax. Encode user prose as inert quoted/code text so it cannot add labels, close issues, load remote content, or impersonate template sections. Preview the derived projection to the reviewer before approval.                         |

## Abuse, dedupe, and privacy separation

The service uses two unrelated identifiers:

- **Abuse identity:** keyed HMAC over the trusted-proxy-derived normalized address. Normalization
  parses an IP, collapses IPv4-mapped IPv6, emits 4/16 network-order bytes, and rejects zone ids/non-IP
  input; the HMAC input is domain-separated with `keiko-feedback-abuse-v1`. Keys rotate exactly at
  00:00 UTC with `key_id=YYYY-MM-DD`; the daily bucket closes at the next 00:00 and its digest/counts
  expire exactly 48 hours from start (24 hours after close). Rate lookup computes under the current
  and immediately previous keys. The previous key is destroyed only after its last bucket reaches
  that expiry. It must not participate in dedupe, review, or GitHub content.
- **Dedupe identity:** service HMAC under the separate `keiko-feedback-dedupe-v1` domain over a
  version-tagged canonical projection of already-redacted semantic report fields. It excludes abuse
  identity, exact-body SHA-256, timestamps, request/correlation ids, redaction counts, receipts,
  transport headers, queue/review state, reviewer identity, and GitHub metadata. Keys rotate every 90
  days; lookup uses the active key plus at most two retained prior keys. A retired key is destroyed
  after its last non-refreshing 180-day entry expires.

Neither identifier is authorization, proof of reporter identity, or proof that content is harmless.
Every accepted POST returns only its own receipt tuple, and the capability GET returns only receipt id, coarse
status, and expiry. Neither response may reveal whether a dedupe HMAC, shared review payload, IP
bucket, review disposition, target, or GitHub Issue exists; otherwise the endpoint becomes an
enumeration oracle.

## Security-report misrouting

The local UI must ask explicitly whether the report concerns a security vulnerability and show the
private advisory route before ordinary report entry. Supported high-confidence vulnerability or
credential indicators block submit/public-link actions and show the same route. The hosted service
and maintainer queue repeat this control. A maintainer who encounters a suspected vulnerability
quarantines the item from ordinary queue views and GitHub creation and follows `SECURITY.md`.

These controls reduce accidents but cannot perfectly infer intent. The current redactors and secret
scanners are not semantic vulnerability or customer-data classifiers; this remains a documented
residual risk.

## Residual risks and stop conditions

- A user can paste business-sensitive or customer-identifying prose that matches no deterministic
  rule. Explicit preview and user attestation remain necessary; the UI must not claim otherwise.
- A compromised local machine can observe the report before redaction. Local OS compromise is
  outside this feature boundary.
- The trusted TLS terminator and hosted operator can access the already-redacted payload. Deployments
  must restrict and audit that access; client-side redaction does not provide end-to-end encryption
  from the operator.
- Distributed abuse can cross rotating identities and networks. Global capacity controls and human
  review limit impact but do not eliminate it.
- OIDC, service, secret-store, or GitHub compromise can defeat application controls. Least privilege,
  key rotation, deployment hardening, and provider audit remain operator duties.
- A created public GitHub Issue is copied outside intake retention and may be indexed or forked.
  Maintainer preview must make that permanence explicit.
- Exact-body SHA-256, dedupe/abuse HMACs, receipt hashes, and OIDC subject ids are pseudonymous
  linkable metadata, not anonymous data; their retention and access limits remain privacy controls.
- A scoped legal hold delays normal deletion for named items. It cannot legalize storage of data this
  contract forbids collecting.

Implementation must stop and return to architecture/security review if it needs a remote
`createUiServer` listener, credentials on anonymous submit, arbitrary destinations, binary
attachments, indefinite retention, client-provided actors/targets/labels, broader GitHub permission,
automatic public issue creation, or a semantic safety claim the deterministic controls cannot prove.

## Required verification evidence

Issues #2072-#2077 must provide tests for exact preview/body byte identity; canonical/digest and
server-rescan rejection; strict UTF-8 scalar/control normalization/rejection; binary magic,
raw-log-signature, multipart, and pre/post-size rejection; browser-field redaction; fixed-origin/path
and redirect denial; Host/Origin/CSRF local guards; trusted/untrusted proxy chains, UTC bucket start/
close, exact start+48-hour expiry, current/previous abuse-key lookup/destruction, and zero raw-IP logs;
separate 90-day dedupe-key-ring/180-day entry expiry;
per-accepted-duplicate receipt creation plus exact GET/auth/uniform-404/coarse response; OIDC/RBAC
negatives; #2075 CAS state-table tests; inert rendering; retention/legal holds; backup restore;
pre-approval reconciliation-marker digest binding; App permission/key rotation; and ambiguous create
idempotency.

Security review must also compare the implementation against
[`docs/security-and-audit-boundaries.md`](../security-and-audit-boundaries.md),
[ADR-0038](../adr/ADR-0038-outbound-egress.md), and
[ADR-0086](../adr/ADR-0086-governed-github-pull-request-gateway.md).
