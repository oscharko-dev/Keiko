# Security Boundaries

Keiko is a local coding assistant. It is designed for reviewable work in regulated engineering
environments, not for unattended code changes or hosted multi-user operation. An optional feedback
action may send one user-reviewed, canonical sanitized report outbound to a separately deployed
operator service; that narrow egress does not turn the local product into a hosted server.

## Enforced controls

| Area                   | Boundary                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI network surface     | The product binds to loopback only. No remote listener is part of the supported runtime model.                                                                                                                                                                                                                                                                                                                      |
| Model access           | Productive model calls route through `@oscharko-dev/keiko-model-gateway` only. UI and workspace surfaces do not bypass the gateway or import provider SDKs directly.                                                                                                                                                                                                                                                |
| Workspace containment  | Repository reads and writes stay inside the selected project path and pass through containment and `realpath` checks.                                                                                                                                                                                                                                                                                               |
| Command execution      | Verification and tool execution route through `@oscharko-dev/keiko-tools` terminal-policy allowlists. Arbitrary shell execution is not an approved UI or workspace surface.                                                                                                                                                                                                                                         |
| Patch application      | Generated patches are dry-run by default and require explicit review before application.                                                                                                                                                                                                                                                                                                                            |
| Evidence               | Evidence is redacted before persistence and written only through approved evidence surfaces. Some evidence sub-manifests, including Quality Intelligence and Prompt Enhancement records, are integrity-hashed and fail reads when the hash no longer matches; this is tamper-evident, not tamper-proof, and does not encrypt the underlying local files.                                                            |
| Durable UI state       | Raw secrets, customer data, private logs, and evidence payloads must not be stored in durable UI state. UI persistence may store only approved metadata such as evidence references.                                                                                                                                                                                                                                |
| Undo scope             | Undo/redo must not rewrite evidence, applied patches, verification records, or model-call records.                                                                                                                                                                                                                                                                                                                  |
| Credentials            | API tokens and related secrets are accepted only from local configuration, local environment, or explicit local setup flows. Persisted local credentials (model-gateway API keys, Figma PAT) are sealed with AES-256-GCM in local vaults; `keiko.config.json` holds only references, never plaintext secrets (ADR-0046). They are never returned to the browser, logged intentionally, or serialized into evidence. |
| Memory                 | The memory vault is local-only and uses approved Keiko state locations. Workspace-local memory paths are rejected. Audit events are redacted before persistence.                                                                                                                                                                                                                                                    |
| Feedback submission    | Remote feedback is disabled unless an operator configures one exact HTTPS origin. The local BFF may send only the exact previewed canonical sanitized JSON through `gatewayFetch` to fixed `POST /v1/feedback/reports`; it accepts no user URL/redirect/path/query/credential, original or quarantined unit, local disposition sidecar, file object, raw log, multipart body, or browser-direct request (ADR-0125). |
| Hosted feedback intake | Anonymous intake/receipt operations, redacted queue storage, abuse controls, semantic dedupe, OIDC/server authorization, maintainer review, and GitHub App credentials belong to a separately deployed operator service. They are not `createUiServer` routes or `keiko-server` authentication responsibilities.                                                                                                    |

## Workspace trust-boundary rules

ADR-0030 adds five non-negotiable workspace rules:

1. No UI bypass of the Model Gateway.
2. No escape of workspace path containment.
3. No arbitrary shell commands.
4. No undo rewrite of evidence, patches, verification, or model-call records.
5. No raw secrets or token-bearing artifacts in durable UI state.

These rules are enforced by the existing package boundaries, descriptor validation, terminal policy,
redaction primitives, and architecture/test gates.

## Optional feedback egress and hosted intake

[ADR-0125](adr/ADR-0125-governed-feedback-intake.md) separates two security boundaries:

- **Local Keiko plane.** `createUiServer` stays bound to loopback and owns only report assembly,
  the bounded strict-UTF-8 accepted-text predicate, structural detection, deterministic disposition,
  canonicalization, local recovery sidecar, preview, explicit confirmation, and optional outbound
  call. No hosted queue, OIDC session, maintainer role, remote listener, GitHub App key, or multi-user
  state belongs in `keiko-server`.
- **Operator-hosted intake plane.** A separately deployed service owns the one anonymous submit
  endpoint and a distinct OIDC-authenticated, server-authorized maintainer plane. It stores only
  validated sanitized reports and content-free audit. Each keyed abuse bucket starts at `00:00 UTC`
  with `key_id=YYYY-MM-DD`, closes at the next `00:00`, and expires exactly 48 hours from start (24
  hours after close). Current/immediately previous keys cover every live bucket; the previous key is
  destroyed when its last bucket expires. It never persists or logs a raw IP or forwarding header.
  An independently keyed,
  domain-separated semantic HMAC rotates every 90 days with a versioned UTC activation key id, uses
  one active plus at most two retained keys, and dedupes only the canonical already-sanitized semantic
  projection without refreshing the 180-day digest TTL. A predecessor is destroyed when its final
  digest expires. Approved items alone may reach a narrow, configured-repository,
  issue-create/marker-lookup GitHub App adapter with exactly `Issues: read/write` plus GitHub's
  mandatory `Metadata: read` permission.

Preview and submit use the same immutable canonical bytes and a SHA-256 integrity digest distinct
from semantic dedupe; public prefill/copy maps only the same canonical semantic projection. The
hosted service rejects contract, validation, canonicalization, or sanitization drift instead of
changing the report after preview. V1 is JSON and text-only: local
extraction rejects known PDF/image/archive/executable magic, invalid UTF-8, NUL, prohibited controls,
and unsafe format characters, then omits original bytes, paths, names, and file metadata. Bytes that
pass are accepted text; Keiko makes no broader binary-detection claim. A negative MIME/extension
signal may reject, but `text/plain`, `.txt`, or a rename never establishes safety. Raw logs are
blocked through known-signature rejection and may be replaced only by a handwritten sanitized
summary.

For accepted text, detection and disposition are separate. Redact only complete high-confidence
spans. Ambiguous credential-like content requires structural evidence and quarantines the smallest
safe unit: a complete quoted/structured value, the rest of a line from an unterminated/malformed
value boundary, or—only when needed—an optional field/section or attachment. Preserve safe remainder;
omit an exhausted optional unit and continue; block a required field only when no meaningful safe
content remains. Binary, oversized, raw-log, or structurally unprocessable input remains blocked.
The raw draft/quarantined units stay transient local. Recovery is edit/rescan, optional-unit removal,
or continue with safe omission; no caller or UI can `send anyway`.

The canonical wire contains sanitized values and redaction engine/rule-code/count provenance only.
Its structured `summary.title` and `summary.description` members are scanned and hosted-verified
independently, while one combined 4 KiB UTF-8 cap reserves the two-LF title-to-description display
boundary. This prevents cross-field credential/raw-log composition without weakening residual-content
verification; downstream projections render title before description from those same values.
A digest-paired local-memory sidecar carries closed disposition/reason/unit-kind codes and either a
source draft-field id or snapshotted attachment ordinal for #2073 focus/recovery. It contains no
offsets, excerpts, filenames, paths, or user labels and never enters the request, public prefill,
evidence, logs, diagnostics, or durable UI state. The pipeline is deterministic, idempotent, bounded,
and linear-time; ordinary password-policy/reset prose is preserved without structural credential
evidence. Pattern/literal scanning is not a semantic customer-data classifier, so user preview and
maintainer review remain mandatory.

Every accepted submission, including a dedupe match, receives its own immutable receipt id,
one-time secret, and expiry. The service stores only the secret hash. Fixed
`GET /v1/feedback/receipts/{receiptId}` with `Authorization: Keiko-Receipt <secret>` returns exactly
`{ receiptId, status: "received" | "closed", expiresAt }`; all unknown, expired, malformed, or
mismatched capabilities use one generic `404`.

Feedback retention is bounded by data class: zero durable retention for raw/pre-redaction/quarantined
material and the local disposition sidecar;
90 days for open redacted payloads; 30 days for terminal payloads; 180 days for keyed canonical
redacted dedupe summaries without duplicate-triggered refresh; 365 days for content-free audit; and
exactly 48 hours from bucket start for abuse buckets (24 hours after close). Shorter limits apply to
dead letters and immutable receipt records/secret hashes. Backups age out within 35 days and restores
reapply deletion tombstones. Operators may shorten these ceilings; widening them requires a reviewed
policy decision.

Suspected vulnerabilities do not enter the public feedback path. Route them through the private
GitHub Security Advisory process in [`SECURITY.md`](../SECURITY.md).

## Operator responsibilities

- Run Keiko only on repositories you are allowed to inspect.
- Keep tokens, gateway config files, `.env`, `.keiko/`, and exported evidence out of version control unless your process explicitly requires them.
- Review every proposed diff before applying it.
- Treat evidence and memory diagnostics as review material and handle them under your delivery process.
- Stop immediately if a credential appears in output or evidence.
- Leave remote feedback submission disabled unless the approved intake origin and enterprise egress
  policy are configured; operators of the separate intake service must enforce its retention,
  trusted-proxy, OIDC authorization, repository allowlist, backup deletion, and secret-rotation policy.

## Known limits

- Keiko is not a sandbox and does not provide OS-level isolation.
- Verification can execute repository-authored scripts.
- Evidence and workflow artifacts are ordinary local files. Most are not encrypted; Quality Intelligence and Prompt Enhancement sub-manifests are hash-checked on read for tamper evidence, but a local attacker can still delete, replace, or roll back files outside Keiko's control.
- The workspace foundation does not introduce WebRTC; that surface is not approved.
- Pattern and configured-literal redaction cannot prove that arbitrary customer, proprietary, or
  personal data has been removed.
- Structural disposition may remove benign adjacent text; deterministic smallest-safe-unit rules,
  safe-remainder preservation, and local edit/rescan recovery bound but do not eliminate that risk.
- The local Keiko product is not a hosted web service and does not provide multi-user
  authentication. The optional operator-hosted feedback service is a separate deployment and trust
  boundary, not a supported hosting mode for `keiko-server`.

## Practical rule

Use Keiko as an assistant that prepares reviewable work. Do not use it as an autonomous release,
merge, approval, or secret-handling system.
