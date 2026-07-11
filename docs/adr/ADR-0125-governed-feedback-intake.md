# ADR-0125: Governed feedback intake architecture and privacy contract

## Status

Accepted (Issue #2071, 2026-07-09); disposition clarification authorized in Issue #2072
(2026-07-10).

## Context

Epic #2070 adds an in-product path for reporting a Keiko user finding without weakening the
product's local-first runtime or publishing unreviewed customer material. The path must support two
different outcomes:

- send an already-sanitized report to a Keiko-operator intake queue for maintainer review, when an
  operator has configured that service; or
- open the existing public [`user_finding.yml`](../../.github/ISSUE_TEMPLATE/user_finding.yml)
  form with a bounded prefill/copy handoff that the user still submits themselves.

Those outcomes cross trust boundaries that do not exist in the current local feedback-free product.
[`createUiServer`](../../packages/keiko-server/src/server.ts) is a local UI BFF: callers bind it to
loopback, it rejects non-loopback authorities, and it has neither hosted tenant authentication nor a
remote-listener contract. [`gatewayFetch`](../../packages/keiko-model-gateway/src/http.ts) is the
approved server-side outbound HTTP seam and already carries enterprise proxy, custom-CA, timeout,
and response-cap controls. The security redactor recognizes known credential shapes, configured
literal secrets, German IBANs, and German phone numbers, but it is **not** a semantic classifier for
arbitrary customer data, proprietary code, private business facts, or every personal-data format.

The hosted side has a different job. It accepts anonymous submissions, rate-limits abuse, retains
sanitized reports for review, authenticates maintainers, records review transitions, and creates a
public GitHub issue only after approval. Its storage, audit, OIDC authorization, abuse controls, and
GitHub App credentials are service-side responsibilities; moving any of them into the local BFF
would turn the npm-delivered product into an unsupported hosted multi-user server.

ADR-0086 is also not an issue-creation shortcut. It governs local user-initiated pull-request
orchestration through a narrow `gh api` adapter. Expanding that authority to hosted, service-account
issue creation would mix providers, credentials, actors, and approval semantics.

This ADR fixes the deployment and privacy boundary before Issues #2072-#2077 implement it. The
detailed contracts are maintained in:

- [Privacy contract](../feedback-intake/privacy-contract.md)
- [Threat model](../feedback-intake/threat-model.md)
- [Reuse analysis](../feedback-intake/reuse-analysis.md)

## Decision

### D1 - Keep local report preparation and hosted intake in separate deployment planes

The feedback flow has two separately deployed planes:

| Plane | Owns | Must not own |
| --- | --- | --- |
| Local Keiko product | Field assembly, bounded local text extraction, deterministic detection/disposition, canonicalization, preview, explicit user confirmation, and optional outbound submission through `gatewayFetch`. | A remote listener, hosted queue storage, maintainer identities or roles, OIDC sessions, GitHub App credentials, or multi-user review state. |
| Operator-hosted intake service | Anonymous submit endpoint, validation, abuse controls, redacted queue storage, content-free audit, OIDC/server-authorized maintainer API, review state, and GitHub App issue creation. | Local repository/filesystem access, local Keiko credentials, pre-redaction material, or a general-purpose proxy back into `createUiServer`. |

`createUiServer` remains the local assembly/sanitization/preview plane and **must not** host the remote
intake API. The operator-hosted service is a distinct deployment, process, origin, data store, and
authorization boundary. Its existence does not make Keiko's local BFF a supported multi-user or
internet-facing server.
Local report material is memory-only until the user submits or copies it. No raw draft, selected
file bytes, network body, or pre-redaction report is durably persisted by Keiko.

### D2 - Permit one operator-configured exact HTTPS origin and one fixed submit path

Remote submission is optional and disabled by default. A deployment may configure exactly one
intake **origin**. The value must be an absolute HTTPS origin containing scheme, host, and optional
port only. Userinfo, path other than `/`, query, fragment, wildcard host, template expansion, and
per-report override are invalid. Missing or invalid configuration disables the submit action and
causes zero remote feedback egress.

The local BFF appends the fixed path `/v1/feedback/reports` and sends one JSON `POST` through
`gatewayFetch`. The caller sets a bounded timeout and response cap, and the feedback wrapper treats
every manually surfaced 3xx response as a terminal failure without following it. It does not attach
cookies, bearer tokens, API keys, ambient credentials, or user-controlled headers. The browser never
fetches the remote origin directly. No caller may supply a URL, path, query, redirect target, or
credential. Proxy and CA behavior comes only from the existing ADR-0038 egress configuration.
This is a narrow optional outbound capability, not a general webhook, connector, telemetry,
analytics, crash-upload, or arbitrary HTTP surface.

### D3 - V1 accepts only bytes that satisfy a deterministic text predicate

The v1 report contract contains typed, bounded text and closed metadata values aligned with the
public user-finding form. Evidence is text-only. Every string-bearing field passes the same predicate
before redaction and again after redaction. If a user selects a local evidence file, Keiko may read
it only through a bounded local extraction path. The complete bounded byte sequence qualifies as
text if and only if it satisfies this deterministic predicate:

1. strict UTF-8 decoding yields only valid Unicode scalar values;
2. after CRLF and remaining CR are normalized to LF, TAB and LF are the only admitted C0 controls;
   NUL, every other C0 control, DEL/C1 controls, and every bidi, zero-width, or unsafe format
   character recognized by the shared text-safety rules are rejected rather than removed;
3. no PDF, image, archive/compression, office-container, or executable signature from the versioned
   known-magic table occurs at its applicable offset;
4. the value satisfies its field and aggregate byte ceilings both before processing and after
   normalization/redaction; and
5. the text matches no supported raw-log signature, including recognized timestamp/severity prefixes
   and stack-trace record shapes.

Bytes satisfying this predicate are treated as text, subject to the negative-signal rejection below;
the implementation does not claim to infer a broader binary/text ontology. Filename, extension, and
declared media type are negative signals only: a non-text declaration or denied extension may reject
a candidate, but `text/plain`, `.txt`, or a renamed file can never make bytes pass. Formats requiring
parsing, decompression, OCR, transcoding, or content sniffing beyond the fixed checks are unsupported.

Original bytes, absolute or relative path, filename, extension, MIME metadata, timestamps,
permissions, ownership, archive entries, EXIF, and other file metadata are omitted from the report.
No file or attachment object crosses the boundary: the canonical report may contain only the
locally extracted text evidence. Neither local submission nor the hosted API supports multipart
bodies. The hosted service accepts only the canonical JSON media type and repeats the type, field,
count, and byte-cap checks before any persistence.

There is no raw-log field or automatic log collection. The report contract accepts only a
handwritten, bounded, sanitized evidence summary. A known raw-log signature fails closed and asks
the user to write a new sanitized summary; Keiko does not automatically summarize or transform the
raw log. The original log bytes, file object, and rejected content remain local and have zero durable
retention.

Detection and disposition are separate; redact complete, high-confidence sensitive spans in place.
Ambiguous credential-like content needs structural evidence; never partially redact it. Quarantine
the smallest complete quoted/structured value, then a malformed line remainder, then an optional
unit or attachment, while preserving safe remainder. Ordinary password-policy/reset prose is not
structural evidence. V1 keeps `summary.title` and `summary.description` as distinct required strings
and scans/verifies each independently, preventing join-boundary credential or raw-log grammar. Their
combined 4 KiB UTF-8 budget includes the reserved two-LF display boundary; projections render title
then description unchanged. Scan exhaustion quarantines the unit, omits exhausted optional content,
or returns content-free `rewrite-required` only when a required field has no meaningful safe content.

Preparation returns canonical sanitized bytes plus a paired, local-memory-only disposition sidecar.
The sidecar has closed action/reason/unit-kind codes and only a closed source draft-field id or
snapshotted attachment ordinal; it has no content, offset, filename, path, or user label and never
enters the wire body, public prefill, evidence, or logs. Redaction provenance in the canonical body
remains engine version plus rule-code/count pairs only. Raw/quarantined input stays transient and
local. Recovery is edit/rescan, optional removal, or safe omission—never `send anyway`; the pipeline
stays deterministic, bounded, and linear-time.
Binary, oversized, raw-log, structurally unprocessable, or required-empty input remains blocked.

The redactor is one bounded defense, not a semantic customer-data classifier. The preview must say
it can miss proprietary/customer data and that the user must review the complete outbound text.

### D4 - Preview and every destination use one canonical sanitized projection

The local assembler validates typed inputs, applies the complete detection/disposition pipeline to
every string, and serializes the safe semantic report once into canonical UTF-8 JSON bytes. The
preview is rendered by decoding those immutable bytes. Confirmation sends those exact bytes;
submit-time code must not rebuild, enrich, reorder, re-read, or resanitize the report. Public-form
prefill/copy maps only that same semantic projection and cannot restore an omitted unit.
The envelope binds a schema version, privacy/redaction contract version, and SHA-256 digest to the
canonical report. This exact-body SHA-256 is an integrity digest only; it is not the service's
semantic dedupe identifier. The hosted service uses the same contract rules to verify:

- the body is already canonical and its digest matches;
- every field and aggregate byte limit is satisfied;
- the declared contract versions are supported; and
- acceptance would not require additional normalization, redaction, quarantine, or omission.

Any validation, canonicalization, or sanitization drift is rejected with a content-free error and no
report persistence. The service must not silently repair or transform a submitted report, because
that would break the promise that maintainers review exactly what the user previewed.

### D5 - Split the hosted service into anonymous submit and authenticated maintainer planes

`POST /v1/feedback/reports` is the only anonymous report-ingress endpoint. It does not establish a
user account, set a browser session, or expose queue contents. Every accepted submission returns a
fresh `{ receiptId, receiptSecret, expiresAt }` capability. The high-entropy `receiptSecret` is
returned once; the service stores only its domain-separated hash and compares presented secrets in
constant time.

The capability authorizes exactly one fixed read operation:

```text
GET /v1/feedback/receipts/{receiptId}
Authorization: Keiko-Receipt <receiptSecret>
```

Success returns exactly `{ receiptId, status: "received" | "closed", expiresAt }`. Unknown,
malformed, expired, or secret-mismatched receipts all return the same generic `404` response. The
receipt never reveals report text, dedupe-group membership, rate-limit identity, queue/review state
beyond the coarse status, internal review-item ids, GitHub linkage, review notes, or credentials.
Each accepted submission keeps its own immutable receipt record even when semantic dedupe points
several submissions at one shared review payload.

Queue reads and every review mutation live on a distinct maintainer plane. Maintainers authenticate
through operator-configured OIDC, and the service applies server-side authorization to every item,
transition, and GitHub action. Authentication alone is not authorization. Browser/UI state is not
trusted to grant a role, approve an item, or select a repository. The invariants fixed here are an
immutable accepted payload, server-authorized actor and action, compare-and-swap mutation,
actor-attributed audit, approval bound to the current payload and issue-projection digests, and no
GitHub dispatch without a current approval. Issue #2075 owns the closed review state/action table
and its complete transition rules; later children must not invent parallel states or actions.
The OIDC client secret, session/signing keys, storage credentials, and GitHub App material exist only
in the hosted service's secret boundary. None are accepted by or returned through `keiko-server`.

The hosted maintainer UI cannot import the loopback product's `globals.css` across this deployment
boundary. Its package emits byte-for-byte copies of canonical `design-system/keiko-tokens.css` and
`design-system/keiko-semantic-tokens.css`. Canonical ownership remains with the Design System; this
adapter introduces no namespace, visual value, or theme engine, and a focused byte-sync test fails
closed on drift. Maintainer responses emit `Strict-Transport-Security: max-age=31536000`; an operator
edge may strengthen it with `includeSubDomains` only after verifying control of every subdomain.

### D6 - Rate-limit with a daily keyed identity and retain no raw network address

The service normalizes the client IP into canonical network-order address bytes and derives the abuse
identity as `HMAC-SHA-256(abuse_key, "keiko-feedback-abuse-v1" || 0x00 || address_bytes)`. The
daily bucket and key start exactly at `00:00 UTC`; the non-secret `key_id` is that UTC date in
`YYYY-MM-DD` form. The bucket closes at the next `00:00 UTC` and expires exactly 48 hours from its
start, which is 24 hours after close. New submissions use the current bucket/key; the current and
immediately previous keys cover every live bucket. The previous key is destroyed when its last bucket
expires, and no older key is retained. The identity therefore rotates daily and cannot be used as a
stable cross-day reporter id. Raw IP addresses and raw forwarding headers exist only in request-local
memory long enough to validate the source and derive the HMAC; they are never persisted, emitted to
application/access logs, included in traces, placed in dead letters, or copied into audit records.
The socket peer is authoritative by default. `Forwarded` or `X-Forwarded-For` is honored only when
the immediate peer is in the operator's exact trusted-proxy configuration and the documented chain
is valid and unambiguous. Untrusted or malformed forwarding data is ignored or rejected; it never
selects the rate-limit identity. Rate-limit buckets store only the rotating HMAC, window, and counts.
This mechanism is abuse resistance, not user identity, authentication, deduplication, or an audit
principal.

The service-readable abuse-key mount contains exactly the current key and its immediately previous
key; it never contains staged or future material. The external secret provider/operator atomically
activates the next key at the UTC boundary. Until that replacement is visible, intake remains
unready and fails closed. Removal of the superseded previous key remains conditional on repository
proof that no live bucket references its non-secret key id.

Each abuse admission obtains one bounded, copied custody-ring snapshot at one captured time and
derives both the active and predecessor candidates exclusively from it. Separate provider reads for
the active key and predecessors are forbidden because an atomic external replacement could otherwise
mix two custody generations within one request.

### D7 - Dedupe with a separately keyed HMAC over the sanitized semantic projection

The dedupe identifier is
`HMAC-SHA-256(dedupe_key, "keiko-feedback-dedupe-v1" || 0x00 || canonical_semantic_bytes)` over only
the canonical bytes of the already-sanitized semantic report projection. It is not the exact-body
SHA-256 integrity digest and never uses the daily abuse-control key. It is not computed over raw
inputs, pre-redaction text, redaction provenance, IP-derived data, receipt capabilities, timestamps,
request/correlation ids, review state, transport headers, reviewer identity, GitHub metadata, or
other volatile metadata. Canonicalization, domain separation, and the exact semantic field set are
versioned.
The active dedupe key rotates every 90 days and has the versioned, non-secret UTC activation id
`key_id=dedupe-v1:YYYY-MM-DD`. Lookup checks the active key plus at most two retained predecessor keys
so reports can match unexpired digests created before rotation. A predecessor is retained only until
the last digest created with it reaches the 180-day expiry, then its key material is destroyed. At no
time may the service keep more than one active plus two retained dedupe keys.
The readable dedupe-key mount likewise contains only the active key and zero to two predecessor keys;
future or staged material is not readable by the service. Boundary activation is an external atomic
secret-provider operation, and missing activation leaves intake unready rather than widening the
custody ring. A predecessor is destroyed only after repository lookup proves no live dedupe entry
references its key id.
Each dedupe admission follows the same snapshot rule: it obtains the active key and up to two
predecessors from one bounded, copied provider snapshot at one captured time, never from separate
reads that can straddle a rotation.
A duplicate may increment a bounded group count without creating a second review payload, but it
does not refresh the matched digest's creation time or 180-day expiry. Every accepted duplicate still
receives and retains its own immutable receipt record under D5. The submitter is not told whether
another reporter submitted the same content. Dedupe HMACs are equality keys only; they are not
evidence that two people, machines, or incidents are the same.

### D8 - Create GitHub issues only after review through a dedicated GitHub App adapter

The hosted service may create an issue only from an approved queue item whose approval is bound to
the current canonical payload digest. Before approval is requested, the service generates a stable
random public GitHub reconciliation marker that is not derived from an intake id or payload digest
and includes it in the reviewer-visible issue projection. The approved issue-projection digest
covers that marker, so create/retry/reconciliation cannot introduce or change it after approval. A
dedicated narrow issue adapter admits only issue creation and marker reconciliation for
operator-configured repositories. On those repositories, the GitHub App has exactly
`Issues: read/write` plus GitHub's mandatory `Metadata: read`; it does not receive contents,
pull-request, branch, merge, administration, project, workflow, or other repository-write
permission.

The App private key stays in the service secret store. A short-lived installation token is minted
only when an approved action executes, held in memory, never logged/persisted/returned to a browser,
and discarded within one hour at the latest. Repository owner/name and allowed installation are
operator configuration, not reporter or maintainer free text. The adapter has only closed
issue-create and reconciliation-marker lookup operations, typed response projections, bounded
retries, and secret-safe failures.

This is a new service-side adapter. ADR-0086 and its `gh api` pull-request gateway remain unchanged
and must not be widened to create issues, hold a GitHub App key, or act for the hosted service.

### D9 - Keep the public form as an explicit user-controlled fallback

The local UI always identifies the public path as public and links specifically to the repository's
current [`user_finding.yml`](../../.github/ISSUE_TEMPLATE/user_finding.yml) form. It may prefill only
bounded values mapped from the same canonical sanitized projection. If the browser or GitHub form does
not support a field, the encoded URL would exceed the conservative URL cap, or clipboard permission
is unavailable, the UI presents that same sanitized field-labelled content for explicit copy instead
of truncating fields or using a different template. It never reads the raw draft or serializes the
local disposition sidecar. The user reviews and submits the public issue; Keiko does not do so on
their behalf.

Suspected vulnerabilities and reports requiring private coordination must never use the anonymous
intake-to-public flow or public fallback. The UI and maintainer queue route those reporters to the
private GitHub Security Advisory channel in [`SECURITY.md`](../../SECURITY.md). Detection is advisory
and fail-safe because the redactor is not a semantic vulnerability classifier: users and maintainers
can mark a report private at any point, and maintainers must not publish an uncertain security item.

### D10 - Apply explicit retention ceilings to every hosted data class

The detailed deletion and backup semantics live in the
[privacy contract](../feedback-intake/privacy-contract.md). V1 uses the following conservative
defaults, which are also maxima. Operators may shorten them. Lengthening or disabling a limit
requires a superseding reviewed policy decision or ADR.

| Data class | Maximum durable retention |
| --- | --- |
| Local draft, quarantined units, disposition sidecar, raw file/network/log bytes, pre-sanitization report, rejected request body | None (zero durable retention) |
| Open redacted intake payload | 90 days |
| Terminal-state redacted payload | 30 days |
| Canonical sanitized semantic dedupe HMAC and bounded group count | 180 days from first acceptance; duplicates do not refresh |
| Semantic dedupe HMAC key material | Active key rotates every 90 days; at most two predecessor keys survive only until their last 180-day digest expires |
| Content-free audit transitions, payload digest, and GitHub linkage | 365 days |
| Daily abuse-rate buckets | Exactly 48 hours from their 00:00 UTC start; close after 24 hours and expire 24 hours later |
| Abuse-control HMAC key material | Current and immediately previous UTC-day key only; destroy the previous key when its last bucket reaches its 48-hour expiry |
| Redacted dead-letter record | 7 days |
| Immutable receipt record and receipt-secret hash | Until item expiry; at most 30 days after a terminal state |
| GitHub App installation token | Memory only; at most 1 hour |
| Backups containing retained classes | Age out within 35 days; restore reapplies tombstones before service resumes |

GitHub App private-key rotation targets at most 90 days under the operator's secret policy. Legal
holds must be explicit, scoped, actor-attributed, and auditable. A legal hold cannot resurrect or
begin retaining any zero-retention class, extend receipt-secret-hash expiry, or retain retired abuse
or semantic-dedupe keys after their defined horizon. Expiry deletes payloads and related
capabilities from primary storage; backup replay must not restore expired data.

Retired-key destruction uses a durable, idempotent deletion ledger with only the closed key class,
non-secret key id, event timestamp, and closed result. A `pending` row is recovery intent, not proof
of destruction. The service records `destroyed` only after unlinking the key and fsyncing its
directory, or after replay has re-established and fsynced the key's durable absence. A database
failure after destruction therefore remains pending and makes intake unready until replay completes;
a completed row is never downgraded. Key bytes, filesystem paths, exceptions, and arbitrary strings
never enter this evidence.

Exact-ring rotation uses a fail-closed handoff, in this order:

1. The application proves that the retiring predecessor has no live repository reference and records
   `pending` deletion evidence.
2. The application unlinks that predecessor, fsyncs the key directory, proves the key is absent, and
   records `destroyed`. Intake remains unready; this temporary short ring is not an intake-capable
   state.
3. Only then does the external secret provider atomically publish the next key file. That replacement
   must retain every still-required predecessor and cannot substitute for or bypass deletion evidence.
4. The application reloads and validates the exact active-plus-predecessor ring. Readiness may return
   only after both that validation and the ordinary dependency checks succeed while the service is
   running.

For that readiness decision, the service takes one bounded custody snapshot per key class and
compares both against one repository operation that reads both live key-id sets in a single database
transaction snapshot. The abuse and dedupe queries are capped at their maximum mounted cardinality
plus one so overflow is observed and fails readiness closed instead of being truncated into a
plausible ring.

The application does not expose a staging route, accept future readable key material, or receive key
bytes through an API. A crash or failure at any step leaves intake unready and resumes through the
existing deletion ledger plus external atomic file publication.

### D11 - Child issues implement one obligation each in dependency order

The epic obligations are:

| Issue | Obligation |
| --- | --- |
| #2072 | Define the bounded report and local-only typed disposition sidecar; deterministic accepted-text, structural detection, smallest-safe-unit quarantine/omission, false-positive controls, canonicalization, provenance, exact-body digest, and adversarial linear-time verification. |
| #2073 | Render exact canonical safe content with redaction/quarantine/omission notices; support edit-and-rescan, optional-unit removal, and continue-with-safe-omission; provide fixed public prefill/copy and private security routing with no `send anyway`. |
| #2074 | Implement the separate anonymous JSON endpoint, drift rejection, exact-origin compatibility, daily abuse-key rotation, trusted proxies, separately keyed dedupe, per-submission receipts, and retention jobs. |
| #2075 | Define the closed review table; implement OIDC/server authorization, immutable redacted review, digest-bound CAS transitions, private routing, retention, and content-free audit without changing this ADR's invariants. |
| #2076 | Implement the closed GitHub App issue adapter, configured targets, pre-approval marker/digest binding, exact permission gate, approved-item gate, memory-only token, template mapping, idempotency, and safe linkage. |
| #2077 | Prove preview/submit/public-projection identity, dispositions and safe omissions, rejection gates, zero-config egress, abuse/dedupe rotation, receipt isolation, authorization, marker binding, approved-only creation, routing, retention, and release evidence. |

No child may weaken an earlier obligation to make a later slice easier. Public-API expansion,
retention widening, additional remote endpoints, attachment support, or a new credential scope
requires architecture review before implementation.

## Consequences

### Positive

- Keiko remains a loopback-only local product while gaining one explicit optional outbound action.
- Users preview the exact canonical sanitized bytes that maintainers receive, while content-free
  local notices identify redaction, quarantine, and omission recovery.
- Hosted authentication, storage, abuse control, and GitHub credentials have a dedicated security
  boundary rather than leaking into the local BFF.
- Separately keyed dedupe and daily abuse control avoid raw/stable reporter identifiers and
  pre-redaction fingerprints; bounded rotation limits linkability.
- Maintainers remain the publication gate; the public issue template and private advisory channel
  retain their existing governance roles.

### Costs and residual risks

- Operators choosing managed intake must deploy, secure, monitor, back up, and rotate secrets for a
  separate service.
- Anonymous intake remains an abuse target even with daily pseudonymous rate limiting.
- Pattern and literal redaction can miss semantic customer data. Explicit preview and human review
  reduce but do not eliminate that risk.
- Structural ambiguity can remove safe-looking adjacent text. Smallest-safe-unit rules and
  field-level edit/rescan recovery bound that false-positive cost without permitting a bypass.
- Exact-byte equivalence deliberately turns validator/redactor version skew into a rejected
  submission; coordinated version rollout and clear remediation are required.
- Text-only evidence is less convenient than attachments, but avoids a materially larger malware,
  metadata, storage, and disclosure surface.

## Alternatives considered

### A1 - Add the anonymous and maintainer APIs to `createUiServer`

Rejected. It would combine a loopback local BFF with an internet-facing, persistent, multi-user
service and imply that hosted authentication belongs in `keiko-server`.

### A2 - Let the browser submit directly to any configured URL

Rejected. Browser-direct or user-controlled destinations would bypass `gatewayFetch`, enterprise
egress controls, exact-destination validation, and the no-credential contract, while creating an
SSRF/open-webhook-like product surface.

### A3 - Resanitize or normalize reports after preview

Rejected. Silent service transformations make the preview untruthful. Drift is rejected instead.

### A4 - Store raw IPs, stable IP hashes, or forwarding headers for abuse control

Rejected. They create long-lived linkability and sensitive operational data that the use case does
not require. Daily keyed HMAC buckets provide bounded abuse resistance.

### A5 - Extend ADR-0086 or use a maintainer PAT to create issues

Rejected. The pull-request gateway has the wrong actor, operation, credential, and deployment
boundary. A configured-repository GitHub App with a closed issue adapter, `Issues: read/write`, and
only the mandatory `Metadata: read` permission is narrower and auditable.

### A6 - Accept arbitrary file evidence and rely on redaction or binary detection

Rejected. Redaction is not a file classifier, and heuristic binary detection would overclaim what it
can prove. V1 accepts only locally extracted bytes that satisfy the fixed strict-UTF-8 text predicate
and transmits only the resulting sanitized text.

### A7 - Use plain SHA-256 as the long-lived semantic dedupe identifier

Rejected. Although the projection is already redacted, a plain digest remains vulnerable to offline
guessing of low-entropy reports. A separately keyed, domain-separated service HMAC with bounded key
rotation and retention narrows that disclosure risk without coupling dedupe to the daily abuse key.

### A8 - Publish every accepted anonymous submission immediately

Rejected. Validation and pattern redaction do not establish publication safety or issue quality.
Maintainer review and explicit approval remain mandatory.

## Related

- Epic #2070 - Governed in-app feedback intake and public user-finding flow.
- Issue #2071 - Feedback intake architecture, privacy contract, and ADR.
- Issues #2072-#2077 - Contract, UI, intake, review, GitHub App, and integrated verification slices.
- [ADR-0019](ADR-0019-modular-package-architecture.md) - local product and package boundaries.
- [ADR-0038](ADR-0038-outbound-egress.md) - shared `gatewayFetch` egress.
- [ADR-0086](ADR-0086-governed-github-pull-request-gateway.md) - existing pull-request gateway, deliberately unchanged.
- [Security and audit boundaries](../security-and-audit-boundaries.md).
- [Security policy](../../SECURITY.md).
