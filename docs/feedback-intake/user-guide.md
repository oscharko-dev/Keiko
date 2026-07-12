# Reporting a Keiko finding

This guide is for developers and other Keiko users who want to report a reproducible defect or
user finding. It explains what leaves the local machine, how to review it, and which route to use
for security reports. The [privacy contract](privacy-contract.md), [threat model](threat-model.md),
and [ADR-0134](../adr/ADR-0134-governed-feedback-intake.md) are the normative references.

## Choose a reporting route

Keiko offers two explicit, user-controlled routes:

1. **Configured operator intake.** Keiko prepares a bounded, sanitized report locally and shows the
   exact payload. Nothing is sent until you choose **Submit**. The operator's intake service returns
   a receipt that you can keep for a coarse received/closed status check.
2. **Public GitHub form.** Keiko opens the fixed public user-finding form with a bounded prefill, or
   offers sanitized text to copy into the form. You still submit the form on GitHub.

If operator intake is not configured, the submit action is unavailable. This is expected and does
not send telemetry.

## Review the exact outbound content

The preview is the submission contract. Keiko serializes the sanitized report once as canonical
UTF-8 JSON and displays every field. Only the exact bytes represented by that preview are sent,
and only after you explicitly confirm **Submit**. Keiko does not add paths, filenames, environment
values, timestamps, correlation identifiers, diagnostics, or attachments at submit time. Editing a
field or attachment requires a new preview and confirmation.

Review the complete preview, including evidence text, before choosing a destination. The deterministic
safety checks reduce common credential and file-content mistakes; they cannot recognize every
customer identifier, proprietary fact, or business-sensitive statement. You remain responsible for
the residual customer-data risk in text you approve.

### What is never sent

The feedback flow never sends or persists as intake data:

- raw drafts, quarantined text, or rejected content;
- original attachment bytes, binary files, multipart uploads, or parsed file metadata;
- filenames, local paths, extensions, MIME declarations, timestamps, permissions, ownership,
  archive entries, or file hashes;
- automatically collected logs, raw log files, stack traces, or unredacted diagnostics;
- API keys, tokens, passwords, private keys, cookies, local Keiko credentials, or authorization
  headers;
- repository contents, customer records, private screenshots, model credentials, internal
  endpoints, or maintainer instructions;
- local disposition details such as offsets, excerpts, labels, or the recovery sidecar.

## Evidence attachments are text only

You may attach up to the limits shown by the form when the selected content satisfies the accepted
text predicate. Keiko reads a bounded candidate locally, validates strict UTF-8 and safe controls,
checks known binary and raw-log signatures, applies deterministic redaction/disposition, and places
only the resulting text in the preview. A `.txt` name or `text/plain` declaration does not make
unsafe bytes safe. Binary files, archives, images, PDFs, multipart content, raw logs, invalid text,
and over-limit candidates are rejected rather than transformed.

If the safety pass asks for a rewrite or omits an attachment, write a short, sanitized evidence
summary. Do not paste the original log or use a “send anyway” workaround; no such bypass exists.

## Public GitHub form

The public alternative uses the fixed form at
`https://github.com/oscharko-dev/Keiko/issues/new?template=user_finding.yml`. Keiko may prefill
only the approved sanitized fields. If the encoded URL would be too long, it opens the empty form
and offers the same sanitized, field-labelled text for manual copy.

Prefilled values are part of the URL before GitHub receives the form. URLs can be retained in browser
history, proxy history, bookmarks, screenshots, or referrer records. Review the address bar and
remove anything you do not want in that history before continuing. A local safety pass is not proof
that publishing is appropriate; review the GitHub form and its safety attestation yourself.

## Security vulnerabilities

A suspected vulnerability is not ordinary feedback. Stop the public or operator intake flow and
follow the private disclosure process in [`SECURITY.md`](../../SECURITY.md), using GitHub Security
Advisories. Do not put vulnerability details, exploit steps, credentials, or sensitive customer
material in a public issue or feedback receipt.

## Further reading

- [Privacy contract](privacy-contract.md) — exact data-flow and retention rules.
- [Threat model](threat-model.md) — limits, residual risks, and stop conditions.
- [Review-state contract](review-state-contract.md) — maintainer disposition and publication rules.
- [GitHub App configuration](github-app-configuration.md) — operator publication setup.
