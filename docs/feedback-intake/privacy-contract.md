# Governed Feedback Intake Privacy Contract

## Status and scope

This is the normative privacy contract for Epic #2070. Issue #2071 records the contract only;
Issues #2072-#2077 must implement and verify it. It governs ordinary feedback and user findings. A
suspected vulnerability is not feedback: Keiko must stop the public/intake flow and direct the user
to the private process in [`SECURITY.md`](../../SECURITY.md).

The feature is optional and is not telemetry. Keiko does not send a report, diagnostic, or
attachment automatically. A local human remains the sole authority to choose content, review the
final redacted payload, and submit it. A separate authenticated maintainer must approve any later
GitHub Issue creation.

## Trust planes and data flow

The implementation has three deliberately separate planes:

1. **Loopback local plane.** Report assembly, attachment decoding, redaction, preview, public-link
   composition, and the submit action remain in Keiko's existing loopback UI/BFF. An ordinary
   `createUiServer` route may coordinate local submission, but it can never become a remotely
   reachable intake listener.
2. **Operator-hosted intake plane.** A separately deployed service owns one anonymous submit route
   and a distinct authenticated maintainer route group. It is not a mode of the Keiko UI server and
   does not widen Keiko's loopback-only runtime.
3. **GitHub provider plane.** The hosted service, after recorded maintainer approval, uses a
   dedicated GitHub App adapter with Issues read/write plus mandatory Metadata read only on
   operator-configured repositories.

The approved flow is:

`local assembly -> local detection/disposition -> exact local preview -> explicit submit -> hosted validation -> immutable queue item -> authenticated review -> approved issue projection -> GitHub App create`

No step grants repository, model, tool, patch, workflow, or remote-control authority to the report.

## Local report contract

### Exact preview and submit

The preview is the submission contract, not an approximation. The local builder must:

1. accept only the versioned report fields and limits defined below;
2. enforce the accepted-text predicate below, detect credential/path/customer-identifier risk in
   every string field, and apply the deterministic disposition contract below;
3. produce UTF-8 canonical JSON with no BOM through the shared `canonicalise` primitive;
4. calculate a lowercase SHA-256 digest over those exact canonical bytes; and
5. bind the user's approval to the bytes, digest, schema/redaction versions, and matching local
   disposition sidecar.

Submit must send those exact bytes. It may add transport headers, but it must not enrich, redact,
reorder, timestamp, or otherwise rebuild the body after approval. Any edit, redaction-version change,
or attachment change invalidates approval and requires a new preview. No unpreviewed local path,
filename, environment value, clock value, correlation id, or diagnostic is added at submit time.
The preview renders every canonical field and offers the exact canonical JSON for inspection/copy;
there are no hidden body fields. Content-free local notices may explain redactions, quarantines,
omissions, or a blocking rejection, but they are UI chrome rather than hidden report content.

### Detection, disposition, and local recovery metadata

Detection and disposition are separate stages. A detector classifies structural evidence and a
disposition stage applies exactly one of these outcomes:

- A complete, high-confidence sensitive span is replaced in place with the approved redaction
  marker. Safe text around the proven span is preserved.
- Credential-like content whose complete boundary is ambiguous is quarantined, never partially
  redacted. Remove the smallest syntactically safe unit: a complete quoted segment or structured
  value when its boundary is proven; otherwise the rest of the line from the ambiguous value
  boundary for unterminated or malformed quote/nesting syntax. Omit a whole optional field/section
  or text attachment only when no smaller removal leaves a structurally valid safe unit.
- Other safe text remains byte-for-byte stable after the specified newline normalization. A
  required draft field remains usable whenever any meaningful safe content remains; preparation asks
  for a rewrite only when disposition leaves that required draft field empty. Exhausting a bounded
  structural scan, including the key-whitespace budget, is ambiguous: quarantine the affected unit,
  return content-free `rewrite-required` targeted to an exhausted required source field, or omit an
  exhausted optional field/attachment and continue.

Ambiguity requires structural evidence, such as a credential-key assignment, authorization
credential grammar, or URI userinfo delimiters. Ordinary natural-language discussion such as
password-reset or password-policy prose is not quarantined merely because it contains a sensitive
word. Detection and disposition use fixed passes, bounded delimiter state, bounded output, and no
input-dependent backtracking. They must be deterministic, idempotent, and linear-time over admitted
input sizes: rescanning the sanitized projection cannot change its content or add a new outcome.

A successful preparation returns paired immutable artifacts: the canonical wire report containing
only sanitized semantic values/provenance, and a local-memory-only sidecar with closed action/reason
codes plus a content-free draft-field id or snapshotted attachment ordinal.

V1 represents `summary` as `{ title, description }`. Each required member is independently
normalized, detected, disposed, validated, and hosted-verified, so safe values cannot manufacture
credential or raw-log grammar through concatenation. The existing 4 KiB combined UTF-8 cap includes
two LF bytes reserved for deterministic title-then-description display; safety scanning never joins
the values. Preview, public-link, dedupe, review, and GitHub projections consume those same values in
that order. A disposition targets its source control; #2073 maps that id or attachment ordinal to the
focusable control/card. Records may identify `quoted-segment`, `structured-value`, `line-remainder`,
`optional-field`, or `attachment`, but never content, offsets, filenames, paths, or user labels. Wire
provenance remains bounded engine/rule-code/count metadata; dispositions never enter the request,
public prefill, evidence, logs, or diagnostics.

A blocking preparation returns no canonical bytes. It reports only typed, content-free rewrite or
rejection reasons with the same target identifiers. The raw draft and quarantined material remain
transient local input. Recovery is edit/rescan, optional removal, or safe omission. Every edit
regenerates both artifacts and invalidates approval; no API or UI `send anyway` state exists.

The exact-body SHA-256 is an integrity digest. Its claimed value travels as fixed protocol metadata
outside the canonical body, so the body is not self-referential. It is distinct from the semantic
dedupe HMAC, which excludes provenance and volatile transport/review metadata.

The hosted service treats the body, claimed digest, and redaction provenance as untrusted. It parses
and validates the schema and byte limits, reruns the accepted-text/magic/raw-log gates, reproduces
canonical serialization and the digest, and scans the already-sanitized values with the supported
engine version. A non-canonical body, digest mismatch, unsupported version, unknown field, rejected
text, or remaining high-confidence/ambiguous structural detection is rejected before persistence.
The service never redacts, quarantines, omits, or otherwise repairs submitted content because any
such change would violate preview-equals-submit.

Redaction provenance contains only the engine version and bounded rule-code/count pairs. It contains
no disposition record, original value, replacement excerpt, offset, filename, path, or user-supplied
rule label.

### Version 1 accepted-text predicate

Every string-bearing field, including product version and browser description, follows one
deterministic pipeline. Byte-level decoding, magic, and input-size gates run before redaction; the
normalized sanitized string is then checked again for valid scalars, controls, residual signatures,
and output size:

1. Strict UTF-8 decoding must yield only valid Unicode scalar values. Invalid byte sequences and
   lone surrogate code points are rejected.
2. CRLF and remaining CR are normalized to LF. After normalization, TAB and LF are the only admitted
   C0 controls. NUL, every other C0 control, DEL/C1 controls, and every bidi/zero-width/unsafe format
   code point recognized by `stripUnsafeFormatChars` are rejected rather than silently removed.
3. The raw candidate bytes are rejected when a versioned signature table recognizes PDF, image,
   archive/compression, or executable magic at byte zero or immediately after an optional UTF-8 BOM.
   The table includes PDF, PNG, JPEG, GIF, BMP, TIFF, WebP, SVG, ZIP, gzip, RAR, 7z, ELF, PE/MZ, and
   Mach-O signatures.
4. The applicable per-field and aggregate byte ceilings are enforced both before processing and on
   the normalized, redacted result. A value cannot use redaction or normalization to evade an input
   cap.
5. Supported raw-log signatures, including recognized timestamp/severity prefixes and stack-trace
   record shapes, fail closed. There is no raw-log field or automatic log collection. Users may
   provide only a handwritten, sanitized summary of the observed evidence.

MIME type and extension are negative signals only: a non-text declaration may reject a candidate,
but `text/plain`, `.txt`, or a renamed file never establishes safety. A byte sequence that satisfies
the complete predicate is treated as text for this bounded feature; the contract does not claim to
perfectly determine whether arbitrary bytes originated from a binary file. Text acceptance precedes
credential-like disposition: rejection of binary, oversized, raw-log, invalid-Unicode, or otherwise
structurally unprocessable input is not converted into an optional omission.

### Version 1 field and size limits

All limits are measured in UTF-8 bytes and enforced before processing and after normalization and
redaction. Unknown fields fail closed.

| Value                                  | Version 1 limit                                   |
| -------------------------------------- | ------------------------------------------------- |
| Product version                        | 64 bytes                                          |
| Platform                               | Closed enum: macOS, Windows, Linux, Other         |
| Browser description                    | 256 bytes                                         |
| Structured summary title + description | 4 KiB combined, including two-LF display boundary |
| Steps, expected result, actual result  | 32 KiB each                                       |
| Handwritten evidence summary           | 64 KiB                                            |
| Safe structured diagnostics            | 16 KiB, fixed keys and enum/count values only     |
| Text attachments                       | At most 3; 64 KiB each; 128 KiB aggregate         |
| Whole canonical request body           | 256 KiB                                           |

These are ceilings, not retention entitlements. Required values that are empty initially or have no
meaningful safe content after disposition, over-limit values, duplicate JSON keys, invalid UTF-8,
non-finite numbers, and unsupported enum values are rejected.

### Text-only attachment evidence

Version 1 attachment evidence is text, not a file upload. Keiko locally reads a bounded candidate
under the applicable local file-selection boundary, strips an optional UTF-8 BOM, rejects UTF-16 or
UTF-32 BOMs, applies the complete accepted-text predicate and redaction, and inserts only the final
text into the previewed payload. No raw file/binary bytes cross the network. The original bytes,
filename, local path, MIME metadata, timestamps, extended attributes, and file hash are never
transmitted or persisted as intake data.

Multipart data and any format requiring parsing or extraction are rejected. Raw log files and text
matching supported raw-log signatures are rejected even if they otherwise decode as UTF-8; only a
handwritten sanitized evidence summary is eligible. After a candidate passes those gates,
credential-like ambiguity follows the normal smallest-safe-unit rules. If no safe attachment text
remains, that attachment is omitted by ordinal and other safe report content continues.

### Configured intake destination

Remote submission is disabled when `KEIKO_FEEDBACK_INTAKE_ORIGIN` is unset or invalid. The value is
one HTTPS origin only: no credentials, non-root path, query, fragment, wildcard, template, or
user-controlled target is accepted. Configuration is parsed once with WHATWG URL semantics and
stored as its normalized `URL.origin` (lowercase/IDNA host and default-port normalization).

The local feedback adapter may call exactly `POST /v1/feedback/reports` at that stored origin. It
constructs the URL from the fixed path, then requires strict equality between the request URL's
normalized origin and the stored origin. It uses `gatewayFetch` for proxy/custom-CA/DNS-rebinding,
timeout, and response-cap behavior, with credentials omitted and redirects set to manual. Every 3xx
is a terminal failure; no redirect target is followed. The UI cannot provide or override an origin,
path, header credential, query, or fragment.

### Public GitHub form alternative

The public alternative opens Keiko's fixed `user_finding.yml` form; it never submits an issue. URL
composition admits only the fixed `template=user_finding.yml`, a bounded title, and the known public
field ids `version`, `platform`, `browser`, `summary`, `steps`, `expected`, `actual`, `evidence`, and
`impact`. It never supplies repository, labels, assignees, project data,
`maintainer_release_impact`, or `safety`.

The percent-encoded URL is capped at 8 KiB. If it would exceed the cap, Keiko offers a copy action for
the sanitized field-labelled text and opens the unfilled fixed form. Both link and copy mappers read
only the immutable canonical semantic projection; they never re-read the draft, re-run disposition,
restore an omitted unit, or serialize the local sidecar. If clipboard access fails, the UI keeps the
same text visible and offers separate copy and open-form actions. The safety checkbox is never
preselected: the user must review the public form and attest safety on GitHub. A local safety pass is
not proof that a report is safe to publish. The preview warns that prefilled values become part of
the URL/browser history before the user chooses the public path.

## Hosted intake and review contract

### Anonymous submit, receipts, and abuse identity

`POST /v1/feedback/reports` accepts no cookie, API token, local Keiko credential, claimed actor,
repository, label, or maintainer instruction. Every accepted submission must return
`{ receiptId, receiptSecret, expiresAt }` exactly once. `receiptSecret` is a random 256-bit base64url
capability, `receiptId` is a random path-safe 128-bit base64url identifier, and `expiresAt` is an
RFC 3339 UTC timestamp. The raw secret is never logged or stored. The service stores only
`SHA-256("keiko-feedback-receipt-v1\0" || secret_bytes)` and compares decoded hashes in constant time.

The receipt read is fixed: `GET /v1/feedback/receipts/{receiptId}` with
`Authorization: Keiko-Receipt <receiptSecret>`. A valid response is exactly
`{ receiptId, status: "received" | "closed", expiresAt }`. It never exposes dedupe status, review state or
disposition, GitHub Issue/link, repository, target, label, reviewer, or rate-limit state. Missing,
duplicate/malformed authorization, invalid-secret, and expired receipts produce the same bounded
`404` response and are kept out of header/access logs. The POST `expiresAt` is the current upper
bound; a later valid GET may report an earlier effective expiry after closure to enforce the 30-day
terminal cap, never a later one.

The local client holds the returned tuple in memory for the current feedback session and may offer
an explicit copy action. It never persists `receiptSecret` in durable UI state, evidence, logs, or a
retry spool; after memory is cleared, only a user-retained copy can authorize a later receipt read.

Each accepted submission has its own immutable bounded receipt id/hash/accepted-at/hard-expiry and
internal linkage, even when semantic dedupe associates several submissions with one immutable
redacted review payload. The coarse status and effective expiry are derived from that linked
payload's lifecycle without revealing that sharing. A duplicate never reuses another submitter's
receipt or extends an existing receipt/dedupe TTL.

The service derives a client address only from the direct socket peer, unless that peer is in an
exact operator-configured trusted-proxy CIDR. For a trusted peer it walks the bounded forwarding
chain from right to left to the first untrusted hop; malformed or overlong chains fail closed.
Forwarding headers from any other peer are ignored.

The raw socket address and forwarding headers exist only long enough to derive a rate-limit key and
must be excluded from framework access logs, application logs, traces, metrics, queue records, and
error reports. The abuse key is `HMAC-SHA-256(rotating_secret, normalized_address)` with a non-secret
key id. Address normalization parses an IP value, collapses IPv4-mapped IPv6 to IPv4, serializes the
4-byte or 16-byte network address, and rejects zone ids and non-IP input. The HMAC input is
domain-separated as `keiko-feedback-abuse-v1 || 0x00 || address_bytes`. A daily key and bucket activate
exactly at 00:00 UTC with `key_id = YYYY-MM-DD` in UTC; that bucket closes at the next 00:00 UTC. Its
keyed digest and counts expire exactly 48 hours from the bucket start, which is 24 hours after close.
For each request the limiter computes and looks up the current and immediately previous key ids; no
raw address is retained by either lookup. The previous secret is destroyed only after its last bucket
reaches that 48-hours-from-start expiry. Stored buckets contain the keyed digest, key id, UTC bucket
start, and counts only.
One limiter operation obtains the active and immediately previous key from one bounded, copied
custody snapshot at one captured time. It never performs separate provider reads that could straddle
an external atomic replacement and combine different generations.

### Semantic dedupe identity

Dedupe uses a different service secret and domain from abuse control. The service computes
`HMAC-SHA-256(dedupe_key, "keiko-feedback-dedupe-v1\0" || canonical_semantic_bytes)` only after the
payload is independently validated as canonical and already redacted. The semantic projection is
versioned and contains only the report's product version, platform, browser description, structured
summary title and description in that order, steps, expected/actual result, impact, handwritten
evidence, accepted attachment text, and fixed safe diagnostics. It excludes the exact-body SHA-256,
provenance, receipts, abuse identity, request and
correlation ids, timestamps, transport metadata, review state/actor, and GitHub data.

Dedupe keys rotate every 90 days, use the versioned non-secret
`key_id = dedupe-v1:YYYY-MM-DD` activation date in UTC, and are kept in a bounded ring containing the
active key and at most two retained prior keys. Lookup computes the candidate HMAC under every key in
that ring. A retired key remains only until the last 180-day digest created under it expires, then is
destroyed. A duplicate may link its own receipt to the existing review payload, but it never refreshes
a digest expiry or creates an unbounded key alias. Dedupe HMACs are server-confined pseudonymous
metadata, not authorization or proof that content is safe.
One dedupe operation likewise obtains its active-plus-predecessor candidates from one bounded,
copied custody snapshot at one captured time.

### Operational key handoff

The exact abuse and dedupe rings intentionally rotate through a fail-closed handoff; there is no
application route or secret-bearing staging channel. The application first verifies that the
retiring predecessor has no live repository reference, records content-free `pending` evidence,
unlinks it, fsyncs the directory, proves durable absence, and records `destroyed`. Intake remains
unready throughout the resulting short-ring gap. Only after that evidence-backed retirement may the
external secret provider atomically publish the next key file. External replacement must preserve
every predecessor still required by a live bucket or digest and cannot delete retained material or
bypass the deletion ledger. The running service may become ready again only after it reloads and
validates the exact ring and all ordinary dependencies are healthy. Any interrupted step remains
fail-closed and resumes from the deletion ledger or the provider's atomic file operation.

Readiness compares one custody snapshot per key class with one transactional repository snapshot
containing both live key-id sets. Each database class is read with `LIMIT maximum + 1` (three abuse
ids and four dedupe ids), so excess cardinality, missing custody, or either snapshot failure keeps
intake unready.

### Maintainer identity, queue, and issue creation

The maintainer plane requires server-validated OIDC tokens/sessions with configured issuer,
audience, expiry, and role checks. Actor id and permissions come only from validated server-side
identity and policy. Client-supplied actors and local-operator fallbacks are forbidden.

An accepted redacted payload and its digest are immutable. Review state and any derived GitHub issue
projection are separate versioned records. Every disposition uses compare-and-swap with an expected
record version; conflicts fail without overwriting another review. Queue text is rendered inert as
plain text (`white-space: pre-wrap`), without HTML/Markdown execution, remote images, or active links.

This architecture fixes those invariants, but Issue #2075 owns the closed review state/action
vocabulary and transition table. #2075 may name and prove the lifecycle; it may not add mutable
payloads, client-supplied actors, non-CAS dispositions, or a path from receipt/anonymous authority to
approval or GitHub creation.

Before maintainer preview and approval, the service generates a stable random public reconciliation
marker that is not derived from an intake id or payload digest, inserts it into the exact issue
projection, and includes it in the canonical issue-projection digest. Approval binds the intake item
id, immutable payload digest, reviewed projection digest (therefore the marker), server-selected
target key, configured label-policy version, reviewer identity, and record version. The local
reporter cannot supply a repository or labels. A maintainer selects, at most, a server-issued target
key; the service resolves owner/repository, GitHub App installation, and fixed labels from operator
configuration.

Issue creation uses a transactional outbox and a unique idempotency key derived from the approved
item/projection/target. Retries reconcile the already reviewed marker through the issue-only adapter
before any second create; no marker or issue content is added after approval. Ambiguous provider
outcomes stop for maintainer reconciliation; they are not blindly retried. GitHub
App private keys remain in the service secret store. Installation tokens are minted only after
approval, kept in memory, never logged or queued, and expire in at most one hour. The App has Issues
read/write plus GitHub's mandatory Metadata read permission only, on configured repositories, and has
no contents, pull-request, branch, merge, project, administration, or workflow permission. Operators
rotate the private key at least every 90 days and immediately after suspected exposure; a superseded
key is removed after verified cutover and is never retained in intake data or backups.

## Data-class disposition matrix

| Class                                                                                                                                           | Disposition                        | Contract                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform, impact, and fixed diagnostic enums/counts                                                                                             | Allowed                            | Only allowlisted fields within byte/enum bounds.                                                                                                                     |
| Product version, browser description, user summary, reproduction steps, expected/actual result, handwritten evidence, accepted text attachments | Sanitized                          | Validate every string; redact proven spans, quarantine ambiguous smallest-safe units, preserve safe remainder, and omit an exhausted optional unit.                  |
| Redaction provenance                                                                                                                            | Allowed wire metadata              | Engine version plus bounded rule codes/counts only; never disposition targets or source content.                                                                     |
| Disposition and rejection records                                                                                                               | Local-memory-only sidecar          | Closed action/reason/unit-kind plus draft-field id or attachment ordinal; never offsets, excerpts, filenames, paths, or user labels; never serialized into the body. |
| Prompts, completions, source/repository contents, diffs, patches, evidence bodies, model/provider config, private endpoints                     | Omitted                            | No automatic collection, direct excerpts, or hidden submit-time enrichment; users may provide only a handwritten sanitized description.                              |
| Raw logs or text matching supported raw-log signatures                                                                                          | Blocked                            | There is no raw-log field or automatic log capture. Reject recognized raw-log content; accept only a handwritten sanitized summary.                                  |
| Original attachment bytes/name/path/metadata; local usernames/hostnames; cookies; local credentials                                             | Omitted                            | Never enter the canonical payload or hosted persistence.                                                                                                             |
| Dedupe identity                                                                                                                                 | Hashed                             | Domain-separated service HMAC over the canonical already-sanitized semantic projection; separate 90-day key ring; excludes transport/provenance/state metadata.      |
| Abuse identity                                                                                                                                  | Hashed                             | Rotating keyed HMAC over the trusted-proxy-derived normalized address; never raw IP/XFF.                                                                             |
| Anonymous receipt capability                                                                                                                    | Hashed                             | Return a high-entropy capability once; store only its domain-separated hash with the bounded receipt scope.                                                          |
| Secrets, credential values, known customer identifiers, absolute paths                                                                          | Redacted, quarantined, or omitted  | Redact only complete high-confidence spans; otherwise remove the smallest safe unit and block only when a required safe projection cannot be produced.               |
| Binary/image/PDF/archive/multipart attachment data                                                                                              | Blocked                            | Reject before persistence or hashing; optional omission does not turn prohibited bytes into accepted text.                                                           |
| Suspected vulnerabilities, exploit details, or security-impact reports                                                                          | Blocked from feedback/public paths | Direct to `SECURITY.md` and GitHub Security Advisories; a reviewer who encounters one quarantines it from public creation.                                           |
| Repository/label/actor/GitHub credential supplied by an anonymous client                                                                        | Blocked                            | Targets, labels, identity, and credentials are server-owned.                                                                                                         |

`redact`, path redaction, text-safety, and capture-safety checks recognize bounded patterns. They are
not semantic classifiers for arbitrary customer data, contractual data, business secrets, or
misclassified vulnerability details. The UI must say so plainly and preserve local human review.

## Retention and deletion

Defaults are maximums. Operators may configure shorter periods, never unlimited ones. Expiry is an
enforced deletion job with metrics and tests, not a documentation-only promise.

| Data                                                                                         |                                           Maximum retention | Expiry behavior and rationale                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local draft, quarantined units, disposition sidecar, attachment source bytes, receipt secret |                                              0 durable days | Memory only for the active local flow; no durable UI state, evidence, log, or retry spool.                                                             |
| Raw network and rejected request bodies                                                      |                                                      0 days | Bounded streaming/in-memory validation, then discard before response; never log or queue.                                                              |
| Accepted open redacted queue payload                                                         |                                     90 days from acceptance | Expire and delete payload if still unresolved; enough for ordinary maintainer triage without indefinite storage.                                       |
| Terminal item payload                                                                        |                           30 days from terminal disposition | Delete payload and derived issue draft; keep only content-free linkage/audit.                                                                          |
| Semantic dedupe HMAC                                                                         |                              180 days from first acceptance | Delete without refresh from duplicate attempts; balances repeat suppression against long-term linkability.                                             |
| Semantic dedupe HMAC key                                                                     | Rotate every 90 days; active plus at most two retained keys | Retain a retired key only until its last 180-day digest expires, then destroy it; never reuse the abuse key.                                           |
| Immutable receipt record and capability hash                                                 |    Open-item lifetime; at most 30 days after terminal state | Delete the bounded receipt/linkage and hash when the item expires or no later than 30 days after terminal disposition; never retain the raw secret.    |
| Content-free review audit and GitHub linkage                                                 |                                          365 days per event | Retain ids, enums, versions, timestamps, actor subject id, digests, and issue number/URL only; no report text. Supports regulated review traceability. |
| Abuse-rate bucket, keyed digest, and counts                                                  |                          Exactly 48 hours from bucket start | Bucket starts at 00:00 UTC, closes at the next 00:00, and is deleted 24 hours after close; previous key then becomes destroyable.                      |
| Dead-letter/outbox failure records                                                           |                                                      7 days | Retry/reconcile within the window, then delete payload-bearing data and retain only a content-free failure audit.                                      |
| GitHub installation access token                                                             |                                 Memory only, at most 1 hour | Provider TTL or one hour, whichever is shorter; never backed up.                                                                                       |
| GitHub App private key                                                                       |                         Secret store; rotate within 90 days | Remove the superseded key after verified cutover; rotate immediately on suspected exposure; never copy into intake storage or backups.                 |
| Backups containing eligible intake state                                                     |                                                     35 days | Encrypted, access-restricted, and aged out automatically; restore must replay deletion/expiry tombstones before serving traffic.                       |

A legal hold is never global or implicit. It requires an authorized operator record naming the exact
item ids, legal basis, approver, start, and mandatory expiry/review date. It cannot retain raw IP,
rejected bodies, receipt records/capabilities/hashes beyond the limit above, retired dedupe keys
beyond their last digest TTL, superseded private keys, credentials, installation tokens, or data
that this contract forbids storing. Releasing the hold immediately resumes the applicable deletion
clock.

Deletion covers primary rows, search indexes, caches, replicas, outbox/dead-letter copies, and object
storage. Backup copies age out within 35 days; a restored backup must apply the deletion ledger and
current TTLs before the service becomes readable. GitHub Issues already created are separate public
provider records and follow GitHub/project governance; the preview and approval UI must disclose
that remote deletion is not implied by intake deletion.

## Later-child obligations

- **#2072:** define versioned report/provenance types, canonical bytes, exact-body SHA-256, the strict
  accepted-text/raw-log predicate, structural detection, smallest-safe-unit disposition, local-only
  typed recovery sidecar, byte limits, false-positive controls, and adversarial linear-time tests.
- **#2073:** implement local assembly, exact safe preview/approval binding, redacted/quarantined/
  omitted notices, edit-and-rescan/remove/continue-safe-omission recovery, explicit submit authority,
  vulnerability routing, fixed public form URL with copy fallback, and no `send anyway` path.
- **#2074:** implement the separately deployable service, independent validation, exact receipt
  capability routes, UTC abuse-key rotation, separate rotating dedupe HMAC, retention/deletion jobs,
  and zero-body/secret/IP rejection logs.
- **#2075:** define and prove the closed review state/action table while implementing OIDC/RBAC,
  immutable queue payloads, CAS transitions, inert rendering, content-free audit, and legal holds.
- **#2076:** implement the narrow GitHub App adapter, configuration-owned targets/labels, the
  pre-approval marker-bound projection, idempotent outbox, short-lived token custody, and
  ambiguous-result reconciliation.
- **#2077:** prove preview/body/public-projection identity, typed disposition recovery and omission,
  public/security routing, end-to-end retention/deletion including backup restore, abuse/privacy
  properties, and issue-creation permission boundaries.

See also the [threat model](threat-model.md), [reuse analysis](reuse-analysis.md),
[ADR-0125](../adr/ADR-0125-governed-feedback-intake.md), and
[security boundaries](../security-and-audit-boundaries.md).
