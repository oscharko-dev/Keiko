# Content redaction threshold in Chat

Severity: Medium

## Symptom

Chat, Files or a model answer shows `[REDACTED]` inside ordinary document text or code, for example in
an ISO 20022 message name, a date or a phone number. Or the reverse: a deployment wants more text
removed before it reaches the model.

## Root Cause

Keiko runs on the user's own device and its stores never leave it, so what a person reads and what the
model receives lose only the credential floor by default. `[REDACTED]` then means a credential shape was
removed, or the deployment lowered the threshold with `KEIKO_CONTENT_REDACTION=on`, or the text was saved
by an older version. The strict heuristics also remove phone numbers and anything shaped like one.

## Diagnostic Steps

Read the existing Activity Log first; do not log document text to investigate.

1. At server startup, `chat.content-policy.resolved` records the resolved `policy` (`redact`,
   `preserve`) and the `setting` it came from (`default`, `on`, `off`, `invalid`). A `warn` line
   with `setting=invalid` means the variable was set to an unrecognized value, such as `OFF`,
   `false` or ` off`, and Keiko kept the strict projection.
2. For the affected request, `chat.request.dispatch` records `contentRedactionEnabled`; `false`
   identifies a call that used the preserving policy. Coding Workbench calls always report `false`.
3. Provider completion events retain source-projection refusal counts.

## Resolution

To lower the threshold, set this environment variable on the **Keiko server process before startup**,
then restart:

```text
KEIKO_CONTENT_REDACTION=on
```

For example, an npm CLI installation can be started from a shell with:

```bash
KEIKO_CONTENT_REDACTION=on keiko start
```

Use the same setting in the existing service or container configuration when that is how the
installation starts. Changing it while Keiko runs has no effect until the next start. Remove the
variable or set it to `off` to return to the default. The setting applies equally to internal and
external model providers; if a cloud provider is added, the operator chooses the policy for it. It is
not a complete personal-data anonymizer in either mode.

In every mode Keiko removes configured Keiko/provider credential literals, private keys, credentials
embedded in URLs, `Authorization` header values, encoded-looking `Bearer`/`Basic` values and known API
token shapes. `keiko_research_fetch` arguments leave for the public internet and keep the full
redaction. Evidence, audit records, memory proposals, Quality Intelligence, Coding repository search,
Coding History exports and imports and support exports keep their own redaction. The Activity Log is
the only thing that ever leaves the machine and carries no personal data in any mode. Filesystem
containment, denied paths, authority and budgets are unchanged.

Existing `[REDACTED]` text cannot be reconstructed from a saved chat. Re-read or re-attach the original
document and generate a new answer; the original document is not modified. A preserving Chat uses its
own workspace-index snapshot, so the first connected-folder question after a change may rebuild it.
Lowering the threshold does not rewrite text already stored: history recall and compaction redact it
again, but the most recent turns of a conversation are resent as stored. Start a new conversation if
that matters.
