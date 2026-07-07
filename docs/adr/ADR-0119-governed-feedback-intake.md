# ADR-0119: Governed Feedback Intake And Review Queue

## Status

Accepted for implementation planning. Authored for Epic
[#2070](https://github.com/oscharko-dev/Keiko/issues/2070).

## Context

Keiko needs a bug-report and product-feedback path that works for public open-source users, users
without GitHub accounts, and regulated environments where raw local logs, repository paths, evidence
payloads, prompts, credentials, or customer data must not be sent to a public issue tracker.

The existing security model is local-first and review-oriented: the UI binds to loopback only,
productive model calls stay behind the Model Gateway, workspace reads remain contained, evidence is
redacted before persistence, and GitHub provider operations use narrow governed gateways. A feedback
feature must preserve that posture rather than become a telemetry pipeline.

## Decision

### D1 - The local report preview is the submission contract

Keiko builds a local `FeedbackReportDraft`, validates it through the shared contracts package, and
then produces a `FeedbackReportPreview`. The preview is the exact payload that may be submitted. The
browser must not submit a hidden raw payload that differs from the preview.

### D2 - Redaction provenance is required

Every intake submission must carry `FeedbackRedactionProvenance` with the engine
`keiko-feedback-redaction`, the schema version, redacted field names, omitted field names, and any
blocked reasons. The intake API rejects submissions without this provenance.

### D3 - Intake stores redacted review material only

The intake queue stores redacted reports, receipt metadata, dedupe keys, review state, and optional
GitHub issue references. It does not store raw logs, raw evidence payloads, credentials,
token-bearing artifacts, or hidden unredacted attachments.

### D4 - GitHub Issue creation is maintainer-approved

The GitHub App path is a separate adapter behind the review queue. Users can open a public GitHub
Issue link from the local redacted preview, but Keiko does not automatically create public GitHub
Issues from intake submissions. Maintainers must approve an intake item before the GitHub App adapter
can create an issue.

### D5 - Vulnerability reports remain private

Suspected vulnerabilities continue to use GitHub Security Advisories. The feedback flow must present
that routing clearly and must not encourage security reports in public issues or general intake.

## Consequences

Positive:

- Users can inspect exactly what leaves the local UI.
- Maintainers receive deduplicated and reviewable reports from GitHub and non-GitHub users.
- GitHub App credentials remain server-side and never enter the browser or report payload.

Negative:

- Maintainers must operate an intake queue before creating public issues.
- The first implementation uses a conservative structured payload, so highly customized report
  formats require later schema extensions.

## Verification

- Contract tests cover parsing, redaction provenance, blocked payloads, review transitions, and
  GitHub issue draft synthesis.
- Server tests cover preview, submit, list, review, and GitHub adapter disabled paths.
- UI tests must prove the visible preview and submitted payload are identical.

## Related

- `SECURITY.md`
- `docs/security-and-audit-boundaries.md`
- ADR-0022: Connected Context Privacy Contract
- ADR-0038: Shared proxy- and custom-CA-aware outbound HTTP egress
- ADR-0086: Governed GitHub Pull Request Gateway and Metadata Orchestration
