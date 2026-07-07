# Governed Feedback Intake

Keiko's feedback intake flow is designed for bug reports and product feedback that may include local
diagnostic context. It is not a telemetry stream and it is not a vulnerability disclosure channel.

## User Flow

1. The user creates a local feedback report in Keiko.
2. Keiko validates the report and builds a redacted preview.
3. The preview shows the exact payload that can be submitted.
4. The user submits the preview to the configured intake queue or opens a public GitHub Issue link
   with the same redacted body.
5. Maintainers review, deduplicate, reject, request follow-up, or approve the item for GitHub Issue
   creation.

## What May Be Sent

- Feedback category, severity, title, description, and reproduction steps.
- Expected and actual behavior.
- Bounded, redacted diagnostics such as Keiko version, platform, UI mode, and feature area.
- Bounded attachment summaries or redacted text previews.

## What Is Never Sent

- Raw credentials, API keys, bearer tokens, GitHub tokens, or token-bearing URLs.
- Raw repository contents, prompts, generated patches, or evidence payloads.
- Raw private logs or customer data.
- Hidden fields that were not visible in the preview.

## Security Reports

Suspected vulnerabilities must be reported privately through GitHub Security Advisories:

<https://github.com/oscharko-dev/Keiko/security/advisories/new>

Do not submit suspected vulnerabilities through public GitHub Issues or the general feedback intake
queue before a fix or non-affected decision is available.

## Maintainer Review

Maintainers review redacted intake items before public issue creation. GitHub Issue creation is
allowed only after the item reaches `approved-for-github`. Without a configured GitHub App adapter,
the GitHub creation route fails closed and leaves the redacted intake item unchanged.

The in-app feedback window includes a maintainer review queue backed by the intake API. Queue actions
can request follow-up, reject, archive, approve for GitHub, or create the GitHub Issue after approval.
Duplicate marking is available in the API for automation or richer maintainer tools that can select a
target intake id.

The default in-memory intake service deduplicates by a redacted content signature and rate-limits
submissions per process window. Production deployments should replace or wrap that service with a
durable store and operator-owned abuse-control policy.

## Operator Notes

- Configure the intake endpoint only in environments where outbound feedback submission is allowed.
- Keep GitHub App credentials server-side. They must never be returned to the browser or stored in a
  feedback report payload.
- Treat intake retention, dedupe signatures, and abuse-control thresholds as internal operational
  details.
