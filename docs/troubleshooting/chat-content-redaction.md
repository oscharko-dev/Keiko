# Preserve authorized document content in Chat

Severity: High

## Symptom

Attached or connected documents lose information, or Chat returns `[REDACTED]` inside ordinary
document text or code. The same missing text can remain in the saved answer.

## Root Cause

The default heuristic redactor runs on document context and model answers. Credential-shaped
fields, phone numbers and other matching patterns can remove information the user is authorized
to read. Ambiguous source syntax may also cause a conservative refusal of a larger region.

## Diagnostic Steps

Read the existing Activity Log for the affected request. `chat.request.dispatch` records
`contentRedactionEnabled`; `false` identifies the content-preserving deployment policy. A missing
field on an older installation is not proof that the policy was disabled. Provider completion
events retain source-projection refusal counts. Do not log document text to investigate.

## Resolution

For a deployment whose operator authorizes the configured models to process the selected source
content, set this environment variable on the **Keiko server process before startup**, then restart:

```text
KEIKO_CONTENT_REDACTION=off
```

For example, an npm CLI installation can be started from a shell with:

```bash
KEIKO_CONTENT_REDACTION=off keiko ui
```

Use the same environment setting in the existing service or container configuration when that is
how the installation starts. Setting it only in the browser or in the model server does not affect
Keiko. There is no Settings UI change in this repair.

The setting preserves permitted document context, generated answer content and private saved
grounded answers. It applies to all configured model providers, including any cloud provider added
later; the operator must select a deployment policy appropriate for those destinations. It is not
a complete personal-data anonymizer in either mode. Model-provider policies may independently
affect the answer.

Configured Keiko/provider credential literals, filesystem containment and denied paths, authority
and budgets, tool-argument protections, audit artifacts, diagnostics and support exports retain their
existing protections. They do not inherit the content-policy opt-out.

Re-read/re-attach the original document and generate a new answer. Refresh an existing source index
if its stored context predates the policy change. Existing `[REDACTED]` text cannot be reconstructed
from the saved chat. The original document is not modified.

To restore default content redaction, remove the variable or set it to `on`, then restart. Only the
exact value `off` disables heuristics; unrecognized values retain redaction. Removing the option does
not retroactively rewrite content already stored in private chat history.
