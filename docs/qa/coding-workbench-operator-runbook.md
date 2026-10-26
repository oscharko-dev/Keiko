# Coding Workbench Operator Runbook

Status: current operator and maintainer runbook. ADR-0125 supersedes the original Epic #1982
blanket-write semantics.

## Purpose

Use this runbook when reviewing or operating the Coding Workbench. The workbench is a governed coding
surface, not a background daemon. Browser UI, sidecar runtime, model routing, repository writes,
connector writes, and evidence stores remain separated by Keiko-owned contracts.

## Operating Modes

The machine values remain stable for wire compatibility. Operators use the three display labels
(semantics per
[ADR-0138](../adr/ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)):

<!-- The first table row below is byte-pinned by codingAutonomyQaMatrix.test.ts; keep its exact
     single-space cell padding, so the table is excluded from Prettier's column alignment. -->
<!-- prettier-ignore -->
| Display mode | Machine value | Allowed without another prompt | Approval required |
| --- | --- | --- | --- |
| **Ask for approval** | `governed-assist` | Reads and planning | Workspace edits and commands, external files, internet, and delivery at every risk |
| **Supervised workspace** | `supervised-coding` | Low/medium-risk workspace-contained edits, vetted commands, and verification | High/critical-risk workspace-contained actions; external files, internet, and delivery at every risk |
| **Full access** | `autonomous-delivery` | Workspace, external-file, and internet actions inside the validated Authority Envelope | Delivery at every risk |

Mode selection never overrides the effective-mode deployment ceiling, Authority Envelope,
workspace and branch scope, deny lists, secret-exfiltration checks, platform restrictions, expiry,
or budgets. An unknown or missing mode falls back to **Ask for approval**; missing, invalid, or
expired required authority is denied.

Commit, push, pull-request creation, and merge are delivery actions. They use the governed delivery
gateways and require separate explicit human approval in all three modes. **Full access** does not
authorize force-push, branch escape, or connector mutation outside declared task references and
scopes.

## Runtime And Model Routing

- The bundled OpenCode-compatible path launches from Keiko-managed sidecar payloads under the
  portable-managed install root.
- Customer machines must not require a global OpenCode install for the bundled path.
- Managed provider and API-key traffic goes through the local Keiko Model Gateway endpoint.
- ChatGPT/Codex subscription traffic uses the separate Codex runtime/profile path and must never be
  projected into OpenCode as provider credentials.
- Browser code must not read provider endpoints, API keys, subscription tokens, raw auth files, sidecar
  executable paths, or customer repository paths.

## Authority Envelope Checklist

Before any governed coding run starts, verify:

- The task reference names the issue being worked.
- The base and head branches match the intended branch pair.
- Allowed prefixes cover only the intended issue branch family.
- The requested and effective mode match the intended display mode and deployment ceiling.
- The runtime source is appropriate for the task; delivery work uses `delivery-runner`.
- The model source is `keiko-model-gateway` for the managed sidecar path.
- Action classes include only the authorities needed for the run.
- Connector scopes include only the target source-control or issue-tracker scopes.
- The network policy is connector-scoped egress, not broad browser access.
- Gates include the human-confirmed envelope and every action-specific branch, verification, and
  policy gate required by the granted classes.
- The approval proof digest matches the operator-confirmed envelope.
- The expiry and budgets are short enough for the bounded run.

## Stop And Takeover

- The operator can stop a running sidecar from the workbench.
- A stopped run records content-free stop status and must not continue writing files, commands, git
  state, connector state, or PRs.
- Manual takeover means the operator continues outside the run's Authority Envelope; any later
  automation must start from a fresh envelope and fresh verification.
- If verification fails, automated delivery stops before PR handoff.
- If policy denies a scope, the correct recovery is to adjust the envelope or mode deliberately, not
  to retry through a lower-level tool.

## Evidence Rules

Evidence may contain:

- Schema version, run id, mode, runtime source, model source, artifact label, safe summary, digest,
  denial flag, counts, and content-free state labels.

Evidence must not contain:

- Raw prompts, raw model output, raw diffs, repository file contents, command stdout/stderr, issue
  bodies, PR bodies, provider endpoints, credentials, private URLs, token-bearing strings, or private
  filesystem paths.

## Context and cumulative prompt allowance

The selected model's context allowance limits one model request. OpenCode compaction reduces
conversation history for subsequent requests; it does not erase the prompt tokens already consumed
by a run. The run's Authority Envelope independently accounts for cumulative prompt usage and for
elapsed time. Every turn re-sends the whole conversation, so cumulative usage grows with the square
of the turn count: in the live Gemma qualification (#3873) an ordinary six-file ESLint repair on a
slow self-hosted model reached 200,000 cumulative tokens in 17 turns and 27.5 minutes with no
refused edit.

Two operator settings bound every newly minted envelope. Set them before starting the server; both
are read once when the coding runtime is composed, before it activates, so a running Keiko keeps its
old value until it is restarted (the Workbench's limit messages say so, and name the maximum below).
An invalid value, or one above the maximum, stops that composition with a `RangeError` instead of
minting a silently defaulted envelope (fail closed):

| Setting                                     | Meaning                                            | Default   | Accepted values                       |
| ------------------------------------------- | -------------------------------------------------- | --------- | ------------------------------------- |
| `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS`    | Cumulative prompt-token allowance of one run       | 2,000,000 | decimal integer 1 through 20,000,000  |
| `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES` | Envelope duration (`maxRuntimeMs` and `expiresAt`) | 120       | decimal integer 1 through 480 minutes |

Both are copied into each newly minted envelope and reported body-free as `maxPromptTokens` and
`maxRuntimeMs` on the existing `coding-runtime.authority.minted` activity event. Neither changes a
live or exhausted envelope, the tool/patch ceilings, or a configured Model Gateway spend limit. The
safe-activity feed is retained for the configured duration plus a margin, and one submitted task's
whole agent loop is bounded by the same duration; per-request provider deadlines are unchanged. A
run that exhausts either bound fails closed at its next delegation
(`coding-sidecar.gateway.rejected` with `runtime-prompt-budget-denied`, or an expired authority); it
requires a fresh accepted run and preserves its workspace through normal recovery. Lower a bound
deliberately for a constrained deployment; the former 200,000-token / 30-minute defaults ended
ordinary multi-file work on a slow self-hosted model.

A run that ends on one of its bounds settles `failed` with a cause of its own instead of an internal
error (#3873, ADR-0137 D3): `prompt-allowance-exhausted` when the allowance refused its last model
call, `envelope-duration-exhausted` when its envelope ran out of time (`coding-runtime.run.settled`
with `failureBasis` `prompt-allowance` or `envelope-duration`), and the Workbench names the bound and
the next step. The same settled line carries the run's effort roll-up (`wallDurationMs`,
`modelTurnCount`, `promptTokensTotal`, `toolInvocationCount`, `editRefusedCount`, `operatorWaitMs`
and the other counts and durations of ADR-0137 D3), so a bound a run used up can be read against the
model turns and tool calls that used it.

The output allowance of one model request (`maxOutputTokens` on
`coding-sidecar.gateway.request-validated`, and OpenCode's `limit.output`) is not an operator
setting; it is derived by this rule (#3873, F17): a coding turn reserves at least 16,384 output
tokens unless the provider-declared `max_output_tokens` (LiteLLM's `/model/info`, or the operator's
model configuration) or the prompt-admission arithmetic (`maxPromptTokens` minus the estimated
prompt minus the safety margin) is smaller, and never more than a quarter of the model's window.
Before this rule a coding turn was sent the shared chat profile's reserve (one sixteenth of the
window, 8,192 of 131,072 tokens), which a reasoning model spent before its first tool call; chat and
every other surface keep that chat reserve. A reasoning model that spends the whole
allowance without a tool call gets one steered repair from the gateway
(`gateway.retry.scheduled reason=output-exhausted-repair`); a second exhaustion ends the turn as
final (`coding-sidecar.gateway.turn-failed failureCode=output-exhausted runtimeRetry=refused
repairOutcome=exhausted-again`). See the LiteLLM troubleshooting entry "Coding Workbench turn
reasons until its output budget is exhausted". A turn that ends after reasoning with no tool call or
text gets the same one repair (`reason=empty-answer-repair`, a second empty answer is final with
`repairOutcome=empty-again`, and the sidecar never resends a failed turn's reasoning upstream), see
"Coding Workbench turn ends after reasoning without a tool call or text, again and again" (#3873, F23).

## Repository working instructions

A run reads the task workspace's own `AGENTS.md` (workspace root only, exact name, no symlink)
through the secure read helper only while the run's own workspace is the active one (a workspace
switch while the run starts records `refused`, `workspace-unavailable`). The text first passes the
canonical model-safe projection of workspace text, so credentials in the file never reach the model
(a file that projection cannot handle is `refused`, `redaction-unavailable`). It is then bounded to
the first 800 lines and 16,384 bytes, with one explicit truncation line when cut, and labelled as
repository-authored and untrusted: it grants no authority (ADR-0137 D1).

- **Native profile.** The bounded copy is written to the run's private configuration as the pinned
  2.1.4 producer's global instruction file, which its own instruction plugin loads and watches.
  Keiko refreshes the copy before every turn, so an edit, a file `init` creates and a removal reach
  the next model call. The producer's `read` still loads nested `AGENTS.md` files.
- **Mapped profiles.** The bounded text rides in the first message, nonce-framed so it cannot close
  its frame early or be forged by an issue body or memory.

It is on by default; an operator sets `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` before
starting the server to disable it, and any other explicit value fails closed at composition. The
`coding-runtime.repository-instructions.context` activity event records each read (`attached`,
`truncated`, `absent`, `disabled`, `refused`) with byte and line counts and the file's own digest,
never the content. Files above the helper's 1 MiB content ceiling are refused as `too-large` (at
`warn`, the run proceeds).

## Accepted external references

A native run on macOS can read directories outside its workspace only when the operator accepted
them before starting the server: `KEIKO_CODING_EXTERNAL_READ_ROOTS` names absolute directories,
separated like `PATH`, at most 8 (ADR-0137, #3900 AC5). They are read-only. The whole set is
admitted or none of it: an entry that is not an existing directory reached without a symbolic link,
a top-level or home directory, one that overlaps the workspace or Keiko's private state, or one
inside a credential store refuses all of them. `coding-runtime.native-external-roots.resolved`
records the outcome per run with a closed reason and counts, never a path. The producer lists each
accepted root as a local reference (`external-1`, …) and tells the model; each read there is an
external-file action of the run's mode (asked in Ask for approval and Supervised workspace, allowed
in Full access), and credential files, hard links and writes stay refused. On Linux no external
root is admitted yet (`unsupported-platform`).

## Web search

A native run's `websearch` reaches a search integration only when the operator admitted one before
starting the server: `KEIKO_CODING_WEBSEARCH_ENDPOINT` names an Exa-style MCP endpoint (for
example `https://mcp.exa.ai/mcp`), https, or http on the loopback interface for a search service on
the same machine; `KEIKO_CODING_WEBSEARCH_API_KEY` optionally carries its key, which stays in the
server and never reaches the run (#3903 AC3); a result in which the service echoes it reaches the
run without it. An endpoint with credentials in its URL, a fragment,
or plain http to another host admits nothing. The search runs in Keiko's server through the
deployment's proxy and CA settings, for the exact query the run's policy just allowed; it is
available in Full access, like `webfetch`, and refused below it. Without an admitted integration
the policy refuses `websearch` in every mode and names `webfetch` of a known URL instead.
`coding-runtime.websearch.performed` records each search's outcome, result count, response size and
duration, never the query, a result or the endpoint.

### Hard links in the workspace

Before every native launch Keiko scans the workspace and each accepted external reference for
regular files with more than one hard link. Such a file can be a second name of a file outside the
task, so the kernel profile denies its contents to every process of the run (search, read, shell);
it stays visible in listings. This includes the object files a local `git clone` hard-links from
its source: Git in such a clone cannot read them inside the run, so give the clone its own objects
first (`git repack -a -d`, or clone with `--no-hardlinks`).
`coding-runtime.linked-files.resolved` records the scanned, linked and Git-object counts. A launch
refused with `workspace-unqualified` and reason `linked-files-excessive` found more than 1,024
linked files (typically a package store configured to hard-link into `node_modules`; use the
default clone or copy import), and `linked-files-unscanned` means the tree could not be walked
completely (more than two million entries or an unreadable entry); the run does not start on a
partial list.

## Repository agents, commands and skills

On the native profile a run admits the workspace's Markdown-only items as sanitized copies in its
private discovery directory (ADR-0137 D10, #3903): custom agents from `.opencode/agents` and
`.opencode/agent`, custom commands from `.opencode/commands` and `.opencode/command`, and skills
from `.opencode/skills`, `.opencode/skill` and `.agents/skills` (`<name>/SKILL.md` only). Each file
is read through the secure read helper while the run's own workspace is the active one, its
frontmatter is validated against a closed allowlist and rendered anew (`model`, permissions, tools,
MCP and plugin keys never survive), and the copy is written before the runtime starts. The
`agents`/`agent` and `commands`/`command` sections of the project's `opencode.json` (or
`.opencode/opencode.json`) and their `.jsonc` variants become the same items. JSONC supports
comments and trailing commas; malformed files are refused whole. Other keys (providers, model,
permissions, plugins, MCP, ...) are dropped, and an agent entry with `permission`, `permissions`
or `tools` is refused rather than admitted unrestricted. Plugins, nested
discovery and `.claude/` stay unloaded, except a skill's `.claude/skills/<name>/SKILL.md`, which is
admitted like the other skill directories. A command whose template contains a shell-substitution
block is refused. Limits: 16
agents, 32 commands and 16 skills of at most 32 KiB each; names lowercase with hyphens and not a
built-in (`build`, `plan`, `general`, `explore`, `init`, `review`, `opencode`, `report`, ...).

Global JSONC shares the project configuration parser and the existing owner-private descriptor reader. Both admitted producers (2.0.10 and 2.1.4) merge `opencode.json` followed by `opencode.jsonc`; neither loads `config.json`. Malformed JSONC is refused as a whole. Objects with parser-created non-standard prototypes are refused at every depth.

It is on by default. An operator sets `KEIKO_CODING_REPOSITORY_ITEMS_ENABLED=false` before starting
the server to disable it; any value other than `true` disables it. Each native run records one
body-free `coding-runtime.repository-items.admitted` line (`disabled`, `unavailable`, `empty`,
`completed` or `failed`, with admitted and refused counts per kind, the closed refusal reasons, the
stripped-key counts and a digest of the copies, never a name or a body). To see why an item did not
appear, read its `refusalReasons`: `invalid-name`, `reserved-name`, `duplicate-name`,
`frontmatter-malformed`, `frontmatter-unsupported`, `value-invalid`, `description-missing`,
`body-empty`, `unsafe-characters`, `oversize`, `template-shell-substitution`, `agent-not-admitted`,
`name-mismatch`, `not-regular-file`, `unreadable`, `directory-unreadable`, `limit-exceeded`,
`restriction-unrepresentable`, `config-malformed` or `config-unsupported-format`.

## Remote skill sources

A native run can use skills published on a team server, the way OpenCode's `skills` setting pulls a
remote skill index. Keiko pulls them itself, only for a run launched in **Full access**, from the
sources the operator names in `opencode-skill-sources.json` in Keiko's state directory (owned by the
user Keiko runs as, `chmod 600`; a missing file means no remote source):

```json
{ "schemaVersion": 1, "sources": [{ "url": "https://skills.example.com/team/" }] }
```

- At most 4 `https` sources, without credentials, query or fragment.
- Each source publishes `index.json` (`{ "skills": [{ "name": "release", "files": ["SKILL.md"] }] }`)
  and each skill's `SKILL.md` below `<source>/<name>/`, as OpenCode expects. Keiko reads only the
  index and `SKILL.md`, through its own proxy and CA settings, never following a redirect or reaching
  a loopback or private address. Sibling files are not copied, as for a repository skill.
- Every `SKILL.md` passes the same checks as a repository skill (closed frontmatter, `name` and
  `description` kept, everything else dropped); at most 16 remote skills per run, 32 KiB each. A
  name the repository already uses stays the repository's.
- The Activity Log records `coding-runtime.remote-skills.admitted`: one registry line (`absent`,
  `registry-refused`, `mode-restricted`, `failed`) or one line per source (`admitted` with counts and
  closed refusal reasons, `index-invalid`, `source-failed`), with a digest of the source, never its
  address or a skill name.

## OpenCode plugins

A plugin is code the runtime runs inside its own process, so a repository can never register one.
An operator who trusts a local plugin registers it in `opencode-plugins.json` in Keiko's state
directory, with the same ownership rules as `mcp-servers.json` (owned by the user Keiko runs as,
`chmod 600`; a missing file means no plugin). Changes apply to the next run.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "audit",
      "path": "/opt/keiko/plugins/audit.js",
      "sha256": "<the output of: shasum -a 256 /opt/keiko/plugins/audit.js>"
    },
    {
      "name": "lint",
      "workspacePath": ".opencode/plugins/lint.ts",
      "sha256": "<the SHA-256 of that file's exact bytes>"
    }
  ]
}
```

- An npm plugin package is installed by the operator into a directory of its own and registered
  with its entry module: `npm install --prefix /opt/keiko/plugins/lint opencode-lint`, then
  `{ "name": "lint", "path": "/opt/keiko/plugins/lint", "entry":
"node_modules/opencode-lint/dist/index.js", "sha256": "<tree digest>" }`. The tree digest is
  printed by `cd /opt/keiko/plugins/lint && find . -type f -print0 | LC_ALL=C sort -z | xargs -0
shasum -a 256 | shasum -a 256`; any change to any file of the package needs the new digest.
  Keiko copies the whole tree, so the package's own dependencies resolve; links are not copied.
- A plugin loads only in a run launched in **Full access**; Ask for approval and Supervised
  workspace load none. Per-action approval cannot govern code that runs inside the runtime.
- `name` is lowercase letters, digits and `-`, not starting with `keiko`; at most 8 plugins. The
  source is either an absolute `path` the operator installed or a `workspacePath` inside the
  run's workspace, a `.js`, `.mjs` or `.ts` file of at most 512 KiB.
- `sha256` pins the exact file: a changed file is refused until the registry names its new digest.
  A single-file plugin must be one self-contained module (its own relative imports do not travel
  with the copy; register it as a package instead), and only the public `setup` plugin form loads.
- The plugin's permission hooks may only make a decision stricter; they can never allow what Keiko
  refuses or asks for. Beyond that, an admitted plugin is trusted code bounded by the run's sandbox
  and Keiko's server-side authority, like the runtime itself.
- A plugin that claims the identity of one of Keiko's own plugins (`keiko.native-policy`, ...)
  stops the run from becoming ready.
- The Activity Log records `coding-runtime.operator-plugins.admitted` per run (`absent`,
  `registry-refused` with a closed reason, `mode-restricted`, `admitted` or `failed`, with counts,
  the per-plugin refusal reasons `digest-mismatch`, `unreadable`, `too-large` or
  `workspace-unavailable`, and a digest of the admitted set).

## MCP servers

A native run admits only the MCP servers the operator names in `mcp-servers.json` in Keiko's state
directory (the directory that holds the UI database). The file must belong to the user Keiko runs
as and must not be group- or world-writable (`chmod 600`); a missing file means no MCP server.
Changes apply to the next run.

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "name": "docs",
      "description": "Internal documentation search",
      "transport": {
        "kind": "local",
        "command": ["/opt/tools/bin/docs-mcp", "--stdio"],
        "environment": { "DOCS_INDEX": "/srv/docs" }
      },
      "tools": { "search": "read", "page.update": "write" }
    }
  ]
}
```

- `name` is a lowercase word without `_`; at most 16 servers and 64 tools each.
- A local server's command starts with an absolute executable; arguments and variables are
  literal. `{env:…}` and `{file:…}` placeholders are refused, and no secret belongs in this file.
- A remote server (`"kind": "remote"`, an `https` URL) is used only in Full access.
- A remote server that needs OAuth names the authorization server it expects:
  `"transport": { "kind": "remote", "url": "https://issues.example.com/mcp", "oauth": { "issuer":
"https://login.example.com", "clientId": "keiko", "scope": "issues.read" } }`. `issuer` is
  required and must be exactly the issuer identifier the authorization server publishes (https, no
  query or fragment, no trailing slash added); `clientId` and `scope` are optional (without a
  client id the runtime registers a client dynamically). Never put a client secret or a token in
  the file. Before each run Keiko reads that issuer's metadata (RFC 8414, then OpenID Connect) and
  leaves the server out unless the document names exactly that issuer, uses https endpoints and
  offers PKCE (S256); `mcp.oauth.issuer.checked` says why (`issuer-mismatch`, `insecure-endpoint`,
  `pkce-unsupported`, `registration-unavailable`, `not-found`, `unreadable`).
- A remote server that needs a static credential (an API key or a personal access token) names
  each header it expects and the variable of Keiko's own environment that holds the value:
  `"transport": { "kind": "remote", "url": "https://wiki.example.com/mcp", "headers": {
"Authorization": { "secretEnv": "KEIKO_MCP_SECRET_WIKI", "prefix": "Bearer " } } }`. Set
  `KEIKO_MCP_SECRET_WIKI` in Keiko's environment; only variables starting with
  `KEIKO_MCP_SECRET_` can be named, at most 8 headers, and `prefix` is optional literal text. The
  value never reaches the run: the runtime connects to Keiko's relay on its own loopback port with a
  capability for that run and that server, and Keiko adds the header and forwards each request to
  exactly the registered URL through its egress (no redirect, no loopback or private target). A
  server that answers with the credential it received has it replaced by `[REDACTED]` before the
  run reads the answer, however its JSON, URL, HTML or base64 text spells it; a server that puts it
  into a response header is refused (`credential-in-response-header`), and a response that keeps
  an incomplete spelling open for more than 256 Ki characters is cut off where it is
  (`credential-spelling-unbounded`). A server whose variable is unset or holds a line break is left
  out of the run (`secret-unavailable`, `secret-invalid`), and so is one whose credential has fewer
  than 16 characters (`secret-too-short`): the relay could not tell a shorter value apart from
  ordinary text, or find it inside base64. `headers` and
  `oauth` cannot be combined. The Activity Log records `coding-runtime.mcp-relay` (bound with
  relayed and refused server counts, then one line per relayed request with method, status,
  sizes, the number of replaced credential occurrences and duration), never the value, the URL or
  the server name.
- To authorize, open the run's **MCP servers** section in the Workbench and choose **Authorize** on
  the server that needs it, then **Open the authorization page**: it opens in a new tab, and the
  runtime completes the sign-in on its own loopback callback. Keiko shows the page only when it
  belongs to the expected issuer; otherwise the attempt is withdrawn and the section says so.
  The credential is kept, sealed, in Keiko's state directory (`credentials/`, key from
  `KEIKO_MCP_OAUTH_CREDENTIALS_KEY`, the macOS keychain or a key file) and used by later runs
  without asking again. Changing the server's URL, issuer or client id in the registry requires a
  new authorization. The Activity Log records `coding-runtime.mcp-authorization` (started,
  status, refused with a closed reason) and `coding-runtime.mcp-credentials` (seeded, kept,
  removed), with counts only.
- Every tool the model may call is named with `read` or `write`. A tool the file does not name is
  refused. Ask for approval asks before an MCP tool; Supervised workspace allows `read` tools and
  asks before `write` tools; Full access allows both.
- The server starts with an empty environment plus `PATH`, the run's private `HOME` and its own
  variables, inside the run's sandbox.
- The Activity Log records `mcp.registry.loaded` per run (`absent`, `loaded` or `refused` with a
  closed reason) and `coding-runtime.native-policy.decided` with `permission: mcp` per call.

## Review Commands

Run focused closeout checks:

```sh
npx vitest run \
  packages/keiko-server/src/coding-runtime/codingAutonomyQaMatrix.test.ts \
  packages/keiko-server/src/gitDelivery/runBoundAuthority.test.ts \
  packages/keiko-server/src/gitDelivery/approvalStore.test.ts \
  packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts \
  packages/keiko-server/src/coding-sidecar-gateway.test.ts \
  packages/keiko-server/src/coding-codex-subscription.test.ts
npm run test:e2e:coding-workbench-1994
```

Run the user-facing receipt command before child merge:

```sh
.keiko-scripts/ui-verify-receipt.sh 1994 -- npm run test:e2e:coding-workbench-1994
```

Run the final integrated user-facing receipt after #1994 is merged into the epic branch:

```sh
.keiko-scripts/ui-verify-receipt.sh 1982 -- npm run test:e2e:coding-workbench-1994
```

## Handoff Policy

- Keep #1982 open and In Progress until all child issues are closed and the draft epic PR exists.
- Close child #1994 only after its PR has merged into `epic/coding-workbench-opencode-codex` and
  closure evidence is posted.
- Open the final epic PR to `dev` as a draft. Do not mark it ready until the updater v2 epic is
  merged into `dev` and the operator explicitly approves the transition.
- Do not merge the epic PR to `dev` without explicit human authorization.
