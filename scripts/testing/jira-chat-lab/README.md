# Synthetic Jira HTTPS laboratory

This development/qualification harness supports #4081/#4082. It uses synthetic
data only and is independent of the product’s in-process MCP host. Jira Software
Data Center 10.3.26 is the default digest-pinned release; PostgreSQL 16 and the TLS
frontend also have digest-pinned images. A new isolated session can select an exact
10.3/10.4/11.2/11.3 patch release with its independently verified image digest.
Published ports bind loopback only; the frontend forwards to one fixed Jira service.

Prerequisites: Docker Compose, the repository’s supported Node version, OpenSSL
and built workspace packages. State, passwords, PATs, license material and private
keys stay outside the repository in a private session directory.

## Model-free API qualification (AC7)

Run `api-qualification-prepare.mjs <private-session>` after normal first-run setup
in the exclusive lab window. It reuses `seed.mjs` and its one-use PAT creation,
then verifies the disposable administrator's identity and native administration
permission. It never starts Jira or configures a model.

A fresh session needs no manual step. `seed.mjs` grants the qualification actors (`keiko-admin`,
`keiko-api`) the worklog, comment/attachment deletion, sprint and voter permissions the write cases need
(the editor, assignee and restricted actors keep their narrow grants, and the run proves it).
These widened grants live only in the lab's own permission scheme `Keiko synthetic KEIKO permissions`,
which is associated with the synthetic project KEIKO alone; ISOLATED and every other project keep their
own schemes. The denial cases (restricted cannot read KEIKO, editor cannot assign or transition) rely on
the unchanged narrow grants, which `keikoGrantPlan` and the native `mypermissions` check pin. The
preparation then runs every operator step independently and prints one outcome per step: synced
sprints (a disabled lab feature is reported as `sprint-sync-feature-disabled`), the select option, the
permission attribute, the dashboard and item (Jira's own create form with its XSRF token, then the
dashboard plugin's gadget resource; the failing stage is named), the issue-security scheme (bounded
retries) and one owned record for each collection the lab can populate (`api-qualification-collection-seeds.mjs`).
A failed step never hides the others; a step that names a failed `needs` entry is skipped as
`dependency-failed`. A collection read is nonempty by default: only a per-case `emptyAllowed` reason
admits an empty native collection, and such rows are recorded as `vacuous` in the evidence and in the
report's `vacuousReads` list and counted separately as `executableVacuous` in the console summary,
report and archive. They stay executable but prove no projection. An `emptyAllowed` reason must be nonblank
text or the case fails at construction. The native expected side is
paged completely (bounded) before it is compared.

The required-field proof lifts the field's requirement in Jira's default field configuration for
a moment; `requirements/seed-projects.mjs` therefore brackets its writes with `withFixtureFieldOptional`,
which restores the requirement on exit, also on failure. It writes a private marker
`required-field-lifted.json` in the session directory while the requirement is lifted; the next bracket and
`qualify-fields.mjs` restore first when the marker survived a crash. A failed restore keeps the work's own
error (the restore failure is its `cause`) and leaves the marker for that recovery.

`api-qualification.mjs <private-session> [comma-separated-tools] [owned-snapshot-id]` uses this lab's
paired production server, credential vault, verified TLS connection, accepted Chat
turn, operation-selected managed provider, catalog authority, budget and durable
mutation journal. It does not configure or call a model or LiteLLM. Commit the
complete sources first: reports bind one clean source revision, native release,
image digest and the complete 439-identity inventory. A focused run still accounts
for every untested identity as unknown and exits nonzero; it cannot update the
ledger or supply final acceptance.

The driver runs at most 32 accepted turns in each sequential paired-product
lifecycle against the same owned Jira. This preserves the production registry's
64 retained-authority bound without clearing, increasing or expiring that bound.
Each lifecycle retains its own product database in `productStateFiles`; fixture
identities carry forward across batches and uncertain effects stop the whole run.

Private qualification Chats are created through the existing store, with a
descriptive model-free label and no gateway configuration. Credential creation,
verification and binding retain their authenticated production routes. Each call
mints its authority from an admitted stored turn, accepts its read disclosure
through the production owner, dispatches the selected catalog operation and
settles the stored turn. The ordinary model-backed Chat entry point is unchanged.

Read cases live in `api-qualification-cases.mjs`,
`api-qualification-observation-cases.mjs` and `api-qualification-configuration-cases.mjs`.
Configuration cases select actual scheme, screen, tab and grant IDs through read-only
fixture preparation immediately before their governed operation. Each case supplies typed tool
arguments and an independent readback using `lab-client.mjs`; direct REST calls
are observations and fixture preparation only. A transport witness observes the
real selected method/path and forwards responses unchanged. An unexpected or
repeated mutation is refused before transport. A local refusal, missing fixture,
timeout, resource 404 or mismatching readback remains unknown. Native denials and
missing capabilities require their own independent evidence. No policy deferral
is decided by this driver.

`docs/local-knowledge/jira-api-coverage/qualification-proposals.json` records the
integrator's 2026-11-08 decision: seven cluster mutations, upgrade execution,
notification delivery, the two temporary-avatar mutations (Jira 10.3 documents no
resource identity or GET, and another session cannot observe the product session's
temporary state) and the reciprocal remote link (it needs an owned second laboratory
instance with mutual application links, which the single laboratory lacks) are
deferred. Those twelve rows carry the decision reference,
never a native receipt or passing readback. Cluster reads and filter deletion still
need native qualification; deletion preserves the product's unconfirmed outcome.
Additional exceptions require another explicit owner decision.

The planning, application-role, asset, filter, link and index case modules supply
the first 48 entries in the shared AC7 split. Preparatory writes use the same
governed provider and produce separate private receipts, settled journals and native
readbacks. Declared same-turn prerequisites share one bounded accepted authority
and private lifetime; their evidence cannot replace the frozen primary witness.
File sources are attached to the actual Chat through its protected Files scope.

Every session's Jira starts with `-Datlassian.authentication.legacy.mode=true` (set in
`compose.yaml`). Jira 10.3 otherwise answers `POST /rest/auth/1/session` with a 403 "two-step
verification" refusal, so the private administrator session that websudo, session and user-avatar
recipes need could not exist. The setting is part of provisioning: a session started from this
compose file needs no UI step, and the credentials stay read programmatically from its private files.

Some recipes require genuine operator fixtures in the owned session's `fixture.json`:
`planningSyncedSprintIds` and `planningAllSyncedSprintIds` identify real synced sprints;
`assetDashboard: { id, itemId, name }` identifies a disposable dashboard/item created
through native Jira UI, with a name beginning `Synthetic AC7 `; `optionFieldId` and
`optionId` identify a real editable option; `permissionAttributeSchemeId` and
`permissionAttributeKey` identify a real permission-scheme attribute. Native reads
verify these bindings before any corresponding effect. Missing bindings fail closed.

The programmatic entry point is
`qualifyApi(directory, only, snapshotId, { emailDefaultOracle })`.
`emailDefaultOracle`
must bind the fresh owned image's complete native default template manifest before
synthetic uploads. The ordinary CLI supplies no such binding, so a missing required
oracle remains a failure, without creating new deferrals.

The issue lifecycle cases in `api-qualification-issue-cases.mjs` use their own
newly created issue and native acknowledgement IDs. Property lifecycle cases in
`api-qualification-property-cases.mjs` create an absent synthetic key, compare
its exact native value, then independently confirm its removal while the parent
remains readable. Writes retain the normal persisted tool preview and its
canonical action digest, source preparation, mutation outcome and settled
transcript through the production owners. Cases not yet authored remain
explicitly unknown in the complete report. The driver is incomplete while any
inventory identity lacks native qualification; a source checkpoint does not
close AC7.

`api-qualification-release-cases.mjs` creates its own named component and version,
checks ordinary metadata and native issue counts, and exercises version remote-link
lifecycles with independent complete-set comparisons. Destructive cases require the
same owned snapshot proof as other administration; they never reuse another session's
resources. Issue lifecycle property reads compare the production `items` node list.

Before destructive administration, run
`api-qualification-snapshot.mjs <private-session>` within the exclusive lab
window. It reuses `verification.mjs` service/image ownership checks, stops this
session's Jira and TLS writer, and writes a private PostgreSQL dump and Jira-home
tar with SHA-256 evidence. It leaves the services stopped and never restores a
backup automatically. Only after the exclusive window is available, restart the
same session normally. Supply the returned snapshot ID as the qualifier's third
argument; destructive cases refuse absent, foreign or changed backup bytes.
Use `api-qualification.mjs <private-session> '*' <owned-snapshot-id>` to select all
authored cases with a snapshot, or supply an explicit comma-separated tool list.

Private run directories retain the product database, body-free operation evidence
and an exclusive per-case pending intent. Reconcile an interrupted or uncertain
effect before another attempt; never remove a pending intent to replay a write.
Only complete reports can pass `applyQualificationReport`, and each non-unknown
ledger state must have verification references. Run the governor's headroom check
before heavy setup, builds, tests and qualification. Use separate session
directories and release-bound images; never reuse another operator's lab.

## Connect the existing local lab

For ordinary local development, the lab needs a running, licensed Jira, the basic seed
and the generated CA configured through `egress.caBundlePath`. The seed supplies its own
non-admin API actor and private `secrets/api-token` file. In Keiko's Knowledge Hub, choose
**Create Jira Pod**, enter its name, the lab's HTTPS URL and that PAT, then submit the form.
That single submit saves and verifies the connection automatically. Verification binds the
saved URL; no second address list,
comparison code or private-network switch is required.

The connection probe below checks this production path using an isolated temporary vault.
The larger Chat, mutation and requirements groups are separate acceptance qualifications;
their successful completion is recorded independently of ordinary local connection setup.

## Finite normal-Chat catalog qualification

After setup, identity/field fixtures and preflight, use the actual locally verified
tool-calling model to exercise all nine reads and five writes through normal Chat:

```sh
node scripts/testing/jira-chat-lab/catalog-chat.mjs /absolute/private/session actual-model-id buffered
node scripts/testing/jira-chat-lab/catalog-chat.mjs /absolute/private/session actual-model-id stream
```

Run groups serially with all other laboratory writers stopped. Each operation has
its own authenticated Chat, a server-established read grant and exact write approval. The group
creates one uniquely marked synthetic issue, edits it, assigns it, comments once,
then sends the required transition-screen field and transition together. Independent
Jira reads verify project counts, current field values, comment counts and change
history. The comments case reads the hostile-comment fixture while requiring zero
model-requested mutations. No API token or fixture content is printed.

To qualify an already configured local Gateway such as LiteLLM, set
`KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json` and pass its exact
configured model identifier. The helper reads that private configuration and its existing
provider vault through the production resolver. It supplies the resolved credential only
through the existing transient model environment override; it never copies the key into a
new config or vault. Missing models, unavailable credentials and non-loopback Gateways fail
before probing. The ordinary production tool-calling probe still runs against the selected
Gateway and preserves its configured request timeout. The bounded retry setting remains
specific to each qualification group. With no explicit source, the original local Ollama
configuration and its 45-second timeout remain available.

The driver fsyncs a private group/intent before dispatch and retains both that record
and its product database on failure. A pending group prevents another run. Read its
private state and reconcile Jira independently before archiving the pending record;
never replay an uncertain mutation. A successful receipt is emitted only after all
14 operations and the closing license check pass. An expired or incomplete group
does not count as acceptance and must be qualified again as a complete new group
after reconciliation. Raw REST fixture setup is not a substitute for this product
path. The final acceptance record identifies the exact tested product artifact.

## Project setup and Agile lifecycle through the visible UI

The AC5/AC6 browser group uses the real model, connected Jira Pods, composer,
administration opt-in and exact write approvals. Supply two existing actors through
private PAT files: the permitted actor must independently have native `ADMINISTER`
permission and private default filter sharing; the denied actor must lack that
permission. The group grants no permissions and changes no global defaults.

```sh
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  npm run jira:lab:browser-project-agile -- /absolute/private/session actual-model-id \
  /absolute/private/permitted-PAT /absolute/private/denied-PAT

npm run jira:lab:browser-project-agile -- /absolute/private/session --reconcile \
  /absolute/private/permitted-PAT
```

Twelve steps cover allowed/denied project creation, Epic and Task creation with the
intended relation, a private filter, Scrum board, sprint creation and assignment,
start and completion, and two refused invalid state changes. Independent native
reads require exact fields, relations, membership and state. Keys and links must
remain visible after reload. The native dispatch witness forwards real responses
unchanged and refuses unexpected or repeated writes before forwarding.

This group creates uniquely named projects and retains its effects. It never resets
`REQ`, restarts Jira or removes remote fixtures. A failure retains its exclusive
pending intent and product state. `--reconcile` reads the retained targets without
resuming writes or deleting that marker. The current license must have at least
thirty minutes remaining. Run groups sequentially in a coordinated machine/Gateway
window; never stop another session's instance. Source tests and a prepared driver
are not live acceptance evidence. The finite fourteen-operation catalog group
above is separate from the epic's 439-identity accounting.

## Daily Jira role journeys through the visible Chat UI

AC5/AC6/AC8/AC9 use three independent Chats and verified Jira Pods for project lead, developer and tech lead. Preparation uses only the administrative lab client: one fresh Scrum project derived from the reserved group identity, one board, two Epics, eight Stories, one Task and the real numeric Story Points field on the create/edit screens. The existing identity and permission seed owners provide separate PATs and native permission readback. The developer has no Manage Sprints permission; additional create/comment/link/resolve rights support the requested daily tasks.

The administrator owns the filter and board. A single view-only project share is bounded by the
fresh project's exact direct-user permission scheme for the three roles and administrative oracle.
Setup verifies the scheme before and after sharing, and each role PAT must independently read the
same board before any model turn begins.

Run the group only in the integrator’s coordinated real Jira/Keiko/model window:

```sh
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  npm run jira:lab:browser-roles -- /absolute/private/session actual-model-id

# Offline: print all thirty expected write signatures without opening a session.
npm run jira:lab:browser-roles -- --plan

# Observe retained remote targets only; never resume or replay an uncertain write.
npm run jira:lab:browser-roles -- /absolute/private/session --reconcile
```

Each natural-language German/English prompt is one visible composer turn. PL1–PL7 run first, then all developer turns while sprint 1 is active, then PL8–PL11 and all tech-lead turns. The three Chat/Pod/authentication bindings are independently checked on opening and again before PL8. Read questions allow the existing search/report operations and require exactly the independently queried issue keys and numeric totals; they forward zero writes.

Every write must match its ordered method/path/body admission and one visible approval per native forward. Fresh resource IDs come from independent Jira reads, including IDs needed by a later write in the same turn. Native readback verifies fields, relationships, membership and lifecycle state. A rejected developer delete is exactly one 403 with a single readable refusal and unchanged sprint. Generic visible “Jira action” and unavailable/raw result rows are counted as presentation findings. A complete read may correctly have no result card.

Each opened role gets a reload/transcript/no-replay observation and a private screenshot; an unsettled turn is captured without replaying it and retains an unverified reload. Contradictory evidence stops later turns, whose initialized scorecard rows stay unverified. JSON and Markdown scorecards named roles-scorecard-<group>-<role> contain only static step descriptions, classifications, counts and digests. Screenshots and reports remain in the private lab session. Product receipts that remain unconfirmed, including rank/delete receipts, stay unverified despite separate native observations.

The exclusive roles-browser.pending.json intent is persisted before setup and each turn. A failure retains both that marker and the product state. Reconciliation never clears the marker or issues writes. A completed group requires all steps/reloads verified and all three browsers closed; no automatic reset, retry, Jira restart or removal of project fixtures occurs. At least thirty minutes of license remain before starting. Offline stubs and prepared drivers are not live acceptance evidence.

The following signatures count writes only; normal metadata/JQL reads are independently observed. PL8 closes sprint 1 before moving open issues to sprint 2; Dev10 targets that still-empty future sprint; PL11 creates and deletes only the new empty third sprint. Issue/version/component IDs are bound from the corresponding native observations.

### Projektleitung

| Schritt                                         | Writes | Signatur                                                                                                                       |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Create the first sprint                      | 1      | POST /rest/agile/1.0/sprint                                                                                                    |
| 2. Rename the sprint and change its goal        | 1      | POST /rest/agile/1.0/sprint/{sprint1Id}                                                                                        |
| 3. Create the second sprint                     | 1      | POST /rest/agile/1.0/sprint                                                                                                    |
| 4. Plan four stories                            | 1      | POST /rest/agile/1.0/sprint/{sprint1Id}/issue                                                                                  |
| 5. Rank one story before another                | 1      | PUT /rest/agile/1.0/issue/rank                                                                                                 |
| 6. Create version 1.0 and assign three stories  | 4      | POST /rest/api/2/version; PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey} |
| 7. Start the first sprint                       | 1      | POST /rest/agile/1.0/sprint/{sprint1Id}                                                                                        |
| 8. Complete the sprint and move unfinished work | 2      | POST /rest/agile/1.0/sprint/{sprint1Id}; POST /rest/agile/1.0/sprint/{sprint2Id}/issue                                         |
| 9. Release version 1.0                          | 1      | PUT /rest/api/2/version/{versionId}                                                                                            |
| 10. Read the sprint report                      | 0      | keine                                                                                                                          |
| 11. Create and delete an empty sprint           | 2      | POST /rest/agile/1.0/sprint; DELETE /rest/agile/1.0/sprint/{createdSprintId}                                                   |

### Entwicklung

| Schritt                                 | Writes | Signatur                                                      |
| --------------------------------------- | ------ | ------------------------------------------------------------- |
| 1. Read my current sprint issues        | 0      | keine                                                         |
| 2. Assign a story to myself             | 1      | PUT /rest/api/2/issue/{issueKey}/assignee                     |
| 3. Start the story                      | 1      | POST /rest/api/2/issue/{issueKey}/transitions                 |
| 4. Log two hours                        | 1      | POST /rest/api/2/issue/{issueId}/worklog?adjustEstimate=leave |
| 5. Comment on the story                 | 1      | POST /rest/api/2/issue/{issueKey}/comment                     |
| 6. Create a subtask                     | 1      | POST /rest/api/2/issue                                        |
| 7. Create a blocking bug                | 2      | POST /rest/api/2/issue; POST /rest/api/2/issueLink            |
| 8. Finish the story with a resolution   | 1      | POST /rest/api/2/issue/{issueKey}/transitions                 |
| 9. Watch the story                      | 1      | POST /rest/api/2/issue/{issueId}/watchers                     |
| 10. Attempt to delete the future sprint | 1      | DELETE /rest/agile/1.0/sprint/{sprint2Id}                     |

### Technikverantwortung

| Schritt                                        | Writes | Signatur                                                                                             |
| ---------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| 1. Create the Backend component                | 1      | POST /rest/api/2/component                                                                           |
| 2. Assign the component to three stories       | 3      | PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey} |
| 3. Link two stories with a blocking dependency | 1      | POST /rest/api/2/issueLink                                                                           |
| 4. Read blocked issues                         | 0      | keine                                                                                                |
| 5. Label two stories as tech debt              | 2      | PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey}                                   |
| 6. Move a story to the other epic              | 1      | POST /rest/agile/1.0/epic/{epicId}/issue                                                             |
| 7. Estimate three stories                      | 3      | PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey}; PUT /rest/api/2/issue/{issueKey} |
| 8. Read unfinished version work                | 0      | keine                                                                                                |
| 9. Attach the pull request                     | 1      | POST /rest/api/2/issue/{issueId}/remotelink                                                          |

## Formal rules and knowledge-grounded authoring through the visible UI

The AC1/AC2/AC4 source journey uses ordinary skill upload, validation and selection,
Pod creation and connection, source selection, indexing, the composer and exact
approvals. Supply the actual configured chat and embedding model identifiers and
an existing seeded `REQ` board:

```sh
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  npm run jira:lab:browser-rules-knowledge -- /absolute/private/session actual-model-id \
  actual-embedding-model-id existing-REQ-board-id
```

The group checks refused and corrected Epic writes in all three modes; Task, Bug
and subtask writes use Ask for approval. A prose skill must create no enforcement
record or formal refusal. The parent-type clause must reject an Epic as a subtask's
parent and accept its intended Task. Independent native reads check required
fields, exact types and the Subtask → Task → Epic relations.

Supported documents and folders are selected and indexed in the actual Knowledge
UI before model-assisted Epic creation. Native Jira readback checks readable
descriptions and meaningful document/page/section references; visible Epics and
board backlog rows are evaluated separately. Keys and links must survive reload.
An exclusive persisted intent prevents replay after an interrupted run; this group
does not reset or clean up Jira. These authored sources still require current-head
live execution and do not establish acceptance by themselves.

## Complete paginated search through ordinary Chat

After the same licensed HTTPS/read/write preflight, use the existing seeded project with
more than ten issues. Run this read-only group separately from other laboratory writers:

```sh
node scripts/testing/jira-chat-lab/pagination-chat.mjs /absolute/private/session actual-model-id stream
```

The selected real model calls the production `jira.search` tool with ten-record requests.
The harness follows each actual `nextStartAt` until the independently observed ordered
reference is complete, then checks an empty terminal page. A bounded prefix must expose its
first unreturned cursor; a missing/skipping cursor, duplicated record, incorrect total or
premature completion fails qualification. Every physical Jira search must retain the exact
requested cursor, limit and query, and every mutation is refused before forwarding. The
observer passes real responses through unchanged and records only counts, cursors and statuses.
The same Chat reuses its first server-established read grant; no write approval is expected. Independent reads
also require unchanged remote state after each page.

The private pending intent is exclusive and retained on failure, together with product state.
A successful receipt requires all pages, the empty page, zero mutation attempts and the closing
license check. This product-path group is distinct from the direct seed pagination check;
preparing or unit-testing the harness does not count as a successful live group.

## Start an isolated session

The directory’s parent must already exist. Initialization refuses an existing directory.

```sh
node scripts/testing/jira-chat-lab/session.mjs init "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs start "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/session.mjs status "$HOME/.local/share/keiko-jira-4081-new"
```

Every initialization creates an independent Compose project, persistent volumes,
three independent private passwords, and a private 365-day development CA and
server certificate under `secrets/tls` (renewed by `session.mjs start` when seven days or less remain). The frontend container receives only its
server key/certificate as read-only mounts; the CA key remains on the host. System
trust is unchanged. HTTP administration defaults to port 18081; product-path
qualification defaults to HTTPS port 18443. The existing initializer also accepts:

`session.mjs init <private-directory> [http-port] [https-port] [exact-jira-version] [sha256-hex]`

Supply version and digest together; the digest is 64 lowercase hexadecimal
characters without a `sha256:` prefix. The repository remains fixed to
`atlassian/jira-software`. New manifests persist the complete HTTPS/version/digest
binding. Old manifests retain the original defaults without being rewritten;
partial or malformed pins are refused. Start, stop and status use the saved
manifest and accept no port/image overrides.

Start and runtime service inspection refuse a foreign running Compose Jira
service before proceeding. Docker inspection failures also refuse the start.
Separate sessions own separate projects, ports and licenses, so an operator may
declare side-by-side runs with the exact `KEIKO_JIRA_LAB_PARALLEL=allow`, for
example the model-free API qualification beside one model-driven run; Docker must
still answer, and any other value keeps the window exclusive.
Stopping the owned session remains available. This check supplements the
coordinated exclusive window; it never stops another operator's containers.

Use a new private directory, separate Compose project/volumes and unused distinct
HTTP/HTTPS ports for each release. Never reuse an existing Jira data volume for
another release or stop another session to free its port. The TLS listener and its
outside/inside port match, preserving the exact Host guard. Runtime inspection
checks the selected image ID/repository digest and owned listener bindings. Normal
production verification must independently observe the exact saved native Jira
version; an image tag alone is insufficient.

Parameterization does not establish live compatibility. Session isolation does not
replace the coordinated machine/Gateway window.

Official Registry metadata was read on 2026-11-08 without pulling image layers or
starting containers. The following `linux/arm64` child-manifest bytes matched their
immutable digest, preserving the default laboratory's platform. These are prepared
image selections, not evidence that Jira or any operation ran successfully:

| Exact release / official manifest                                                                                                                    | ARM64 SHA-256 (without prefix for `init`)                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [10.4.0](https://registry-1.docker.io/v2/atlassian/jira-software/manifests/sha256:56e6ea7ef5915b8c1f01e8161b17409fc0a32267e4425543ace0c888d49ff6a2)  | `56e6ea7ef5915b8c1f01e8161b17409fc0a32267e4425543ace0c888d49ff6a2` |
| [11.2.1](https://registry-1.docker.io/v2/atlassian/jira-software/manifests/sha256:8c61da4dbb35444793a080b63c75639886688c2fb253c3ba88f7d77826f32d83)  | `8c61da4dbb35444793a080b63c75639886688c2fb253c3ba88f7d77826f32d83` |
| [11.3.13](https://registry-1.docker.io/v2/atlassian/jira-software/manifests/sha256:68d5536e2e1278d3fd94060dd9dcecfaf776c17ab6b78919afc7ea516e187ad3) | `68d5536e2e1278d3fd94060dd9dcecfaf776c17ab6b78919afc7ea516e187ad3` |

The existing 10.3.26 digest remains available and unchanged. Its current tag points
at a different index; that moving tag is never substituted for the saved pin.
The direct connection probe additionally accepts the private session directory:

`verify-connection.mjs <private-PAT-file> <private-TLS-directory> [private-session-directory]`

Omitting that directory preserves the historical default release/HTTPS invocation.
The ordinary preflight, Chat and browser groups use their loaded session binding.

Save the published Jira Software Data Center test license in a private regular file
(mode 0600) outside the repository, then run the normal first-run setup:

```sh
node scripts/testing/jira-chat-lab/setup.mjs "$HOME/.local/share/keiko-jira-4081-new" /absolute/private/test-license
```

This drives Jira's existing forms: private access, the supplied test license,
administrator `keiko-admin` with `secrets/admin-password`, and disabled email. An exclusive
`setup-pending` marker prevents repeating a potentially completed setup after interruption.
Reconcile the normal UI and license endpoint before removing that marker. A completed setup
records a private receipt. Setup does not modify Jira licensing code, clocks or database values.
Never paste secrets into tracked files, commands or evidence. Setup waits for Jira's
`FIRST_RUN` state, then uses the normal root entry and waits for database initialization
to reach application properties; `FIRST_RUN` alone does not prove database readiness.
A verified `RUNNING` instance is refused before any setup mutation. The license submission
includes the existing wizard's `next` control, checks its exact same-origin redirect,
and never repeats an uncertain POST. Diagnostics expose only stage, status and readiness.
On 2026-10-27 the complete corrected script passed against fresh isolated volumes, including
normal license/admin/mail forms, the private receipt, a valid license and `RUNNING` state.
Earlier interrupted proof volumes and their pending markers remain preserved; their writes
were not replayed to obtain this clean cold-start result.

The [published test license](https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/)
has a three-hour lifetime. A healthy container or successful read does not establish
write availability. Each qualification group requires license/read/write/HTTPS
preflight and completion within the valid session. An expired group must be repeated
in full. Never change clocks, licensing code or license data. A normal update did
not renew the original expired laboratory; its data remains retained. A scorecard
checks the license again before each journey and, once no lane uses Jira, restarts
the containers at that boundary, because two lanes outlast one license.

`session.mjs stop <directory>` stops only that manifest’s containers and retains
its volumes. This harness does not delete existing laboratories or renew licenses
in the background. Before a live or model-free product run, the existing lane lock
checks a 45-minute run window plus five minutes of margin and restarts only the
owned lab, at that boundary, if the published test license needs renewal. Another
active lane blocks that restart. Docker must be available to perform renewal;
a failed renewal withholds the run. Use a new directory/project for an independent session.

The same preflight requires at least twelve hours of native PAT validity for each
seeded actor, renews a nearly
expired fixture PAT with that actor's existing basic credentials, verifies the
replacement by native identity and token readback, then retires only its predecessor.
Creation, promotion and retirement hold the same exclusive lane lock as license
renewal; any active lane delays them. The returned PAT is synchronized privately
in `<actor>-token.next` before any readback, together with its native id and
nonce-bound creation intent. `<actor>-token.json` binds the promoted raw file to
its native id and digest; the pending marker records creation and retirement.

Preflight reconciles these records automatically: a staged candidate is verified
by native inventory, expiry and actor identity before promotion; interrupted
retirement is retried only for the bound predecessor id. A lost creation response
is compensated only when the nonce and prior-id inventory identify exactly one
owned orphan, with native absence verified before a replacement POST. A missing
pending marker is reconstructed from the complete private `.next` bundle. A
marker alone never authorizes another creation. If no creation is observed, an
existing credential may continue only while its native proof covers the requested
window; otherwise preflight refuses with `creation-not-observed`.

To run the same recovery explicitly, at an idle boundary:

```sh
node scripts/testing/jira-chat-lab/fixture-tokens.mjs /absolute/private/session actor 43200
```

A corrupt or ambiguous intent, or an old raw `.next` with no recoverable id
binding, fails closed with a specific recovery reason. Preserve these files;
reconcile the owned native token inventory before any manual repair. Never print
token contents or remove a pending marker to replay a POST. Renewal completes
before Keiko binds the credential, never halfway through a turn.

New lab CA and server certificates last 365 days. `session.mjs start` renews existing
TLS material with seven days or less remaining and recreates only the owned TLS
front after renewal so the new certificates are served. A partial publication or
mismatched key/certificate generation is refused and regenerated as a complete
validated generation on the next start; symlink targets are refused before any
write. The run preflight refuses
a TLS interval shorter than its run window; restart the owned session at an idle
boundary before retrying. Each retained product state has its own `memory/` directory
via `KEIKO_MEMORY_DIR`; it never shares the user's ordinary Memory store.

## Seed and inspect basic fixtures

```sh
node scripts/testing/jira-chat-lab/seed.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

The seed verifies license validity before and after its work, creates the synthetic
project and non-admin API actor, stores its PAT privately, creates three issues and
reads each back. Repeated runs locate existing identities/issues and reuse the PAT.
A marker prevents repeating PAT creation after a lost response. No failed mutation
is automatically retried. Output contains case names, status codes and counts only.

The seed also creates restricted, edit-only and assignable identities with private
PATs. Explicit permission schemes separate edit, assignment and transition, and
separate project visibility. It verifies the permission matrix and actual denied
read/assignment/transition calls, then confirms status and assignee stayed unchanged.
The additional fixture groups below supply pagination, hostile content and isolated-project cases. Complete integrated journeys remain pending; the basic seed alone does not satisfy #4082 AC5.

## Qualify required fields and transition screens

```sh
node scripts/testing/jira-chat-lab/qualify-fields.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Run this after the basic seed, before a qualification group, with no concurrent lab
consumer. It creates a built-in text custom field and uses supported Jira admin UI
controls to require it and associate the transition screen. A legacy issue predating
the requirement has no value: a transition omitting it must fail; sending the field
and transition together must succeed and match independent readback. The script also
checks create refusal, unchanged issue count, and successful required-field data.
Jira supplies a default Resolution automatically, so Resolution alone is not used as
the missing-field proof. No third-party workflow app or modified Jira code is needed.

Fixture preparation temporarily makes the field optional to prepare the legacy issue,
then restores the requirement in a `finally` block. It leaves that issue ready for the
next consumer. License checks bracket the group. Configuration, issue IDs and field
IDs stay in the private fixture manifest; diagnostics contain closed cases/counts.

## Seed content and isolation fixtures

```sh
node scripts/testing/jira-chat-lab/seed-content.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Run after required-field qualification. This creates 21 pagination issues, a hostile
summary/description/comment fixture and an isolated-project issue. It verifies two
nonoverlapping search pages, exact hostile-content readback, restricted-project read
success, the other identity's read refusal and unchanged comments after a denied write.
Jira 10.3.26 reports this permission refusal as 400. Repeating the seed reuses fixtures.

## Verify the actual product HTTPS path

```sh
npm run build:packages
node scripts/testing/jira-chat-lab/verify-connection.mjs \
  "$HOME/.local/share/keiko-jira-4081-new/secrets/api-token" \
  "$HOME/.local/share/keiko-jira-4081-new/secrets/tls"
```

The PAT must be a private regular file. The harness invokes the production custody,
encrypted vault, explicit connection verification and HTTP adapter, then removes its
temporary vault. The saved Data Center URL is sufficient: its address class is bound
automatically during verification and retained privately. No `privateTargets` entry or
global private-network setting is added. The probe checks trusted HTTPS, rejection
without CA trust, and successful reuse of the saved connection after restoring trust.
It emits only closed outcomes. This probe alone does not qualify mutations, model calls
or Chat UX.

```sh
node scripts/testing/jira-chat-lab/preflight.mjs "$HOME/.local/share/keiko-jira-4081-new"
```

Start each live group with this licensed HTTPS/read/write preflight. It performs a
unique description edit (204) and comment (201) through the production vault and HTTP
adapter, then checks independent state, exactly one matching change and a one-comment
count increase. An already-confirmed assignment is not repeated. A private exclusive
pending marker prevents automatic reruns after interruption: reconcile its possible
remote effects by read-only inspection before removing that marker. Never assume a
transport failure means a mutation was not committed. Finish each group with a license
check; an interrupted or expired-license group is not acceptance evidence.

The generated development CA still needs the ordinary configured trust setting:

```json
{
  "egress": {
    "caBundlePath": "/absolute/private/session/secrets/tls/ca.pem"
  }
}
```

This is certificate trust, not a second address approval. A connector with a certificate
already trusted by the configured runtime needs no extra trust file. Never disable
certificate validation or enable global private-network access. The connector remains
bound to the exact saved HTTPS origin, port and context path; metadata/link-local targets,
Keiko's own listener ports and redirects remain refused.

A newly completed Jira setup can be `RUNNING` and licensed while still having zero
projects or fixture users. Run the basic seed before claiming a Live Pod has useful test
data. The seed's non-admin PAT, project/issue readback and permission checks are distinct
from Docker health, and a successful connection probe is distinct from a complete Chat
or mutation qualification. Keep passwords and PATs in the existing private session files;
never copy the administrator credential into a product config or qualification receipt.

Checkpoint (2026-10-26): the fresh licensed instance passed basic PAT/non-admin,
three-create/three-read and repeat-seed checks. All three production HTTPS probes
then passed through the Compose frontend. The remaining acceptance work is recorded
in `docs/qa/jira-chat-pods-4081.md`; no full criterion is closed by this checkpoint.

## Real ordinary Chat read group

After the licensed HTTPS/read/write preflight, run the actual normal Chat API with a
locally installed, tool-capable Ollama model. The model argument is a Chat registry
identifier; for an Ollama default tag, omit `:latest` (the actual provider probe must
still succeed). This example uses the installed Qwen model:

```sh
node scripts/testing/jira-chat-lab/preflight.mjs "$HOME/.local/share/keiko-jira-4081-new"
node scripts/testing/jira-chat-lab/chat-read.mjs "$HOME/.local/share/keiko-jira-4081-new" keiko-qwen36-35b-8bit
```

The script creates an isolated temporary product state, pairs through the real launcher
attestation route, verifies the model using the production tool-calling probe, creates
and verifies a Live Pod through HTTP, and binds it to a normal Chat. It sends one
canonical turn and observes that no read consent is ever pending: reads need no human
approval (owner decision 2026-11-02), the retired consent route is gone and the server
establishes the read grant itself. It then checks the completed canonical turn, actual `jira_projects` result and final model answer. It uses the shared gateway,
catalog and MCP host with real TLS/PAT access to the lab; no model/Jira transport is
mocked. License checks bracket the group. Output and persisted Activity Logs are
content-free. A log-sink warning makes the process fail. Private temporary product
state is removed; the lab and its credentials remain untouched.

This group qualifies one buffered read journey. It does not qualify Chat writes,
streaming/browser journeys, mixed grounding or the full acceptance matrix.

## Real ordinary Chat write groups

After a successful licensed HTTPS/read/write preflight, qualify one mode and transport:

```sh
node scripts/testing/jira-chat-lab/chat-write.mjs "$HOME/.local/share/keiko-jira-4081-new" \
  keiko-qwen36-35b-8bit governed-assist buffered
```

Supported modes are `governed-assist`, `supervised-coding` and `autonomous-delivery`;
the transport argument is `buffered`, `stream` or `browser`. Run groups sequentially with no other
stateful laboratory consumer. Each group uses the existing real model probe, authenticated
normal Chat API, verified HTTPS Live Pod and shared gateway/binder/MCP execution path.
It requests one unique synthetic comment and independently checks Jira before and after:
exactly one matching comment and a total count increase of one. The Chat's mode is
always set explicitly (a new Chat defaults to Full access), every mode reads on a
server-established grant without a consent step; the first two modes additionally require exactly one
approval whose preview matches the proposed comment. Full access must require no write
approval. Streaming must emit the corresponding read-grant (always granted)/approval events and one terminal
response without a buffered fallback. Reloaded history must retain the confirmed mutation
outcome. License checks bracket the complete group.

Before dispatch, a private, synchronized `chat-write.pending.json` records the canonical
turn, unique comment and baseline. Its exclusive creation prevents another run after an
interruption. Failed runs retain the private product database, vault and credential key
inside the laboratory directory. Inspect the recorded canonical turn/journal and Jira
using read-only requests before deciding how to reconcile the marker; never rerun a
possibly executed comment. A successful group writes a private receipt and removes its
pending marker. Output contains closed stages, counts and mode names only. These groups
qualify normal Chat comment execution; other mutation operations and the complete
acceptance matrix require their own evidence.

For `browser`, first build the current UI with `npm run build --workspace @oscharko-dev/keiko-ui`.
The harness reuses the real browser setup below, creates and verifies the Pod through the
Knowledge Hub, connects the Chat through the composer's Connectors panel, chooses the requested
mode with its Access radios and verifies that no read-consent card ever appears. It captures
and persists the browser's actual canonical turn identity, checks the exact action textarea, and approves through the
visible button. The rendered terminal state and independent Jira count must both confirm
the write. Full access must display no write-approval card. Screenshots remain private in
the session directory; an interrupted browser run retains the same reconciliation marker.

Append `keyboard` or `drag` after `browser` to qualify adding the live Pod to the existing
workspace and binding it through keyboard ports. `keyboard` activates the accessible Hub
action; `drag` performs native browser drag/drop. Both assert that the edge appears only
after the authenticated Chat settings request succeeds. The default is `dropdown`.
Append `lifecycle` after the connection choice to additionally rename the same Pod, replace
its PAT with the distinct synthetic editor identity, verify it again, and remove it through
visible Hub controls. Independent public API reads confirm stable Pod identity, increased
credential generation, supersession of the previously established read grant, credential removal and
Chat disconnection; the workspace edge must disappear too. This optional group requires
`seed.mjs`'s editor fixture and retains the completed write outcome after lifecycle changes.

## Read through the actual browser

Build the UI with `npm run build --workspace @oscharko-dev/keiko-ui`, complete a
fresh license/read/write/HTTPS preflight, then invoke the read harness explicitly:

```sh
node scripts/testing/jira-chat-lab/chat-read.mjs /absolute/private/session actual-model-id --browser
```

The harness serves that static build with its actual CSP, redeems a fresh
launcher pairing fragment in Chromium, creates and verifies a Jira Pod in the
Knowledge Hub, and connects an existing empty Chat through the Connectors panel.
It sends a prompt through the normal composer, requires that no consent card is shown,
and requires a completed canonical turn, the real project result and a final
model answer. There are no mocked browser, model or Jira transports.

Stage diagnostics contain no request bodies or credentials. Screenshots stay in
the private synthetic session directory. A failed or license-budget-rejected run
is not a completed journey; repeat the entire group in a valid session.

## AC7 ledger publication

`api-qualification-ledger.mjs` publishes one complete model-free run on its exact
clean source revision. Run it in the existing verification container after all
439 identities have qualified, with the private report path mounted there:

```sh
docker exec -e KEIKO_OS_KEYCHAIN=off -w /absolute/checkout CONTAINER \
  node scripts/testing/jira-chat-lab/api-qualification-ledger.mjs \
  /absolute/private/session/api-qualification-RUN/qualification-VERSION-RUN.json
```

The driver records a per-case source/run/release/image binding, the closed
product result, receipt, journal and independent readback. Only an unchanged
source and a zero-unknown final report receive `phase: complete`. Publication
regrades every row with the same evidence classifier and checks its tool effect
against the inventory. Missing or duplicate identities, mixed runs, model calls,
open reconciliation markers, native validation errors and unapproved policy
proposals withhold the ledger. Old partial reports cannot be upgraded by adding
references. No cross-head or cross-run pooling is supported.

The writer archives only counts, closed native statuses and readback digests,
then atomically replaces the ledger using the existing synchronized private-file
writer. References point into that committed body-free archive. A failed archive
publication leaves the previous ledger intact; an already identical archive can
be reused on recovery. Case bodies remain in the private run directory. The
export is `writeQualificationLedger({ ledgerPath, reportPath, sourceRevision })`;
the CLI additionally verifies the clean repository before publication. An
independent readback never turns `malformed-payload` or `not-found` into native
success. Failed/unconfirmed writes qualify only with native 2xx, the matching
settled journal and receipt, reason `unavailable`, and a nonvacuous readback.

### Grading, measured proof and causes (#4327)

- **Measured assertions.** Every recipe, fixture and oracle helper imports
  `api-qualification-assert.mjs`, a drop-in for `node:assert/strict` that counts the
  assertions that held. The driver resets the counter around each readback and persists
  `readback.measuredAssertionCount`; `executable`, `denied` and `unavailable` evidence needs
  it above zero. The recipe's declared `proof(n)` is only a documentation hint and can no
  longer satisfy the grader.
- **`priorPresence`.** A DELETE whose product read answers "not found" qualifies only when
  the recipe measurably read, natively before the dispatch, the exact object the DELETE removed:
  one of `readback.presenceReadPaths` (pathnames recorded by `read()`) must equal the pathname the
  witness saw the DELETE use. Shared transport helpers use the uncounted `plumbingAssert`, so only
  assertions the recipe's own readback makes count toward `measuredAssertionCount`.
- **Documented non-2xx.** A read may declare an exact documented status set with
  `documentedStatusProof` (`readback.documentedNativeStatuses`). The grader accepts only the
  closed allow-list `[404]`, only for reads, only when the witness observed exactly those
  statuses and the oracle independently proved the state (`GET /rest/api/2/reindex` before any
  reindex task ran). 405 stays reserved for proven capability absence.
- **Non-clustered 405.** `GET /rest/api/2/cluster/nodes` grades `unavailable` only when the
  lab actor's own native read answers the identical 405, the running release is observed
  again, and the readback carries `capabilityAbsent` (`nonClusteredAbsence`); the lab Jira is a
  single node by construction. The release inventory path does not apply because the route is
  published for 10.3.
- **Causes.** Every row that is not graded keeps its disposition (unknown stays unknown and
  `applyQualificationReport` still refuses it) and gains a closed `cause`:
  `product` (a local product refusal before dispatch, or Keiko failed while Jira answered
  2xx), `lab` (preparation, fixture, argument-builder or oracle fault), `cascade` (with
  `blockedBy`: the auxiliary fixture tool or earlier case that failed), `infrastructure`
  (a transport signal such as ECONNRESET, or 408/425/429; a 5xx or timeout alone stays
  `undetermined` unless the lab's own health read also fails), `not-attempted` and `undetermined` (Jira refused Keiko's
  request, or the oracle disagreed after a native 2xx). Evidence also carries the closed
  failure word (`product-refused` for a refusal before any native request, `outcome-refused`,
  `result-unavailable` for a settled dispatch without any outcome, which is never blamed on the
  product, `oracle-read-refused`, `dispatch-failed` with recipe/product frame sites and error type),
  the product's closed `outcome`/`reason`, and the Jira status class. No raw Jira text is
  persisted. The report summary adds `causeCounts`; the console summary prints them.
- **Cascades and order.** Cases may declare `dependsOn` (tool names). The driver runs a root
  case before its dependents in a deterministic stable order, and a dependent of a root that
  did not qualify is recorded `blocked-by-root` as a cascade instead of being dispatched.
- **Certain effects do not stop the run.** A mutation whose journal settled with a native 2xx
  the witness itself observed but whose oracle mismatched is recorded unknown with
  `certainEffect: true` and cause `undetermined`; dependents cascade and the run continues.
  The witnessed response count must equal the started effects, and the case id is listed in
  `report.leftoverState`. A row where the product succeeded after a native 2xx but the oracle
  disagreed also carries `suspect: "product"`, counted in `report.suspectCounts`. An unsettled or
  unknown journal, 408/425/429/5xx and a lost transport still raise
  `ReconcileRequiredError`, and the pending intent is never removed or replayed.

## Limit-run fault plan (Amendment 3)

`browser-bulk-fault.mjs` exports exactly
`createFaultPlan({ scope, at, kinds })`, returning `{ maybeInject(ctx, progress01) }`.
The closed scopes are `bulk-epics`, `hierarchy` and `progress`. Threshold/kind
pairs stay together; the normal plan pairs `0.4` with `response-drop` and `0.8`
with `server-kill`. Call before the next ordinary unit to arm a drop and again
after independently observing and recording the completed unit. Call once more
at progress `1` and include that StepResult in the block's final grade. A pending,
skipped or unverified fault check must never be ignored when grading the run.

F records only through `ctx.intent.record("faults", value)`. Each
`<scope>:<kind>` key is reserved as `injecting` before an effect. Any existing key,
including an interrupted or skipped record, prevents another injection. The
existing private intent stores native issue identities and summary/state digests;
summary bodies and exception contents are absent. F writes no other journal and
does not modify another block's checkpoint.

A response drop targets only the signed-in loopback page's ordinary Chat POST
routes. It forwards the original request once with redirects and retries disabled,
then aborts the browser response with `connectionreset`, disposes the fetched
response and removes only its own handler. GETs and other origins cannot consume
it. F never sends a prompt or retries a turn. The block and product retain their
normal canonical resume path. Cancellation removes the handler; a response
already forwarded is delivered from the fetched response rather than forwarded
again. If forwarding fails, the paused request is closed without a retry and the
fault remains unverified.

Server crashes go exclusively through
`ctx.recovery.restartServer({ signal })`. The orchestrator owns its process,
SIGKILL, same-state restart, health wait, page reload and launcher pairing. F
requires `{ restarted: true, downtimeMs }`; it neither discovers nor kills a PID.
A missing handle records `skipped` / `recovery-unavailable` and stays `unverified`,
also if a handle appears later. F does not arm a missed fault after the final unit.

Fresh `ctx.search` reads the complete target project through the existing native
JQL owner; `ctx.read` verifies its native project identity. Known issue keys/IDs
in intent and the pre-fault native population must remain present with the same
summary. Recorded `sprintId` or `sprint.id` values additionally trigger complete
Agile membership readback through the existing paginator. This preserves observed
membership prefixes across more than three pages. Completed-unit cursors in
`bulkEpics`, `hierarchyBulk`, `progressSimulation` and `sprintBulk` must not regress.
A progress argument alone cannot prove recovery: new native units (creation
scopes), or changed native issue/sprint state (progress scope), must corroborate
continuation. Recovery is recorded only after those facts agree. A second pending
fault cannot overtake an unresolved first one.

StepResult contains the closed step/status/detail and numeric `injected`,
`recovered`, `duplicates`, `lost` counts. Missing handles or evidence stay
`unverified`; observed duplicates or lost records are `red`. Only a complete,
freshly reverified fault plan can be `green`. The hermetic factory tests use an
in-memory intent, fake page routing and the bound recovery stub; they include a
370-unit sequence and multi-page sprint membership. They are not live crash or
model qualification.

## Ordinary Chat response-loss and restart qualification

Run this finite group only after the licensed HTTPS/read/write preflight and while no other
stateful laboratory consumer is running:

```sh
node scripts/testing/jira-chat-lab/chat-faults.mjs "$HOME/.local/share/keiko-jira-4081-new" \
  keiko-qwen36-35b-8bit
```

The ten cases cover create, edit, assign, comment and transition under two explicit
observation faults: a lost response in buffered Chat, and an observed HTTP 503 after the
real effect in streamed Chat. The real model, authenticated normal Chat, vault, catalog,
binder, MCP host and production HTTPS port still execute. After real successful response
headers, a qualification decorator changes only the mutation journal's acknowledgement
and returned HTTP observation. This is an injected observation fault, not a physical
connection failure; the transport Activity Log still records the actual successful status.

Each case persists its private canonical intent before dispatch, requires exactly one
Chat mutation attempt, checks the independent Jira effect, and repeats the canonical
delivery. Create obtains its previously unknown issue key only through an independent
marker/count observation. Edit and assign additionally apply a separately counted foreign
fixture edit, which subsequent replay must preserve. A fresh Node process reopens the same
SQLite database and encrypted credential store, repeats the original canonical delivery,
and uses the existing answer-only Regenerate endpoint. The retained transcript must remain
`unknown`; no restart, duplicate or regeneration may change the independently observed
remote state. An external guard blocks any second attempted mutation and fails the case;
a guard hit cannot produce a passing receipt.

`fault-chat.pending.json` is created exclusively and synchronized before dispatch. An
interruption therefore blocks a new group. The diagnostic command below performs only
independent reads and saves a private reconciliation snapshot; it never resumes a write:

```sh
node scripts/testing/jira-chat-lab/chat-faults.mjs "$HOME/.local/share/keiko-jira-4081-new" \
  keiko-qwen36-35b-8bit --reconcile
```

Never remove an unresolved pending marker to rerun a mutation. Failed groups remain
incomplete until reconciled; a successful group retains its private receipt and removes
the pending marker. The internal `--restart` phase is invoked by the parent harness only
after its effect and replay observations are durably recorded.

Private intent creation uses exclusive creation and synchronizes the file and parent
directory before dispatch. Later snapshots use a private temporary file, file synchronization,
atomic rename and directory synchronization, keeping a complete earlier intent if writing
the replacement fails. On cancellation, the harness interrupts its Chat generations and
drains their existing serializer gates before disposing the database. A bounded drain
failure preserves the open store and retained state; it must never be treated as a completed
shutdown or as permission to replay the pending action.

## Browser response-loss, reload and Regenerate qualification

After building the current UI and completing the same licensed preflight, run this separate
finite two-case group while holding exclusive laboratory mutation ownership:

```sh
node scripts/testing/jira-chat-lab/browser-faults.mjs "$HOME/.local/share/keiko-jira-4081-new" \
  keiko-qwen36-35b-8bit
```

Both cases use the existing real browser Hub/workspace/Chat journey in Ask for approval:
keyboard connection for lost-response observation, native drag/drop for committed-503
observation. The exact comment preview requires a visible decision; the read needs none.
The same production HTTP decorator described above injects the journal-visible observation
after one real Jira comment succeeds; it does not cut the browser socket or claim that Jira
itself returned 503. The browser must display `Jira outcome unknown`.

The harness captures and durably saves the browser's actual canonical request before either
decision. It repeats that exact delivery from the browser, reloads the page, and presses
the visible Regenerate button. Independent Jira reads after each stage must show exactly
one matching comment and a total increase of one; canonical call/result identity and unknown
outcome remain intact. The second-mutation guard must never fire. Screenshots and the full
receipt remain in the private session, and every case checks license validity at completion.

`browser-fault.pending.json` prevents accidental reruns after interruption. The same command
with `--reconcile` only reads the independent comment state and writes a private reconciliation
receipt; it never resumes a mutation. Preserve an unresolved marker and its retained product
state. These cases supplement the fresh-process API matrix rather than claiming browser
restart or physical network-failure coverage that they do not execute.

## Restricted identities and required-field refusals through ordinary Chat

After the current licensed HTTPS/read/write preflight, run these finite groups serially
with the fault and browser groups stopped:

```sh
node scripts/testing/jira-chat-lab/restricted-chat.mjs /absolute/private/session actual-model-id buffered focused
node scripts/testing/jira-chat-lab/restricted-chat.mjs /absolute/private/session actual-model-id stream focused
node scripts/testing/jira-chat-lab/restricted-chat.mjs /absolute/private/session actual-model-id buffered catalog
node scripts/testing/jira-chat-lab/restricted-chat.mjs /absolute/private/session actual-model-id stream catalog
```

Restricted groups explicitly configure `modelRetries: 1` for the existing bounded Gateway schema
repair; other live helpers default to zero, physical model attempts retain budget accounting, and
Jira mutation POSTs are never retried. Each restricted receipt records this configuration. Catalog and lifecycle read fixtures also ask
an explicit natural Jira question; exact tool arguments, outcomes, budgets and single-effect
checks remain unchanged. An incomplete model group never counts as qualification.

The focused group contains eight cases: the isolated identity's visible and hidden issues,
its denied comment, the editor identity's read/edit and denied transition, and omitted required
create/transition fields under the API identity. The latter refusals require **zero attempted
mutation dispatch**; an earlier validation refusal does not invent a write approval. The allowed
editor edit must produce exactly one history increment. Independent administrator reads compare
both projects and their comments, so a denied or locally refused case must leave remote state
unchanged.

The catalog group exercises all fourteen operations under the seeded `restricted` identity.
An independent read-only oracle verifies its identity and lack of all five write permissions,
and records the real read endpoint's bounded identifiers or native refusal. Empty permitted
metadata remains distinct from a hidden/forbidden resource. Every operation then goes through
the actual model, normal authenticated Chat API, first-read grant, catalog binder, MCP host and
credential custody. The oracle is a reference, not a replacement for that product invocation.

The audited mutation certainty rules remain unchanged: a known pre-dispatch refusal is
`rejected`; a dispatched native 400/403/404 retains `unknown` plus its actual validation,
permission or missing-resource diagnostic. An HTTP status alone does not prove that an effect
was never committed. Independent zero-effect observations belong to this controlled fixture;
they do not silently promote the product's outcome. Canonical duplicate delivery of each unknown
turn must preserve user/call/result identities and cause no additional dispatch. The pass-through
observer never alters an HTTP result and refuses an unexpected or repeated write before forwarding.

Each group fsyncs a private intent before sending its model request and retains the product database
and `restricted-chat.pending.json` after an incomplete group. Reconcile those records and Jira
read-only before starting another group; never repeat a possibly executed mutation. A completed
private receipt requires the entire selected group and the closing license check. Preparing or
unit-testing this harness does not count as live acceptance.

## Read-grant reuse after process restart and token replacement

```bash
node scripts/testing/jira-chat-lab/consent-lifecycle.mjs /absolute/private/session actual-model-id
```

This separate four-turn group uses one persisted Chat (set to Ask for approval) and one stable Jira
Pod. The server establishes the grant for the first buffered read (no person decides it), closes the server, and starts a fresh Node process against the retained product store.
The new process sends a **new** buffered read with a new canonical turn identity and proves an
actual Jira request without another disclosure. It then replaces the credential through the normal
authenticated API with the distinct seeded editor token, verifies that the old grant belongs to a superseded authentication generation and that the retired
consent route stays gone, reverifies the Pod, and performs a streamed read on a fresh server-established grant. A final streamed comment reuses
that new grant and requires its own concrete action approval. Independent Jira reads prove exactly
one comment and its editor author, demonstrating that the rotated credential was actually used.

The common Chat observer follows the single newly admitted user row, excluding historical pending
approvals. Grant reuse is explicit and checks the exact existing grant, Chat, Pod, both generations,
state and expiry before sending; a write rechecks the grant before approval. Unexpected new
disclosure fails the reuse proof. Before and after artifact inventories must match, as for the other
live groups. The private pending intent and product database survive failure; never invoke the
internal `--resume` phase manually or replay a potentially dispatched mutation. A completed receipt
requires all four turns, distinct process IDs, independent remote verification, and a closing valid
license check.

## Physical browser connection loss after a committed write

```bash
node scripts/testing/jira-chat-lab/browser-disconnect.mjs /absolute/private/session actual-model-id
```

Run this separate group after a fresh licensed HTTPS/read/write preflight, with other live groups
stopped. Pin both the compiled runtime and the served `packages/keiko-ui/out` files, together with
the browser helper closure, before and after the group. The browser creates and verifies a Pod in
the Hub, connects the ordinary Chat through keyboard workspace ports (the lasso binds at once; the
Connectors panel shows the confirmed binding), selects Ask for approval, reads without a consent
step, and approves the exact comment preview. Jira receives one real request through the production HTTP port; its
acknowledgement is preserved without injecting a Jira fault.

A qualification-only listener on the actual BFF server intercepts the exact terminal SSE `done`
frame. It first checks that the matching user turn and assistant answer are already committed in
the real store, then destroys the actual HTTP response without transmitting that completion frame.
The earlier read-grant (granted, never pending) and write-approval frames remain delivered. Chromium's failed-request metadata
must confirm the interruption. An existing canonical buffered fallback is permitted and counted;
the driver never automatically replays a mutation.

The subsequent reload must display **Jira change confirmed**, preserving the durable `succeeded`
outcome. An explicit canonical duplicate, another reload, and the visible Regenerate control must
retain the same user, call and assistant identities and an independent remote comment count of one.
This physical BFF-to-browser loss is distinct from `browser-faults.mjs`, whose Jira acknowledgement
faults remain `unknown`. Both forms are required; neither substitutes for the other.

`browser-disconnect.pending.json` and the retained product database survive any failure. The same
command with `--reconcile` only reads the remote comment state and saves a private receipt. It never
resumes a write. A complete group writes a private `browser-disconnect-<id>.json` receipt, checks
the license again, and removes its pending marker. Helper tests alone are not live qualification.

On 2026-10-28, the two Jira-acknowledgement browser cases and this separate physical-disconnect
case passed against the licensed laboratory and verified `keiko-qwen36-35b-8bit` model. Each recorded
exactly one independent comment effect, preserved its distinct `unknown` or `succeeded` outcome,
and passed duplicate delivery, reload and visible Regenerate. The physical case recorded a real
Chromium request failure and zero automatic buffered fallbacks. Both groups retained identical
before/after inventories of 6,832 runtime/helper files and 381 served UI files, passed separate
licensed preflights and closing license checks, and left no pending marker. Private receipt digests
are `e76c288a6309cff4c8a6c6c2a2076f1d7f5ea49d16c4bcbadc70d3b84228b868` (Jira observation loss)
and `6d4ccbea70223517c0c6737dddb092df0ef0a7d53ee8b976a93797fa21ac2dd5` (physical browser loss).
These are scoped live proofs; they do not substitute for the remaining final quality gates.

## Mixed Data Pod and Jira Chat qualification

```bash
node scripts/testing/jira-chat-lab/mixed-chat.mjs <private-session> keiko-qwen36-35b-8bit qwen3-embedding:8b
```

This separate live group creates and indexes a real synthetic Data Pod with the named embedding
model, then performs a buffered mixed read and an approved Jira comment through the ordinary Chat
path. It requires the licensed Jira preflight and exclusive access to the laboratory and model
runtimes. It explicitly configures one bounded model schema-repair retry; Jira writes are never
repeated automatically. A completed private receipt requires both turns, Data-only citation lineage,
the correct sourced answer, and exactly one independently observed approved comment.

The complete group passed on 2026-10-28 with the real named chat and embedding models: one Data
citation in each answer, separate Jira attribution, one first-read grant per Chat and one concrete
write approval. All 6,825 runtime/helper files matched before and after; both license checks passed,
and no pending marker remained. The private receipt digest is
`9da82b396b2421c2b81439f74513aa2918238ccc81d4afa17ea384cd9ba186f7`.
An earlier attempt answered only the knowledge question and made no Jira tool call. That attempt
remains an incomplete diagnostic with independently confirmed unchanged Jira state and its retained
database. The accepted fresh group used a clear natural Jira question before the knowledge question;
no forced tool choice, synthetic vectors, substituted model response or relaxed assertion was used.

## Native PAT revocation and stopped Jira verification

```bash
node scripts/testing/jira-chat-lab/verification.mjs /absolute/private/session actual-model-id pat
node scripts/testing/jira-chat-lab/verification.mjs /absolute/private/session actual-model-id availability
```

These are separate finite groups. Run a fresh licensed HTTPS/read/write preflight before each;
retain matching runtime/helper inventories and a closing license check. The availability group
requires exclusive ownership after every other live group, because it intentionally stops Jira.
Both groups require at least fifteen minutes of remaining licence time at admission.

The PAT group follows [Atlassian's native PAT creation flow](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
as the non-admin synthetic API user. It records the existing token IDs and a unique private intent
before issuing exactly one creation POST. The returned ID and token stay in a private 0600 file.
Only this newly created, uniquely named token can be revoked; the shared API/editor/restricted
credentials are protected. The real authenticated BFF creates and verifies its credential, then
verifies a fresh authentication failure after native revocation and checks generation invalidation.
A separately invalid token must also produce `auth-failed` through the same production path.

The stale-response case delays one actual successful Jira `myself` response using the existing
qualification transport decorator. It releases that response only after the new verification has
observed revocation. The old response must receive `409 CREDENTIAL_CHANGED` and cannot overwrite
the failed current metadata. This is an observation-order test, not a claim that Keiko knows about
an external revocation before receiving evidence of it.

The availability group validates the exact synthetic Compose project, pinned Jira image,
loopback port and existing service identities. It stops only that Jira container; TLS, PostgreSQL
and persistent volumes remain present. The real BFF verification must become `unreachable` and
invalidate the old verified generation. Recovery requires both container health and the valid
license endpoint: Jira can report `healthy` before its license plugin is ready. Only that
read-only readiness check is retried within the existing five-minute limit; service identity
and volume mismatches fail immediately, and no mutation is repeated. The same Jira container
is restarted in `finally`, even
if the verification or recovery-intent journal fails. Recovery requires Docker's configured Jira
health check, the original service and volume identities, a valid license and the ordinary
HTTPS/read/write preflight, followed by successful BFF reverification. No volumes are removed and
no license state is edited.

Incomplete runs retain `verification-pat.pending.json` or `verification-availability.pending.json`,
the private token record and the product database. Never repeat an uncertain PAT creation POST.
Reconcile the retained identity before any cleanup. If the process itself is killed during the
outage, the retained intent identifies the one container that must be restored before another
laboratory group. Completed receipts contain only the closed scenario outcomes; preparation and
unit tests do not establish native live acceptance.

## Requirements scenario scorecard (epic #4173)

`requirements/` holds the lab of epic #4173: the scenario catalog S01–S20, a model-free probe
layer, end-to-end Chat journeys and the scorecard that combines them. Every check is graded by an
independent oracle (Jira REST/JQL reads or the generated ground truth), never by the model's own
answer. `catalog.mjs` lists each scenario's obligations; a check names the obligations it covers
(`covers`) and `coverage.mjs` awards green only when every obligation is covered by a passing
check, one of them an end-to-end journey. A journey that verifies only part of the contract leaves
the scenario `partial` (a check grades only the parts the instance gives input for: S10 credits
per-epic progress and estimate totals only when the seeded project has the Epic Link and Story Points
fields),
and an obligation nobody covers keeps it from ever turning green. Creation journeys (S05, S07,
S17) read the matching Jira issue keys before the turn and grade only the keys that appeared
during it, so earlier journeys, reruns and the Jira actor's timezone cannot leak into the verdict.
S05 additionally requires exactly one write approval for its batch, S04 requires title, priority
and chapter per requirement, S11 each seeded deviation twice over (the structured `jira.report` result of the turn names it for
that issue, and the answer describes it: a clause that names the field and states a violation,
under no denial. An answer such as "Keine Abweichung" or "vollständig und korrekt", a heading such
as "## No deviations found" over the list, a bare list of the checked fields and "sind vorhanden"
leave it undescribed, and a turn without a completed `jira.report` deviation list credits nothing
and leaves S11 partial), and S17 three parts (`backlog-turn.mjs`): a one-to-one mapping of the new
epics onto the Muss requirements plus every created key in the answer; the Settings readiness run
(`POST /api/gateway/readiness`, the trigger of the 2026-10-31 refusal) started once the first tool
call is visible and finished while the turn still ran, without a generation-changed refusal; and a
second turn for the Soll requirements whose Chat mode is changed after its first completed write,
which ends the admitted turn early, so the product's early-ending answer must name exactly the
epics Jira shows as created (evidence: a new `chat.tool-turn.ended` line in the Activity Log). A part
whose evidence is absent is `unverified`, covers nothing and leaves S17 `partial`. S15 adds a second
turn (`draft-findings.mjs`) that drafts epics for one seeded vague requirement and one without
acceptance criteria and credits `findings-attached-to-epic-draft` only when the epic Jira holds
states, in its trace footer (`Quality findings:`), exactly the closed codes the production quality
checks derive for that requirement; an epic without a footer is `unverified`. S16 adds a turn
(`template-test-cases.mjs`) under a REQ Task template that defines the form (sections `Schritte` and
`Erwartet`, summary `<id>/AC<n>`; Task rather than Sub-task, which would need a parent chain) and
credits `template-defined-format` only for exactly one conforming, requirement-labelled issue per
criterion of LH-002; the template is removed afterwards. Both write REQ, so they take the work lock
and prepare REQ like S05. An epic for a requirement without criteria stays satisfiable under an epic
template: the section needs text, not criteria, so the draft can state that none are defined.
S14's `edits-proposed-as-draft` is moved to follow-up #4196 by owner decision: the scenario declares
it under `deferred` with the issue number, `coverage.mjs` accepts a deferral only with an issue
number, and the scorecard row prints "deferred to #4196" so a green S14 never reads as covering it. S10 asks for three strict line formats
(`ANZAHL;type;status;n`, `EPIC;key;members;done`, `SCHÄTZUNG;total;done;remaining`) and grades them
against the issues Jira holds.
Its fourth obligation, `large-project-report`, runs a second turn in a fresh Chat for the report
project LRG (`large-project.mjs`): 45 epics with their tasks and bugs, 2,490 issues in all, seeded
with a deterministic status spread. The oracle counts what Jira holds by JQL alone (total, per
status category, per type, per type and status, per epic through its Epic Link) and requires the
completed `jira.report` of LRG (its progress figures, the type/status rows, the epic count and
every epic, from the summary, the epic pages or the plain figure lines) and the answer's
`ANZAHL`/`EPIC` lines to equal it exactly. No product size limit is encoded. A laboratory without
LRG, a turn without a complete report of LRG, or a project that no longer holds what the seed
recorded leaves the part `unverified`: it covers nothing and S10 stays `partial`. S12 grades a strict `LH-nnn;ABGEDECKT|OFFEN;keys` matrix against the issues
that name each requirement (tokenised like the product) and requires the complete `jira.report`
result of the turn to state the same. S13 exports the finished report through the report card's
route (CSV must list exactly the issues Jira holds, both files must carry the tool's digest) and
requires exactly one new Jira comment that is the tool's computed comment text verbatim. S01, S02
and S06 drive the skill-library template routes (`/api/skills`, `/api/skills/jira-templates`) with
the template the structure rules describe (`templates.mjs`); the template is deleted again when the
journey ends, because the library activates every valid template for every later write. S06 stays
`unverified` unless the product actually refused a violating write in the turn. S20 (#4176 AC4)
plans a task into the work project's lab sprint by name and id (`field-correction.mjs` creates the
sprint once through Jira Software's board API). Keiko forwards the sprint field as opaque JSON, and
Jira accepts it only as one numeric id while its metadata declares an array of strings, so Jira's
own error decides the value. S20 is green only when a write result carried Jira's sprint error
(never Keiko's own validation) and a later write put exactly one new task into that sprint; a
correct task without any Jira rejection leaves it `unverified`. The oracles are unit-tested
with stubbed turns in `scripts/__tests__/jira-lab-requirements-scorecard.test.mjs`.

```sh
# Once per session: the empty work project REQ and the report project RPT with known ground truth
node scripts/testing/jira-chat-lab/requirements/seed-projects.mjs /absolute/private/session

# A laboratory seeded before LRG existed gets the large project added without a reset: it makes
# about 2,500 issues and 1,600 transitions, leaves REQ, RPT and the other entries of
# requirements-truth.json untouched, and does nothing when LRG is already recorded. A project LRG
# that holds issues the truth does not record (an interrupted run) is refused: delete it first.
node scripts/testing/jira-chat-lab/requirements/seed-projects.mjs /absolute/private/session --only LRG

# Once per session, after the seed: a real estimate for RPT. Story Points where Jira offers the
# field on Task create and edit (found by schema, put on the project's screens); otherwise Jira's
# time tracking (Original Estimate, one hour per seeded point, so time tracking must be enabled).
# It writes the seed's estimates on every Task, then records fieldIds.storyPoints (the field the
# oracle sums), estimate {fieldId, writeFieldId, unit, label} and the Tasks' "estimate" deviations
# in requirements-truth.json. S10 asks for time-tracking totals in hours and grades them exactly
# against the seconds Jira holds. Idempotent; without it S10 cannot grade estimate totals.
node scripts/testing/jira-chat-lab/requirements/seed-estimates.mjs /absolute/private/session

# Fast probes only (seconds, no model)
node scripts/testing/jira-chat-lab/requirements/scorecard.mjs /absolute/private/session --project REQ

# Probes plus Chat journeys through any configured Gateway model, for example local LiteLLM
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  node scripts/testing/jira-chat-lab/requirements/scorecard.mjs /absolute/private/session \
  --project REQ --model <chat-model-id> --embedding-model <embedding-model-id> [--only S04,S05]
```

The probes of S05, S07, S08 and S09 prove `fields-writable` by writing. `field-writes.mjs` takes every field Jira lists for the issue type on create and on edit, writes it alone through Keiko's production mutation path into its own project `FLD`, and reads it back from Jira. Comment, attachment and link take their own calls and must land the same way. Jira's own refusal of a value, such as a sprint on a sub-task, is listed in the check's detail and does not count against Keiko. A refusal that never reached Jira, a failure after the write, or a value Jira did not keep turns the scenario red.

A scenario is `green` only when every obligation is covered AND its end-to-end journey is green;
probes that cover everything beside an `unverified` journey leave it `partial`. A check the
laboratory cannot trust is `invalid`, never `red`: a native-Jira, fixture, license or transport
exception (`lab-error`), a model that fails a short readiness turn before the journey while the
Activity Log of that turn shows an infrastructure failure or the error is a transport signature
(`model-unavailable`), and a non-green journey during which the gateway failed (`gateway-failure`). Infrastructure failure is read from the Activity Log lines of this server
process inside the window, grouped by correlation: a `gateway.chat.failed`/`gateway.stream.failed`
correlation that contains `gateway.retry.exhausted` or a `gateway.circuit.*` event; circuit events alone are only reported. A readiness-turn deadline abort (by error name) is `model-unavailable`. A failure with neither (context overflow, refused attempt) is a product
outcome and stays red. A failed Keiko route (`Live Chat HTTP stage failed`, also from the readiness
turn when no outage is shown) is red with reason `product-route-failed`. A green journey stays
green. Any red check decides the scenario before invalid. `latest.md` and `trend.tsv` carry an
`invalid` column; a run with any invalid scenario is labelled `INVALID RUN` / `validity=invalid`
and is not a data point (an older trend file with another layout is kept aside).
`modelUnavailable` (`journeys.mjs`) and `isTransportFailure` (`validity.mjs`) are reusable by other
lanes.

`--repeat N` (default 1, at most 20) runs every journey N times in fresh Chats. Each scenario
reports every run, the pass rate over valid runs and the invalid count (shown next to the status).
It is green only when every valid run is green and at least ceil(N/2) runs are valid, red when a
valid run is red, otherwise invalid (`insufficient-valid-runs`).

The scorecard writes `requirements-scorecard/<timestamp>.json`, `latest.md` and `trend.tsv` into
the private session. Before a group it checks the remaining license time: the published test
license counts from Jira's start, so `requirements/license-window.mjs` stops and starts the
session's containers (volumes retained) when the window runs low. It never changes clocks,
licensing code or license data.

The synthetic corpus (`requirements/corpus.mjs`) is a fictional requirements specification in two
versions with seeded quality defects. Its truth records each requirement completely (id, title,
priority, chapter, text, acceptance criteria), and every rendering (Markdown, Word, Excel,
PowerPoint, PDF) carries all of it; `jira-lab-corpus-documents.test.mjs` extracts the records back
out of each format and compares them, including the v1 to v2 changes, with the truth; `STRUCTURE_RULES` is the lab's stand-in for the issue
templates a project lead defines. Lab code may know Jira Software's field schemas to seed ground
truth; the product under test may not.

## Baseline templates: every lab write is governed (#4369, #4354)

The product refuses a Jira write that no stored template governs. The existing lab lanes write
without a template of their own (the document lanes, the project and role journeys, catalog Chat,
the selection write cases, the restricted cases and the whole model-free AC7 driver), so one module
keeps them working: `requirements/baseline-templates.mjs`.

- **What it seeds.** At every lab product start, one fixture template per lab project and per issue
  type that project has, imported through the product's own skill library routes (the path
  `withTemplate` uses) and read back from the listing. Each template is named `Lab baseline <PROJECT>
<Issue type>`, activates on `[create, edit]`, and carries one rule that no Jira summary can break
  (`summaryMaxLength: 255`; the parser requires at least one rule). A plain activation governs every
  write of that project and type under the current and the planned contract; `transition:<target>`
  only adds rules for entering one status.
- **Where it runs.** The templates live in the product's skill library, which is per product
  instance, so the hook is the product start in `chat-read.mjs` (`runLabProduct` and the owned-child
  path), shared by the Chat lanes and the model-free `withModelFreeJira`. A retained state that
  already holds a pair is left untouched (idempotent); a missing pair is imported.
- **Projects and issue types** are read natively as the lab administrator on every start
  (`GET /rest/api/2/project`, then each project's `statuses`), bounded to 100 projects, 50 types per
  project and 96 pairs in all (the library holds 128 skills). A listing that cannot be read or a
  library that does not list every pair afterwards fails the lane as a lab error, never silently.
- **Lab instances only.** The seed asserts `KEIKO_OS_KEYCHAIN=off` and a state directory the lab
  created itself (`keiko-jira-live-chat-*`, under the session or the OS temporary directory). It is
  never written into a real state directory.
- **Journeys that install their own templates** keep them in full: the product ANDs every governing
  template, so the rule-free baseline never narrows a journey's rules, and the journey's cleanup
  removes only its own template.
- **Opting out.** A lane that proves "no template governs" starts without the baseline. The
  per-call option `baselineTemplates: false` (default on) exists on `withLiveChat` and
  `withModelFreeJira`, so one journey of a run can differ from the others; the environment value
  `KEIKO_JIRA_LAB_BASELINE_TEMPLATES=off` is the global switch and wins over a `true` option.
  `withBaselineSuspended(request, projects, body)` removes the baseline for the duration of `body`
  and seeds it again, verified, afterwards; it is for a journey that must switch inside one product
  instance and is not wired anywhere.
- **Effect before #4354.** The baseline adds no refusal: a template that cannot be violated changes
  no verdict. It is not free of side effects, though. A template that activates on `create` switches
  on the product's draft preflight (`firstJiraDraftTemplateRefusal`), which reads Jira once per draft
  item before approval. A lab draft therefore causes extra native Jira reads (the create metadata
  and field catalog) and a different read order. Writes, their dispatch count and their order are
  unchanged. Of the lane observers, only `consent-lifecycle` counts reads (`GET` of one issue key)
  and `pagination-chat` inspects search pages; neither observes the reads the preflight adds, and
  the write witnesses (`restricted-cases`, the project-agile witness, the AC7 runtime) let `GET`
  requests pass uncounted. A new lane that counts or orders native Jira reads of create drafts must
  start without the baseline. After #4354 the baseline is what lets the existing lanes write.

## Moving the laboratory to the next Jira Data Center release

The release is pinned in three places that must name the same `tag@sha256:digest`: the `jira`
service image in `compose.yaml`, the `JIRA_IMAGE` constant in `verification.mjs` (which the native
verification compares with the running container) and its mirror in
`scripts/__tests__/jira-native-verification.test.mjs`. Take the new digest from the registry
manifest of the release tag, never from a floating tag. The version also appears in prose in this
README and in `docs/local-knowledge/atlassian-connector-guide.md` ("Bounded Data Center support");
change the guide only after the qualification below passed, because it states which version the
product accepts.

A new image needs a fresh session (`session.mjs init`, an empty directory): an existing database
volume belongs to the old release and Jira's upgrade is not part of this harness. Then rerun, in
order: `setup.mjs`, `seed.mjs`, `qualify-fields.mjs`, `seed-content.mjs`, the product HTTPS
verification and the Chat read and write groups above, `seed-projects.mjs` and `seed-estimates.mjs`,
and the requirements scorecard with a model. Compare the new scorecard with the previous
`trend.tsv`; a changed REST schema, permission refusal status (the content seed records Jira's
400 for a denied write) or field schema shows up there first, and the oracles that name such a
detail are the lab code to adjust. Product code never gains a version-specific branch for it.

## Reusable limit-run blocks

The orchestrator imports these six async exports directly:

- `installTemplates(ctx)` from `templates.mjs`.
- `runRuleProbes(ctx, { modes })` from `browser-rules-knowledge-journey.mjs`.
- `runProjectSetup(ctx, { deniedActor: true })` and
  `runSprintBulk(ctx, { size: 300, batch: 50 })` from `browser-project-agile-journey.mjs`.
- `assertCardsReadable(ctx, { reload: true })` and `setUiLanguage(ctx, "de" | "en")`
  from `browser-a11y.mjs`.

All blocks use the runtime `ctx.projectKey`, the orchestrator's existing Chats and
`ctx.turn(chat, prompt, extra)`. State is stored only through `ctx.intent.record`.
Project setup requires the separate verified restricted `ctx.deniedChat`; its
absence returns `unverified` with `denied-chat-unavailable`. No block creates or
rebinds a Chat or persists a PAT value.

Sprint bulk selects 200–300 existing unfinished backlog Tasks, records their exact
identities and moves them in batches of at most 50. The native oracle compares
more than three membership pages, both full-size lifecycle refusals, five Done
Tasks and the remaining backlog after completion. It creates no issues: 200 Tasks
require 12 writes, 300 require 14. Unconfirmed receipts remain `unverified`.
Card checks use the ordinary Settings language control, reject raw JSON and
generic result rows, require zero serious/critical axe findings and compare keys,
links, history and native state across reload without replay. Hermetic tests are
not live Jira/Keiko/model acceptance; the integrator owns that coordinated run.

### License window of the limit run

The published three-hour test license is shorter than a full limit run. At each step boundary
(never inside a step or a browser turn) `browser-limit-run.mjs` therefore calls the scorecard's
`renewLicenseWindow` (`requirements/license-window.mjs`) with the step's minimum
(`limit-run-license.mjs`): 1800 seconds by default, 7200 for `ac2-epics`, 5400 for `ac4-hierarchy`,
`ac6-sprint` and `progress-simulation`, and 3600 for `ac3-report`. If less remains, the owned
session is restarted normally (`session.mjs stop` then `start`, its own compose project only, which
opens a new window; never clocks, licensing code or data) and the run continues once Jira reports a
valid license. Keiko and the browser keep running: the Jira Pod sends its stored PAT on every
request to the unchanged lab origin, and the PAT lives in the retained database. A renewal waits
for other active lanes of the same session directory, and a failed renewal or a window that is
still too short stops the run. Each restart is recorded in the run intent as `licenseRenewal`
(`phase`, `count`, `step`, `remainingBefore`, `remainingAfter`, `downtimeMs`). A side-by-side lab
of another project is never touched; starting this session beside it needs the exact
`KEIKO_JIRA_LAB_PARALLEL=allow` for the restart too.

## Selective follow-up steps: Story and Coding Workbench

`browser-limit-run.mjs` always runs every step and reserves `browser-limit-run.pending.json`
exclusively, so it cannot be started again for the same session. Two steps that the limit run does not
cover run afterwards, on the finished run's retained product state, without repeating any earlier step:

```bash
node scripts/testing/jira-chat-lab/browser-limit-followup.mjs \
  <session-dir> <model-id> <embedding-model-id> <permitted-token-file> <denied-token-file> \
  <LIM-project-key> story,coding-jira
```

The first six arguments are exactly those of the limit run. The last one selects the steps, `story`,
`coding-jira` or both (always in that order); each step may be selected alone and run again. The
follow-up refuses to start unless `browser-limit-run.pending.json` is `completed` with
`steps-verified`, green `ac2-epics` and `ac4-hierarchy`, and the same inputs. It reopens the retained
state directory, the three Chats and both Pods, copies the finished run's state into its own
`browser-limit-followup.pending.json` and never rewrites the original file. An interrupted follow-up
resumes from its own checkpoints; it never replays a write whose outcome is unknown. It takes the same
`browser-limit-run-owner` lock, so it cannot overlap a limit run. The Jira license window of 30 minutes
and an idle Jira laboratory, model and Keiko instance are required, as for the limit run.

**`story` (`ac4-story`), about 25 to 40 minutes.** A project lead's templates come first: through the
Skills dialog the step installs a `Story` template (sections Nutzerziel, Akzeptanzkriterien,
Definition of Done, Epic link required) and replaces the limit run's `Sub-task` template, which admits
only a Task parent, by the same template with `parentIssueTypes: ["Task", "Story"]`. Only a template
byte-identical to what the limit run installed is replaced; any other content stops the step as
`unverified`. Then two ordinary Chat turns in the document Chat (Lastenheft Knowledge Pod plus Jira
Pod) create three Stories under the Epics of three requirements that carry at least two acceptance
criteria, and then one Sub-task under each Story. Summaries are `[REQ-...] [ST-n] <title>` and
`[REQ-...] [ST-n-S1] <title>`. The oracle reads Jira over REST and asserts: issue type `Story` and
`Sub-task`; Epic link of every Story; `parent` of every Sub-task, whose parent type is `Story`;
template sections and required create fields of both types; the product's own Keiko traceability
footer with the requirement id and source; every acceptance criterion verbatim, once, with none
invented; zero duplicate keys, ids, summaries or draft identities; zero Story or marked issue outside
the plan. A partial or unknown earlier write is `unverified`, never repeated.

**`coding-jira` (`ac10-coding-jira`), about 10 to 20 minutes.** A second, headless browser pairs with
the same Keiko instance, opens the Coding Workbench on the lab workspace, selects the model, Full
access and `Jira: Limit Run Jira`, and starts a run through the ordinary UI that asks for the number
of Epics and the first five Epic keys without editing anything. It is green only if the run succeeded,
its answer states the exact Epic count and all five lowest keys that a Jira REST readback holds, Jira
itself is unchanged (same issues, same update times), and the Activity Log holds, inside the run, a
`coding-runtime.jira-pod` `bind` line, at least one completed `jira-read` `call` line and no
`jira-write` line. That operation is emitted only by Coding runs, so it proves the Jira tool was
called from the Coding surface. A Keiko without an available coding runtime reports `unverified`
(`coding-runtime-unavailable`), not green.

Evidence: `story-bulk.json` and `coding-jira.json` in the session directory (counts only) and the
results in `browser-limit-followup.pending.json`. The earlier `ac4-hierarchy` oracle counts a Story as
unexpected, so do not run the limit run's hierarchy step against a project that holds these Stories.
Hermetic tests: `scripts/__tests__/jira-lab-story-bulk.test.mjs`, `jira-lab-story-templates.test.mjs`,
`jira-lab-coding-jira.test.mjs` and `jira-lab-limit-followup.test.mjs`; they are not live acceptance.

## Release 1 lab: fixtures, German session, private address, renewal (#4369)

**Which fixtures a fresh session holds.** `node release-1-fixtures.mjs <session> --inventory` reads them
natively and prints closed facts; a missing fixture reads `false` or `0`, never an error.

| Need of the Release 1 walk                                          | Provided by                                                                                      | Inventory fact                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| A restricted second identity (reads `ISOLATED`, refused on `KEIKO`) | `seed.mjs` (restricted PAT) and `seed-permissions.mjs`                                           | `restrictedSecondIdentity`                         |
| A required custom field (`Keiko required text`)                     | `qualify-fields.mjs`                                                                             | `requiredCustomFieldOnCreate`                      |
| The required field on a transition screen (Done)                    | `qualify-fields.mjs`                                                                             | `requiredFieldOnTransitionScreen`                  |
| Pagination volume beyond three pages of 100                         | `LRG` of `requirements/seed-projects.mjs` (2,490 issues) and the 21 issues of `seed-content.mjs` | `paginationIssues`, `paginationMoreThanThreePages` |
| A project whose issue types differ in their estimate field          | `requirements/seed-estimate-mix.mjs` (`EST`)                                                     | `estimateMixTypes`                                 |
| Epic Link and Parent Link side by side                              | `requirements/seed-parent-fields.mjs` (`PAR`)                                                    | `parentFieldsSideBySideTypes`                      |
| A German-language Jira                                              | `seed-language.mjs`                                                                              | `language`                                         |

`node release-1-fixtures.mjs <session> [--language de]` completes a seeded session with the last three in
the one order that works and prints the inventory. Seed first (`seed.mjs`, `qualify-fields.mjs`,
`seed-content.mjs`, `requirements/seed-projects.mjs`, `requirements/seed-estimates.mjs`).

- **`EST` (estimate mix).** A project created from the Scrum template through REST offers Story Points on
  Epic and Story only, through the field's own Jira Software context. The seed adds Story Points to the
  default screen and time tracking to the Bug screen alone, so one project holds three shapes: Epic and
  Story carry Story Points, Bug carries Original Estimate, Task and Sub-task carry no estimate field.
  `<session>/estimate-mix-truth.json` holds, per type, what Jira's create metadata offers and the
  `estimated`, `unestimated` (offered but empty) and `notApplicable` counts, read back natively. A report
  that stops at the first issue of a type without the field, or that counts "not applicable" as
  unestimated, is graded against it.
- **`PAR` (parent fields).** Epic Link (Jira Software) and Parent Link (Advanced Roadmaps,
  `com.atlassian.jpo:jpo-custom-field-parent`) are found by schema type and offered together on Epic,
  Story, Task and Sub-task; Bug keeps Epic Link only. An instance without the Parent Link type fails the
  seed closed: the lab never stands in for it with a text field of the same name.
- **German session.** Jira Data Center localizes per user, and Keiko acts as the lab actor whose token it
  holds. `seed-language.mjs <session> de` sets `de_DE` for every actor except the administrator through
  `PUT /rest/api/2/mypreferences?key=jira.user.locale` (the body is the bare locale text) and proves it
  by native reads: statuses read `Zu erledigen`, `In Arbeit`, `Fertig`. `en` restores the default. The
  administrator stays English because the lab's administration automation drives labelled English pages,
  and the German locale is applied last: `qualify-fields.mjs` failed on localized names (observed
  2026-11-13). The report counts by status and the JQL by issue type name must work in this session.
- **HTTPS front on a private address.** `KEIKO_JIRA_LAB_PRIVATE_ADDRESS=<private IP>` at
  `session.mjs init` records one RFC 1918 or link-local IPv4 address. The certificate then names
  it, the Host guard accepts it and `compose.private.yaml` publishes the TLS port on it beside loopback, so
  a private-class Jira URL can be walked live and a Windows guest reaches the lab without a tunnel.
  Loopback, wildcard, IPv6 and public addresses are refused; without the variable nothing changes.

**Limit of the renewal (AC4).** A token revoked outside the lab is not recreated automatically: the owner of the
tokens refuses to guess (`active-token-not-observed`, `initial-creation-unreconciled`) and the operator restores it by
hand (remove the actor's `*-token` files and its `pat-creation-started` marker, then run `fixture-tokens.mjs`).

**Document set and language.** The requirements (document) set reads the oracles as the administrator for a session
without `language.json`, for any `en_*` and for any other locale, and as the localized lab actor only for `de_DE`; it
refuses nothing, so its default path stays byte-identical for sessions that never ran `seed-language.mjs`. The Composer
set refuses a session without a language record and any locale other than `en_*` and `de_DE`.

**Renewal and isolation.** Every run starts with `prepareLabRun`: the license window (`ensureLicenseWindow`
restarts the owned lab), the Personal Access Tokens (`ensureFixtureToken`) and the TLS certificate
(`tls-window.mjs` runs the owned session's `start`, which regenerates the certificate generation and
recreates only the TLS front) are renewed by the run itself, at a boundary where no other lane uses Jira.
The limit run additionally checks the license window before every step (`ctx.checkLicense`). The lab sets
`KEIKO_STATE_DIR` to `<session>/chat-read-logs` for its process and every child beside `KEIKO_MEMORY_DIR`,
so no diagnostics writer falls back to `<cwd>/.keiko`.

**Selection lane.** `catalog-selection.mjs` holds a case for `jira.update-comment`, `jira.get-comment`,
`jira.create-issue-link`, `jira.link-types`, `jira.users`, `jira.myself`, `jira.fields`,
`jira.priorities`, `jira.statuses`, `jira.resolutions`, `jira.project-statuses` and `jira.delete-issue`, all
on lab-owned objects (a comment the api actor owns, and a fresh issue for each delete attempt). The report
and `latest.md` carry a `jira.describe` line counting, per valid turn, the catalog's `invalid-arguments`
refusals of the model's selection call, which the gateway-level refusal count never sees. Run new cases
alone and repeat them: `node catalog-selection.mjs <session> <model> --only <ids> --repeat 3`.

**Oracles.** Every report grader reads numbers and rows through `requirements/answer-cells.mjs`
(German `1.170`, `;`, TAB and Markdown rows). S16 names the failed check (`summary`, `label` or `section`)
with a count of issues each. S17 grades the interruption `unverified` when the 1,800 s lab limit ended the
turn, like the refresh part.

**Limit run without the sprint package.** `node browser-limit-run.mjs <session> <model> <embedding> <permitted-token>
<denied-token> <LIMn> --steps without-sprint` runs templates and probes, the bulk write with deliberate
violations and the kill at about 40 %, the hierarchy with relations, the report compared with JQL, and the
English and German card checks, and leaves out the sprint-at-scale package (Agile child). It prints one
closed verdict per step. Because a package was left out, its overall verdict is `partial`, never `green`:
the printed line and the orchestrator record carry `steps: "without-sprint"`, `partial: true` and the skipped
step names, and only a full set can end `green`.

## Composer lane: Jira writes from the Chat composer (Release 1, #4369)

A second lane inside this lab, not a second lab: same Jira, fixtures, template helpers, native oracles,
scorecard, coverage, repeat and validity machinery. It needs **no Knowledge Pod and no requirements
document** and **assumes no model**: it runs with any lab gateway configuration. Its Chats are bound to the
Jira Pod only (no Knowledge scope, no structure skill, no `prepareDataPod`), and its scenarios have their own
ids, `C01`–`C09`. `S01`–`S20` and the document lane are unchanged; the lane adds only parameters and exports
to existing modules, and a hermetic test pins that a run without `--set composer` still prepares the Pod
and binds it.

```sh
# The whole lane, three rounds each (a reachable Jira and a model slot are required)
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  node scripts/testing/jira-chat-lab/requirements/scorecard.mjs /absolute/private/session \
  --project REQ --set composer --model <chat-model-id> --repeat 3

# One scenario, one type, one mode (a first functional pass on any gateway)
... scorecard.mjs /absolute/private/session --project REQ --set composer --model <id> \
  --only C02 --types task --modes ask
```

`--only` takes only ids of the selected set (`C01`…`C09` with `--set composer`); anything else is a usage
error, never an empty report. `--types` (`epic,story,task,sub-task,bug`) and `--modes`
(`ask,supervised,full-access`) narrow C01, C02 and C03; obligations of what was not selected stay uncovered,
so the scenario reads `partial`. The report goes to `<session>/composer-scorecard/<model id>/` (`latest.md`,
a JSON report and `trend.tsv`), apart from `requirements-scorecard/`, and its header names the model.

Every journey empties the work project REQ first and creates its own parents natively (an Epic and a Task;
required fields are read from REQ's own create metadata). From `requirements-truth.json` the lane reads only
`fieldIds.epicName` and `fieldIds.epicLink`; C07 (S10 and S11) needs the whole file. A template of the
work project that this lane did not create stops the journey as a lab state (`invalid`), a leftover of this
lane (named `…-Composer-<Type>`) is removed at journey start, and a template named as a baseline is allowed for
the types a journey governs itself. C03 and C04 prove a missing template, so the scorecard runs them in their
own product start with `KEIKO_JIRA_LAB_BASELINE_TEMPLATES=off`.

| Id  | Obligation (graded from Jira, never from the product's answer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | With templates for Epic, Story, Task, Sub-task and Bug active at once, a plain titled instruction creates each type conformant (Story, Task and Bug in the named Epic, the Sub-task under the named Task, the Bug linked to it); one request creates three Tasks: all exist natively (hard), every key stands in a stored write result of the turn (hard, `multi-create-keys-listed`), and the answer lists every key (soft, `multi-create-answer-keys`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C02 | A request that violates the template is refused before any approval card and before any effect, per type and in each of the three autonomy modes; the corrected request then succeeds. A violating issue that exists in Jira is red whatever the tool trace says (15 runs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C03 | No template for the type, per type and mode, three obligations: `no-template-refused-*` (hard) nothing was created natively, any type; `no-template-hint-*` (hard) the stored tool exchange of the turn carries the product's closed missing-template refusal and its own guidance text, both derived from the producer of the build; `no-template-answer-*` (soft) the answer mentions the template and claims no created issue. **The hard hint half is `unverified` until the producer defines the refusal (#4354)**                                                                                                                                                                                                                                                                                                                                                                                     |
| C04 | The edit rules, compared natively before and after: a breaking edit (clear a section, remove the parent) is refused through any tool; an edit of an issue with a pre-existing violation in an untouched field passes with the product's stored notice (hard, `edit-preexisting-notice`) and the answer names the violation (soft, `edit-preexisting-answer`); an edit of a type without template and a status change without template pass. The breaking-edit obligations are red until #4354 lands                                                                                                                                                                                                                                                                                                                                                                                                         |
| C05 | One conversation, three turns in ONE Chat: an order creates one Task; the product's stored conversation is read again and must hold the messages the turn observed (`stored-conversation-matches-turn`; the lab has no browser and performs no page reload: it is a second read of the stored messages); the same order is sent again after that read (`repeat-after-reread-*`), and once more straight away (`repeat-in-chat-*`). Each repeat has a hard obligation (`repeat-after-reread-no-duplicate`, `repeat-in-chat-no-duplicate`): it created no issue of ANY summary or type and the issue of the first order still carries its title (a second issue is red as a model finding), and a soft obligation (`…-reply-refers`): the reply refers to the first issue by key in the answer or in a stored result card. A step that failed or answered nothing leaves the obligations unverified           |
| C06 | The three modes and a readable approval, with the document lane's S18 grader and a plain Bug request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C07 | S10 and S11 unchanged, in a Jira-Pod-only Chat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C08 | "Add me as a watcher", "write this comment" and "remove me again" by plain instruction: the native watcher list, the comment body and its author; no template involved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C10 | A template written for a LOCALIZED issue type (a German lead types the name the German session shows, `Aufgabe`) must govern a create, whoever asks. One violating Task request is sent three times: template by name with a German profile (`localized-template-german-user-governs`), template by name with an English profile (`localized-template-english-user-governs`, the customer's case: the product compares the free string with the type name the calling user's token shows, so it answers `template-missing`; red until the product binds by id) and template by id with an English profile (`id-template-english-user-governs`). Hard: the stored refusal is a content rule of the template, never `template-missing`; an issue created without any refusal is red too. Needs a session that recorded its type names, else `unverified` with no turn; runs without the baseline template set |
| C09 | A request to attach a file: nothing reaches Jira, no attach call succeeds or is offered and no write succeeds (hard, `attachment-refused`; a turn that failed or answered nothing is `unverified`), and the answer says attachments are not part of this release (soft, `attachment-answer-readable`). Red until #4354 lands; no attachment case exists anywhere else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Reused by parameter, not copied: `templateMarkdown` (`activateOn`), `gradeTemplateRepair` (`conforms`),
`templateRefusals`, `modesAndReadableApproval` (`promptFor`, `query`), `runJourneys` (`set: "composer"`),
`JOURNEYS.S10`/`S11`. A grade of `red` is a product finding, never `invalid`: only a lab outage, a transport
failure, a lab state (a foreign template) or missing gateway evidence makes a run `invalid`.

The selection lane (`catalog-selection.mjs`) holds one create case per issue type: `create-task` and
`create-subtask` in the fixture project, and `create-epic`, `create-story` and `create-bug` in the Scrum
work project REQ (the fixture project offers only Task and Sub-task; a session without REQ makes those three
invalid, never wrong). The REQ cases hold the work-project lock a journey's reset takes.

**What the REQ create cases ask of the product.** `create-epic`, `create-story` and `create-bug` name only the issue type
and the summary. REQ's own required fields are the Epic Name (Epic) and, on every type, the system field `reporter`. The
product's creates in the Azure pass of 2026-11-13 carried no `reporter` and succeeded, so the product path needs none; the
lab's own native fixture creates fill it with the creating account. The Epic Name is not filled by the product: finding it
through `jira.create-fields` and supplying it is part of what the case asks the model, and a refusal that names it is
recoverable in the same turn. The baseline templates of the lab add no rule (see "Baseline templates"), so no template
refuses these prompts.

**German session and the Composer lane.** `seed-language.mjs <session> de` sets the actors' profile language and
records the localized issue type and status names next to the administrator's English ones, joined by id
(`language.json`: `issueTypes`, `statuses`). The Composer lane takes every localized name from that record, never from
a word list: templates are written by the name the German session shows (`Aufgabe`, `Sub-Task`) or by id, the parent
type of the Sub-task template likewise, and the requests speak a German person's words (`eine Aufgabe`, `eine
Teilaufgabe`, no English type name). Every Composer journey but C07 reads the native state as the administrator
(English names), so nothing is loosened: the graders keep comparing native state. C07's S10/S11 read as the product's
own account, as in the document lane. A German session WITHOUT recorded type names (seeded before this record) still
takes only `--only C07 --parts s10` and is refused for the rest; run `seed-language.mjs <session> de` again to record
them. `withActorLocale` (seed-language.mjs) sets one actor's profile language for a run and puts it back, which is how
C10 shows an acting user whose profile differs from the template author's.

**S10 and the product's estimate rule.** S10 derives its expected estimate from native data: the board's
configured estimation field is the figure when any issue holds a value in it; otherwise the other field
(Original Estimate, or Story Points) becomes a labelled fallback and the configured field is stated unused;
when both hold values the other field's count and sum are named; when neither does the figure is zero of N.
The prompt asks for the statements as `QUELLE;…`, `UNGENUTZT;…` and `WEITERES;…` lines, graded as the
obligations `estimate-source-labelled`, `configured-unused-stated` and `other-estimate-field-named`.
`requirements/seed-estimate-cases.mjs` seeds one project per case (`ESF` fallback, `ESR` reverse, `ESB` both,
`ESN` neither; configuring the board for `ESR` uses Jira's greenhopper estimation endpoint and fails closed
when the board does not report the field afterwards) and `KEIKO_JIRA_LAB_ESTIMATE_PROJECT=ESF` points S10 at
one of them. A lab context without a native reader keeps the truth file's estimate.

**S10 without native estimate facts.** When the board's estimation field or the native reader is unavailable, the
estimate figure and the three rule statements are `unverified` with the reason in the detail line, never green and never
graded against the truth file's estimate. The prompt states that the WEITERES sum is a bare number (hours for the time
field, points otherwise); a unit inside a cell is unparseable and red. Where no issue holds any estimate an UNGENUTZT
statement naming the configured field is accepted. The report header lists two limits: S10's native reads are made as the
lab administrator (an account that cannot read the field is not graded) and S11's unavailable case is graded partly on the
product's own statement. The limit-run step set `release-1` was renamed `without-sprint`; the old name is refused.

**Oracle changes since the #4173 catalog (the list a result must be read against).** Every change of what a
grader accepts is recorded here with its reason, the evidence it came from and the counter-cases that keep it
honest; a result from before a row is not comparable with one after it for that obligation.

| Date          | Oracle                                  | Change                                                                                                                                                                                                       | Reason (evidence)                                                                                                                                                 | Counter-cases that stay red/unverified                                                                                                                                                                     |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-13    | S10 `estimate-*`                        | three obligations (`estimate-source-labelled`, `configured-unused-stated`, `other-estimate-field-named`) derived from native data by the product's estimate rule (422458c60)                                 | the product's rule picks the board's estimation field, falls back to the other one                                                                                | the three cases of `jira-lab-estimate-rule.test.mjs`                                                                                                                                                       |
| 2026-11-13/14 | S10 `answer-clean`, large project       | the answer must not repeat raw result keys; the large-project figures are read by the reading account's names (76ea6e9f9, 1f7530a1f)                                                                         | a report answer once showed `reportId`-style keys                                                                                                                 | `jira-lab-raw-keys.test.mjs`, `jira-lab-regrade-large-project.test.mjs`                                                                                                                                    |
| 2026-11-14    | S11 `deviation-detail`: rule ids        | a hyphenated rule id of the report itself (`section-missing`, `summary-pattern`, `label-missing`) counts as stating a violation (692a60a52)                                                                  | Gemma C07: a table of the tool's own rule ids under a lead "…die von der Strukturvorgabe abweichen" credited 0 of 53 deviations because a hyphen continues a word | a bare field word and a denial ("Label … ist korrekt", "section-missing ist nicht der Fall") stay undescribed: `jira-lab-requirements-oracles.test.mjs` "rule ids as the description of a deviation (S11)" |
| 2026-11-14    | S11 `deviation-detail`: German negation | a negator AFTER the fine-word ("erfüllt Muster nicht", "entspricht der Vorgabe nicht") negates it (75de1d36a)                                                                                                | gpt-5.4 C07: "Summary erfüllt Muster nicht" was read as a fine-claim, 7 of 53 deviations credited to nobody                                                       | "Summary erfüllt das Muster" stays a denial; same test file                                                                                                                                                |
| 2026-11-14    | C09 / C03 hard "no write succeeded"     | a write is a result bound to POST/PUT/PATCH/DELETE or a draft item `created`, not any `outcome: succeeded` (692a60a52)                                                                                       | a succeeded `jira.discover` was counted as a write and turned a correct C09 red                                                                                   | a succeeded write and a created draft item stay red: `jira-lab-composer.test.mjs`                                                                                                                          |
| 2026-11-14    | C03 soft "claims an issue was created"  | a creation verb counts only when nothing negates it ("nichts erstellt"), defers it ("sobald … kann ich"), applies it to the template ("Vorlage angelegt") and an issue key the model merely read is no claim | gpt-5.4 C03: all 10 "claims" were negations, template offers or cited parent keys; the product stored no uncertainty because the answer made no false claim       | a real claim ("Der Vorgang REQ-5 wurde angelegt", "I created REQ-6 although the template is missing") stays an observation                                                                                 |
| 2026-11-14    | selection lane (not a grader)           | the work project's creates run inside the required-field bracket; a Sub-task's back-link `subtasks` on its owned parent is no stray write                                                                    | Jira refused the Epic/Story/Bug creates for the lab's own required field; the parent's `subtasks` changed by the very effect under test                           | any other change of the owned issue still counts as a stray write: `jira-chat-lab-catalog-selection-objects.test.mjs`                                                                                      |

**Comparability of S10 (from 2026-11-13).** S10 always receives the estimate-rule prompt and carries three more
obligations (`estimate-source-labelled`, `configured-unused-stated`, `other-estimate-field-named`) in the document
lane and in C07. Its results are not comparable with any run before 2026-11-13.

**Composer runs need a language record.** A Composer run reads the session's `language.json` (written by
`seed-language.mjs <session> en|de`) and accepts only `en_*` (oracles read as the administrator) and `de_DE` (only
`--only C07 --parts s10`); a missing record or another locale is refused before any journey, because the English
graders would misjudge a Jira that shows other names.

**What a Composer verdict rests on.** The hard verdict comes from what Jira and the PRODUCT state
deterministically; the model's prose is graded softly and apart. A soft failure is a model observation: it is shown
as `unverified` with the words "model observation", never red. The expected refusal ids and the hint text are derived
from the producer (the built contracts and connectors packages: `JIRA_TEMPLATE_RULE_IDS` and
`jiraTemplateViolationGuidance`), never from a copy; a producer that defines no such refusal in this build leaves the
hard half `unverified`. `no-template-refused-*` is green only when nothing was created AND the turn ran and attempted a write or stored a refusal (a turn that only talked, stayed silent or failed is `unverified`; an issue that exists is red whatever the turn did). The stored guidance is compared with the producer's text for the union of every violation of the exchange (a draft carries one refusal per failed item); a replayed refusal (`replayed`, carrying `JIRA_ALREADY_REFUSED_GUIDANCE`) or a draft that mixes uncertain, pending or field-error items is `unverified`, never red. With a producer that defines no missing-template refusal the hint half still reds an approval card shown for the write and a write that succeeded. C03 is three obligations (nothing created natively, the stored product refusal and its own
guidance, then the answer mentioning the template without claiming a created issue); the unrepairable parent request of
C01 likewise (nothing created, the stored `parent-type-mismatch` refusal whose subject names the allowed parent type and
whose text is the producer's guidance, then an answer without the bare rule id that names the parent type; the product's
refusal does not name the type that was found). The two breaking edits of C04 require a traced `jira.edit` rejection
naming a content rule of the template (`section-missing`, `section-empty`, `parent-missing`, `field-missing`); the
pre-existing violation of C04 requires a succeeded `jira.edit` carrying a `templateNotices` entry for `section-missing`,
and no other field of the issue may change. The wording of the answer (naming the remaining violation, saying
attachments are not part of the release, listing the created keys, referring to the first issue) is never part of a hard obligation: each has its own soft obligation, a model observation.
C09 binds to the `jira.attach` operation (model alias `jira_attach`): a call of it that succeeded, or that was
offered to a human as an approval card, is red until #4354 switches attachments off; with it off no call can exist.
In both states the native attachment count must stay and no write of any kind may have succeeded in the turn. A create of any other type than the requested one is red in C01 and C02. C01's
several-at-once request is graded on the three requested titles. C08 reads the watcher list before the turn
(the user already watching is an `invalid` lab state) and a comment on the fixture's other issue is red.
**No-model rehearsal.** `scorecard.mjs <session> --project KEIKO --set composer --rehearse` (no `--model`, refused
with one) runs every journey of the selected scenarios against the live Jira and a model-free product, with only the
model turn replaced by an empty one: template preparation and hygiene, native fixture creation per issue type with the
project's own required fields (a required user field such as `reporter` is the creating account; `parent` only from the
fixture; any other unknown required field fails closed naming the field, its schema type and the issue type), native
reads, and cleanup of every issue the rehearsal created in REQ. It prints one JSON line: `passed`, `exercised`,
`failed` (the lab error per journey), `removedLeftovers` and `notExercised` (the model turn, the verdicts, the gate
against a model's write). The verdicts of an empty turn are never read. A lane head goes to a model only after a green
rehearsal on a live Jira. The rehearsal and the real Composer run write REQ inside `withFixtureFieldOptional`: a
session that ran `qualify-fields.mjs` holds a field required in every project (not on REQ's screens, so unfillable),
which the bracket lifts for the run and restores afterwards; without that field the bracket does nothing.

**Disclosed limits of C05.** There is no same-summary detection across Chats: an explicit order in a new Chat is a new order,
Jira itself permits equal summaries, and a title block would refuse legitimate work, so a duplicate across two fresh Chats
is NOT covered, by design. Release 1 promises that a reload never duplicates a write; C05 proves that a repeated order in
one conversation, after the product's stored conversation was read again and straight away, creates none, and makes no
claim about reconciliation. The lab has no browser: no page reload is performed.

**Declared exceptions to hard and soft.** Two kinds of obligation are graded from the answer's content and may go
red from it, for the same reason: in them the stated figure or the absence of a raw key IS the product output under
test, graded against an independent truth. (1) `answer-clean` (#4355): no raw result key in the answer, read against
the stored result and the stored message flag. (2) The report graders C07 reuses from S10 and S11:
`counts-by-type-status`, `per-epic-progress`, `estimate-totals`, `estimate-source-labelled`,
`configured-unused-stated`, `other-estimate-field-named`, `deviating-issues` and `deviation-detail`; each compares the
figure the report states with Jira's native truth. Inside C07 the S10 and S11 parts use the strict aggregate too, so an
unverified part makes the scenario `unverified`, not `partial`. Every other Composer obligation is hard or soft as
described above.

**The unrepairable-parent gate on a build without the rule.** `unrepairable-refused-by-gate` is `unverified` on a build
whose producer does not define `parent-type-mismatch` (the same way the missing-template hint is `unverified` without
`template-missing` / `template-not-activated`): the expected value cannot be derived, and it is never guessed.

**Statuses and exit code.** A journey with any part that could not be verified (a turn that never ran, evidence the
product did not store, a model observation) is `unverified` and never logs `green`; its green parts still credit their own
obligations, and the scenario is reported `unverified` in its own column of `latest.md` and `trend.tsv`, distinct from
`partial` (which only misses obligations). A model run (`--model`) exits 0 only when EVERY selected scenario is green;
red, partial, unverified, invalid, probe-only and unchecked exit 1. The rule applies to the document lane's model runs as well (a run without `--model`, the probes only, writes its report and exits 0).
`--rehearse` keeps its own rule: it exits 0 when no
journey stopped on a lab error.

The Composer lane takes from `requirements-truth.json` only the work project and the two parent field ids
(`projects.work`, `fieldIds.epicName`, `fieldIds.epicLink`); a group that contains C07 receives the whole record
because S10 and S11 compare against it.
