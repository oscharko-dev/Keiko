# Owner decisions: long form

The full text of standing owner decisions and product constraints that [`AGENTS.md`](../AGENTS.md)
§1 summarizes in one or two lines each. The text moved out of AGENTS.md on 2026-11-23 without
content changes. Read the matching entry before you change that area. Where an ADR is named, the
ADR is the architectural record; this page keeps the binding detail agents previously found in
AGENTS.md.

## Repository credential relay (2026-11-22)

In every mode a native Coding run reads dependencies from the Maven and npm repositories the person
configured, through Keiko's repository credential relay (owner decision 2026-11-22, ADR-0184 D6).
Below Full access it is the one path to those repositories, beside the read-only Maven cache, and
gives the run no network route of its own: Keiko makes the read. The build command keeps its mode's
disposition; the relay read itself needs no approval.

## Coding Workbench availability and Memory learning (2026-09-27)

A normal installation offers all
three modes without extra configuration; its Coding ceiling defaults to `autonomous-delivery`.
The selected mode defaults to **Ask for approval**, and a saved human mode selection remains a
selection, not an installation side effect. Explicitly configured narrower ceilings still apply;
invalid explicit values fail closed. This availability default is scoped to Coding: Memory retains
its explicit deployment ceiling or `governed-assist` for its mode and standing maintenance; only an
explicitly configured `governed-assist` ceiling holds routine facts for review (#4206). See ADR-0124 D2 and ADR-0163 D7. A person's own clear "Merke dir" or "Vergiss das" in a Chat is
their decision, not unattended learning: it acts at once in every mode, after the hard denials
(ADR-0146 D4b). Routine private facts learned from natural conversation are used without approval in every mode
(team and project facts keep the mode rule until project memory), and a correction replaces the old
fact; confidential content is refused. Deterministic checks on the
person's own words admit them, and they never replace a clear statement (ADR-0146 D2, D4c).

## Files and Editor folder bindings

Explicit Files/Editor folder selections use the existing `coding-repository` presentation
binding for Git repositories and ordinary folders alike. Task-bound windows retain the active
workspace override and navigation within that root. Never let a Files title name a configured
root while its tree shows a different resolved root. Folder navigation and reads record body-free
client stage lifecycle evidence on the existing Activity Log (ADR-0090 D4).

## Ordinary Editor scope (2026-10-03)

The Editor is a human-operated file
editor. Its agent presence/history, incoming action execution, and Editor/Chat handoffs are
retired. Preserve manual file operations and the ownership-bound, content-free dirty-buffer
safety state; that state must never make the Editor discoverable or executable as an agent
session. Chat repository search and the separate Coding Workbench are outside this retirement.
Shared runtime contracts remain only where active consumers need them (ADR-0061).

## No prompt-token cap (2026-11-11)

No Coding run, Chat tool turn,
agent run or CI repair carries a cumulative prompt-token allowance; every agent step resends the
whole conversation, so any fixed sum ends healthy long runs. Cost control is the operator-configured
Model Gateway spend ceiling. Per-request context-window fitting, output limits, duration, tool-call
and patch budgets remain. Never reintroduce a token-count quota; a better guard against a model
that loops unnoticed is tracked in #4346 (ADR-0137).

## Knowledge Pod scope (2026-11-04)

Knowledge Pods use local storage and have
no sharing roadmap or sharing placeholders. The ordinary Create Knowledge Pod dialog asks only
for a name; the existing server-side `standard` default supplies model-use policy. Model routing
belongs to the central gateway configuration. Local pod storage does not imply local model
providers. Preserve existing model-use policy, containment and audit guards; see
[Knowledge Pods](local-knowledge/knowledge-pods.md).

## Linux desktop is a community tier (2026-11-12)

Keiko promises feature
parity for macOS and Windows only. Design, implement and qualify new or changed
operating-system features (supervision, sandbox and egress confinement, credential storage, file
ownership, native dialogs, launcher, installer, update handoff, runtime activation) for those two.
On Linux such a feature reuses an existing implementation or reports itself unavailable through
its existing closed disposition and fails closed; never block a macOS or Windows delivery on Linux
qualification. Keep building and publishing `keiko-linux-x64.zip` and every gate on it. Existing
Linux capabilities, tests and CI jobs stay, and a red Linux job is fixed, never skipped. Linux
remains the development and CI platform (§3, §9). See
[ADR-0183](adr/ADR-0183-linux-desktop-community-tier.md).

## Local browser connection

Local browser connection uses the trusted native launcher and existing single-use fragment
redemption. The one-click open request returns only a closed outcome, never proof or cookies;
preserve server-owned destinations, fixed browser targets, launch bounds and authenticated APIs.

## Desktop layout restoration

Desktop layout restoration is bound to the current UI database's existing persisted installation
identity. Preserve the same-store restart path; never replay unowned browser window references
into another data store or clear chats and files to hide a broken restoration (ADR-0027).

## Standalone folder package (2026-11-17)

For workplaces where nothing may be
installed, Keiko ships as one folder: the portable payload, every file unchanged, with start and
stop files around it (`scripts/build-standalone-package.mjs`, ADR-0121 D9). It starts with
`keiko portable launch --in-place`: no managed setup, no registration, state in
`~/.keiko-standalone`, nothing downloaded at start. It declares itself managed outside the app
(`KEIKO_PORTABLE_MANAGEMENT`), so the app reports the existing `portable-it-managed` disposition
and never offers the portable setup. Never modify the payload inside a package, never let the
folder form perform or suggest an installation, never let the program folder become a working
folder (every folder launch declares `KEIKO_LAUNCH_FROM_PROGRAM_FOLDER=1`; the program folder is
the launch directory, the payload's `app` folder or, in the npm form, the package folder itself;
the server seeds no default project from it and the read surface refuses it as a root, so it is
listed unreadable and is never a window's starting folder or a coding repository, while a Chat
started without a folder is still kept there; `keiko.config.json` and `*.vault` are credential
names of the sensitive-path denial, kernel-enforced for native commands, wherever they lie), and
never weaken the operating system's download
checks to make a package start: an administrator removes the download mark before internal
distribution. A team's `keiko.config.json` beside the start files is an administrator-owned
input; Keiko adopts it and seals its key, and never writes to it (ADR-0046 D5). Every stable
`latest` release carries the generic package of each desktop target as `keiko-<target>.standalone.zip`,
built and attested in the stable-tag run (`scripts/build-folder-release-assets.mjs`). A folder
package's name keeps the dot before its form: shipped updaters read every dot-free `keiko-*.zip`
release asset as an update archive and refuse a release with one too many.

## npm folder package (2026-11-18)

Where an npm registry, often an internal
mirror, is the approved way in, the same folder form ships without the program: the release's
Node.js runtime, a `package.json` that pins `@oscharko-dev/keiko` exactly and a lockfile with a
public-registry sha512 integrity for every package npm downloads
(`scripts/build-standalone-npm-package.mjs`, ADR-0121 D9). Its first start runs
`npm ci --ignore-scripts` into the folder's own `node_modules` from the registry the folder's
`.npmrc` names, then `keiko start` with the same state, management declaration and provisioned
configuration as the folder package. Never write outside the folder and the state directory,
never run an install script, never ship a lockfile without those integrities. The
administrator's access step (`Zugang speichern`) writes `keiko.config.json` from the
configuration Gateway Setup saved and gives the team token only to the gateway connection Gateway
Setup verified; a provider or reranker with its own connection is refused, never given that token.
The Windows form locks `@oscharko-dev/keiko-coding-runtime-win32-x64` exactly like the macOS
forms (published 2026-11-20, #4068).
The folder carries the release's Node.js runtime without `include/`, `share/`, CHANGELOG.md and
README.md; every kept file stays the archive's, byte for byte. `keiko start` prints one line when
the running Node.js is outside the `engines` range of the package's own manifest and records the
closed `nodeSupport` value on `process.started`; it never refuses the start.
It is no product release asset (its lockfile needs the integrity npm reports for the published
version), so a release owner runs `npm-folder-publish.yml` after a release: it starts every
package on its own platform (`scripts/testing/qualify-npm-folder-package.mjs` on `macos-15`,
`macos-15-intel`, `windows-2025`) and only then publishes the exact tested ZIPs as the attested
GitHub prerelease `npm-folder-<version>`. That prerelease is a transport, never latest, and grants
no update trust; keep the dot before the form in the asset names.
The form is qualified when it is published (2026-11-22): on a pull request the macOS
standard-account forms job defers it and certifies nothing, and the publication run defers no form
([`docs/qa/macos-delivery-forms-standard-account.md`](qa/macos-delivery-forms-standard-account.md)).

## Portable updates without an Apple Developer subscription

Portable updates must not require an Apple Developer subscription (ADR-0121 D7). Verify macOS
handoff copies against the exact current artifact digests in the validated plan after managed
registration admission; preserve candidate authenticity, containment and process ownership.
Optional Apple signing evidence must remain truthful and cannot become a hidden update gate.

## Content threshold (2026-11-04, supersedes the opt-out of #4098)

Keiko runs on
the user's own device and its stores never leave it, so what a person reads and what the model
receives lose only the credential floor by default. `KEIKO_CONTENT_REDACTION=on` lowers the
threshold back to the strict projection; `off` or an absent value preserves; an unrecognized value
warns and keeps redaction. The server resolves it once at startup into the deps graph
(`chat.content-policy.resolved`); no package reads it per request. `deps.redactor` and the Chat
model ports follow it, including tool arguments a person reads and the tool transcript. The
OpenCode runtime is its own producer and always receives the model's output preserved (owner
decision, 2026-10-27). `keiko_research_fetch` arguments leave for the public internet and keep the
full redaction. Evidence, audit records, memory proposals and Quality Intelligence stay on
`strictRedactor`; Coding repository search, Coding History exports and support exports keep their
own redaction.
The floor always goes: configured secret literals, private keys, URL credentials, `Authorization`
header values, encoded-looking Bearer/Basic values, JWT-shaped bearer tokens and known token shapes.
Workspace authority, containment, deny-lists and budgets are unchanged. See ADR-0003 D7 and
ADR-0022 D4.

## The Activity Log carries no personal data (2026-11-04)

Its content leaves the machine in support reports a person exports, so its sink over-redacts: a
value holds no space, and a name, IBAN, telephone, card or account number, date with a year, IPv4
address, remote URL or host, or personal field name is refused whatever field carries it
(`log-redaction.ts`, `activity-log-label-policy.ts`). Never loosen this to keep a value readable:
emit a count, a closed value or a digest instead.

## Syntax-preserving source redaction

Source redaction preserves TypeScript/JavaScript and Java syntax at the shared security boundary;
syntax metadata never exempts credential literal data or configured secrets. JSON/JSONC and YAML
use parsed value boundaries. Ordinary unified diffs reuse the canonical parser at the contracts
leaf and separate native old/new images; unsupported fragments fail closed. Plain prose is not
inferred as source: error recovery counts a declaration only at a statement boundary with a header
its grammar allows, and a Markdown list item is judged on its own text (ADR-0022, #3900). Only the
raw Git diff view of the user's own repository keeps syntax-refused hunks readable under the
credential floor (owner decision 2026-10-28, #4114; ADR-0022). Streaming retains unresolved credential/source context until it can
publish safely; cancellation discards pending text. Failed source projection is unavailable evidence,
not a complete source. Keep diagnostics body-free and regenerate the existing operation registry.

## Document retention and npm delivery (#4157, #3582)

Chat's extracted document text belongs to its admitted user message in the existing private store;
keep the visible draft separate, redact before persistence and prompt use, include attachment text
in history accounting/compaction and the existing private recall index, and keep evidence body-free.
Publish staging keeps external ownership in vendor archives and the root, while the physical npm
bundle omits equivalently promoted external edges. Preserve required/optional reachability and
qualify project npm, isolated global npm and Yarn installs without bundling the external closure.
