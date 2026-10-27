# Preserve authorized document content in Chat

Severity: High

## Symptom

Attached or connected documents lose information, or Chat returns `[REDACTED]` inside ordinary
document text or code. A connected file can also be reported as unavailable because its source
projection was refused. The same missing text can remain in the saved answer.

## Root Cause

The default heuristic redactor runs on Chat document context and model answers. Credential-shaped
fields, phone numbers and other matching patterns can remove information the user is authorized
to read. Ambiguous source syntax may also cause a conservative refusal of a larger region or of a
whole file (`code source redaction is unavailable`).

## Diagnostic Steps

Read the existing Activity Log first; do not log document text to investigate.

1. At server startup, `chat.content-policy.resolved` records the resolved `policy` (`redact`,
   `preserve`) and the `setting` it came from (`default`, `on`, `off`, `invalid`). A `warn` line
   with `setting=invalid` means the variable was set to an unrecognized value, such as `OFF`,
   `false` or ` off`, and Keiko kept the default redaction.
2. For the affected request, `chat.request.dispatch` records `contentRedactionEnabled`; `false`
   identifies a Chat call that used the preserving policy. A missing field on an older
   installation is not proof that the policy was disabled.
3. Provider completion events retain source-projection refusal counts.

## Resolution

For a deployment whose operator authorizes the configured models to process the selected source
content, set this environment variable on the **Keiko server process before startup**, then restart:

```text
KEIKO_CONTENT_REDACTION=off
```

For example, an npm CLI installation can be started from a shell with:

```bash
KEIKO_CONTENT_REDACTION=off keiko start
```

Use the same environment setting in the existing service or container configuration when that is
how the installation starts. Setting it only in the browser or in the model server does not affect
Keiko, and changing it while Keiko runs has no effect until the next start. There is no Settings UI
change in this repair. Confirm the startup `chat.content-policy.resolved` line shows
`policy=preserve`.

The setting applies to Chat only: plain conversations, connected folders, Knowledge Pods and
multi-source or hybrid answers, including their private saved answers. It applies to all
configured model providers, including any cloud provider added later; the operator must select a
deployment policy appropriate for those destinations. It is not a complete personal-data
anonymizer in either mode. Model-provider policies may independently affect the answer.

Even with the setting, Keiko still removes configured Keiko/provider credential literals, private
keys, credentials embedded in URLs, `Authorization` header values, encoded-looking
`Bearer`/`Basic` values and known API token shapes; the model is told never to reconstruct such
text. The Coding Workbench and its repository search, compaction summaries, memory proposals, filesystem containment and denied paths, authority and budgets,
tool-argument protections, audit artifacts, diagnostics and support exports retain their existing
protections. They do not inherit the content-policy opt-out.

Re-read or re-attach the original document and generate a new answer. A preserving Chat uses its
own workspace-index snapshot, so the first connected-folder question after the change may rebuild
it. Existing `[REDACTED]` text cannot be reconstructed from the saved chat. The original document
is not modified.

To restore default content redaction, remove the variable or set it to `on`, then restart. Only the
exact value `off` disables heuristics; unrecognized values retain redaction and log a warning.
Removing the option does not retroactively rewrite content already stored in private chat history:
history recall and compaction redact it again, but the most recent turns of a conversation that was
continued from the opt-out period are resent as stored. Start a new conversation if that matters.
