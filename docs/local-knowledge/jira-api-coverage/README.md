# Jira Software Data Center API coverage

This is the operation ledger for [#4287](https://github.com/oscharko-dev/Keiko/issues/4287).
It accounts for published operations and existing constrained capabilities. It is not a runtime
registry, an executable HTTP interface, a compatibility allowlist, or acceptance evidence.

The code baseline is `334c01d5868ca12e40501b03d960e35a0151bedd`. The published sources were
retrieved on 2026-11-07. Runtime availability has not been qualified by this inventory capture;
every row therefore still says `unknown` and has no verification references. The separate current
implementation snapshot tracks constrained code coverage without claiming runtime qualification. The epic remains
open until its workflow acceptance and operation-level completion conditions are proven.

## Source provenance and local originals

[provenance.json](provenance.json) identifies each official source URL, original-byte SHA-256,
original byte count, source version, and operation/path/component-schema counts. The repository
retains normalized method/path/operation-ID facts, rather than redistributing the complete
Atlassian source documents and their component schemas. Originals are fetched directly from
Atlassian on demand and retained under the gitignored `.jira-api-sources/<release>/<sha256>.json`
cache. The provisioner preserves exact original bytes, including all schemas, descriptions and
response definitions; reserialization is not used to reproduce a digest.

Run `node scripts/provision-jira-api-sources.mjs` when original schemas or full source reconciliation are
needed. The explicit network step accepts only the four canonical URLs below, sends no
credentials, refuses redirects, bounds response bytes by the pinned source length, verifies
SHA-256 before atomic installation, and verifies existing cache entries before reuse. It never
fetches sources as a side effect of an ordinary test or offline inventory check. The local cache
is not part of the tracked source tree or a runtime dependency.

| Published release                                                                                   | Source `info.version`        | Operations | Paths | Component schemas |
| --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------: | ----: | ----------------: |
| [10.3](https://developer.atlassian.com/server/jira/platform/jira_software_dc_10003_swagger.v3.json) | 10.3.27                      |        433 |   285 |               304 |
| [10.4](https://developer.atlassian.com/server/jira/platform/jira_software_dc_10004_swagger.v3.json) | swagger-merged-template.yaml |        432 |   285 |               296 |
| [11.2](https://developer.atlassian.com/server/jira/platform/jira_software_dc_11002_swagger.v3.json) | 11.2.1                       |        435 |   288 |               332 |
| [11.3](https://developer.atlassian.com/server/jira/platform/jira_software_dc_11003_swagger.v3.json) | 11.3.13                      |        437 |   289 |               334 |

The union contains **439 distinct method/path identities, 291 paths and 67 resource families**:
211 GET, 91 POST, 73 PUT and 64 DELETE operations. A family is the first segment below its API
root. `/rest/api/2` has 61 families, `/rest/agile/1.0` has five and `/rest/auth/1` has two;
`issue` occurs under two roots and is counted once in the family total.

The source paths omit `/rest` because their server template already includes it. Ledger paths
include `/rest`, independent of an installation's context path. These public template paths and
upstream example server URLs grant no execution authority. Runtime targets must still come from
the selected Pod and its server-owned connection binding.

Eight operation IDs collide within every individual source: `getPropertiesKeys`, `getProperty`,
`setProperty`, `getIssue`, `getPropertiesKeys_1`, `getProperty_1`, `setProperty_1` and
`deleteProperty_1`. Across releases, four `createAvatarFromTemporary*` IDs also refer to different
paths because upstream renumbered them. There are therefore twelve reused IDs across the union.
The ledger retains `operationId` separately for each source release; identity is always the HTTP
method plus templated path. Never merge rows by operation ID alone.

## Row semantics

[operations.json](operations.json) records every identity, root, family, primary cluster,
cluster prerequisites, source releases and their operation IDs. `baselineCapabilityIds` resolves
to the same file's historical `baselineCapabilities` records. Their owners and constraints remain
unchanged from the baseline. `currentCapabilityIds` instead resolves to `currentCapabilities`,
which documents the current native tool mapping, effect, permission policy, constraints and code/test
owners. Empty baseline and current lists have separate meanings; neither invents an execution path.

`implementationState` and `runtimeAvailability` answer different questions:

- `not-implemented`: no exposed implementation of this published operation has been recorded.
  Historical auxiliary-only reuse can still exist.
- `partial`: a constrained existing tool implements some operation behavior; this is not full
  published API coverage.
- `implemented`: implementation is complete for the operation's recorded acceptance boundary;
  verification references are required.
- `deferred` or `excluded-by-policy`: an explicit owner decision and reason must be recorded in
  `ownerDecision`. Neither state is an implicit exemption from the epic's completion criteria.
- Runtime `unknown`, `executable`, `denied` and `unavailable` describe separately recorded runtime
  qualification. `executable` requires verification references. An installed descriptor alone
  does not establish availability, permission, or successful execution.

Verification references identify exact-head tests, readback and applicable live environment
evidence. A nonempty reference is necessary but does not make its contents trustworthy: the
owning acceptance and evidence gates remain authoritative. Evidence from other heads must not be
combined into a current-head success claim. Update the row and its references when an operation
is implemented or requalified; retain the historical baseline capability description separately.

The primary family assignment is exhaustive. It is not a permission classification, an effect
classification or a requirement to deliver every operation in a family together. For example,
Agile ranking belongs to the `issue` family (C6) while the board workflow consumes it earlier;
project-role and scheme mutations remain administrative even though `project` is assigned C1.
Cluster prerequisites describe shared dependencies; operation-specific dependencies and effect
contracts belong to the executable child and server-owned registry.

| Cluster                                 | Operation rows |
| --------------------------------------- | -------------: |
| C0 — Metadata and prerequisites         |             41 |
| C1 — Project setup                      |             45 |
| C2 — Boards, backlog and Epics          |             28 |
| C3 — Sprint lifecycle                   |             14 |
| C4 — Search and reporting               |              3 |
| C5 — Versions and components            |             22 |
| C6 — Issue collaboration                |             70 |
| C7 — Saved views and preferences        |             23 |
| C8 — Files and media                    |             12 |
| C9 — Schema and workflow administration |             84 |
| C10 — Identity and sessions             |             56 |
| C11 — Instance operations               |             41 |

## Existing capability boundary

The baseline declares eleven read tools and seven mutation tools. Coding exposes sixteen,
excluding `jira.draft` and `jira.attach`. The composites `jira.report`, `jira.draft-stage` and
`jira.draft` do not add native API identities. The remaining fifteen tools map to fifteen
constrained native operations, recorded as `partial`.

Six additional native operations are recorded as `auxiliary-only`: connection server/identity
verification, field metadata for reports/templates, attachment metadata, link-type metadata and
link creation behind issue create/edit. They remain `not-implemented` for full public API
coverage. No Agile operation is exposed by this baseline. At that baseline there were 424
`not-implemented` rows and fifteen `partial` rows. Those historical capability descriptions remain
intact; current implementation state is reconciled separately below.

The baseline owners are the existing connector tools/mutations, template enforcement, connection
verification and provider/Coding bindings. Ordinary issue links and parent fields must continue
through their existing validated paths. Adding an operation to this JSON file cannot expose it
to Chat or Coding, grant authority, or bypass those owners.

## Current constrained implementation snapshot

The current registry supplies **169 native identities: 140 reads and 29 writes**. Each is mapped to
its exact published method/path identity and remains `partial`: the closed typed operation exposes
only the documented supported fields and behavior, rather than the entire upstream API contract.
The other **270 operations remain `not-implemented`**. No row is marked fully implemented,
executable, owner-deferred or excluded by this snapshot. All 439 source/version IDs, cluster
assignments, dependencies and qualification fields are retained.

This snapshot includes ordinary project setup; board/backlog/Epic and sprint operations; bounded
filter reads; versions/components; existing issue workflows; the C7 dashboard/filter-sharing reads;
the C6 comment-update/link/worklog read increment; bounded C8 attachment/archive and avatar metadata;
worklog create/update with connected-user watching/voting; fourteen C9 workflow-/issue-type-scheme
and screen reads; three reviewed comment/attachment/worklog deletions; and eight C10 user, group and
application-role reads; ten permission/security/notification configuration reads; and five additional
project scheme/accessible-security associations; twenty core issue/project metadata reads; four instance/current-actor observations; seven role/priority-scheme reads; four release-count/project-version-page reads; seven scoped directory/field reads; two JQL metadata/suggestion reads; and nine additional Agile context reads. The three existing
report/draft composites remain compositions, not extra native API identities. Remaining filter
creation, ranking, other estimate-adjustment modes and destructive operations, administration and
other inventory gaps stay open. A registered declaration is not evidence that
Jira grants the current person permission or that a particular installation supports the operation.

Worklog writes depend on the existing issue-template admission owner. The post-state uses observed
`timespent`/`timetracking` and safe create/update deltas; absent or inconsistent aggregates never
become zero. Relevant unresolved template requirements fail closed. Create and update fix
`adjustEstimate=leave`, preserve visibility on update and confirm the bound exact worklog through
an independent GET. Watching/voting changes are restricted to the connected user, with native
identity/state reads before effect and independent state readback afterwards. Readable people,
native counts and current-user flags retain separate completeness/availability meanings.

Reviewed comment, attachment and worklog deletions bind the current native resource and canonical
parent before one DELETE. After acknowledgement they confirm absence only through a complete, bounded
native collection belonging to the same still-readable issue. Bare404, permission loss and incomplete
readback never prove removal. Worklog deletion fixes `adjustEstimate=leave` and reuses saved-template
admission with the observed negative aggregate delta; unknown time never becomes zero.

C9 adds eight workflow-scheme reads, three issue-type-scheme reads and three screen reads.
Requested parent scheme IDs and returned draft IDs remain distinct. Default and workflow-mapping
responses use their documented native DTOs; named workflow selection returns an object while the
unfiltered endpoint returns an array. Bounded local pagination never adds unsupported remote query
parameters. Administrative visibility and websudo failures remain native refusals, with no escalation.

C10 adds four user reads and four group/application-role reads. Native first100 search windows,
transient cursor pages without totals, unpageable pickers, group/subgroup membership pages and
locally paged complete role lists retain their separate scopes. Email, HTML, avatar and remote-link
fields are omitted. Signed native role metrics remain signed; missing booleans/counts remain unknown,
and neither negative seat values nor configuration membership grant Keiko authority.

Ten additional configuration reads expose permission schemes/grants, issue-security schemes/levels
and notification schemes, including the project notification association. Permission/security
wrappers use bounded local pagination; notification lists retain their native max50 page envelope.
Optional configuration and recipient collections retain unknown versus empty states. Configured
notification email recipients may be shown through existing user-facing content policy; no recipient
body enters audit logs, and observing configuration never grants authority or proves delivery.

Five additional project association reads bind an independently observed canonical project before
reading permission, issue-security, accessible-security-level, workflow and priority configuration.
They reuse existing DTO/mapping projections. Accessible security-level totals describe only the
current user's visible result; an empty list may reflect missing Set Issue Security permission and
never proves that no security levels are configured. No association is changed.

Twenty core metadata reads expose global issue types and compatible alternatives, priorities,
resolutions, statuses/categories, project categories/types and grouped project statuses. Native
paged endpoints retain their observed envelope and optional totals; unpaged native lists use the
existing local pagination owner. Optional classifications, category names and grouped statuses
remain unknown when omitted. Every resolution row requires its observed native ID; a single read must match the selected
ID, and missing/mismatched identities are refused without consulting self URLs. Project statuses require an independently read canonical project.
Icons, SVG and remote links are omitted; observed metadata grants no administration or migration
authority and does not prove project-type license availability.

Four instance observations expose bounded server information, configuration feature flags,
permission definitions and the connected actor. The permission dictionary is explicitly labelled
`permissionsScope=definitions`, distinct from effective actor rights. Missing configuration remains
unknown. Server version/build observations never update compatibility, verification, custody or
operation availability. Existing directory-user projection omits email, avatar and remote links.

Seven role/priority reads distinguish global role configuration, default actors and canonical-project
membership without inferring effective permissions. Optional actor IDs/types/display names remain
unknown when omitted; matching names do not collapse distinct user/group actors. Native project role
URI maps expose names only, never URL-derived IDs or destinations. Priority schemes reuse the existing
project association projector and preserve the native total/page envelope without expanding or changing
project associations.

Four release reads preserve native component/version metrics as `countScope=jira-response`.
Omitted counts remain unknown, and overlapping affected/fixed/custom-field categories are not
summed or presented as independent JQL acceptance. Project version pages bind a canonical readable
project, preserve the native page envelope and reuse the existing version summary without relaxing
single-version identity checks. Existing `jira.version`/`jira.versions` keep their version owner;
the shared summary is also referenced by the new page capability.

Seven scoped directory/field reads retain native first100 user-candidate windows; only the
published permission search exposes its offset. User/group pickers keep branch counts separate
and do not invent missing branches or continuation. Global field flags/schema facts do not grant
create/edit admission or imply required/default values. Custom-field options bind exact observed
IDs and retain empty native values and unknown optional state. Highlight HTML, email, avatar and
remote-link fields are omitted. The deprecated native permission search remains runtime-unqualified.

Two JQL reads expose bounded visible field/function/reserved-word metadata and native value suggestions.
Local pages describe only the native returned collection; they do not invent remote offsets or a complete
value universe. Native boolean strings are decoded explicitly, missing metadata remains unknown and
highlighted HTML is omitted. Closed field/predicate selectors do not execute JQL, grant permission or
prove query validity. The published autocomplete item-schema/example mismatch is handled through the
explicit DTO documented by Atlassian; runtime qualification remains separate.

Nine additional Agile reads expose scoped epicless/epic/sprint issue pages, board projects and versions,
refined velocity configuration, a native Agile issue and its board estimate. The existing Agile request
owner remains the only route. Board project/version pages require a separately readable same board and
retain visible-result scope even when empty. Single issue reads fix `updateHistory=false`; estimates
resolve canonical issue identity first and use its observed numeric ID for the estimate request.
Null or absent estimates remain unknown, strings/numbers remain native and units are not inferred.
Native Agile version timestamps are validated before retaining their local calendar date through the
existing version summary. The official [Agile REST reference](https://docs.atlassian.com/jira-software/REST/8.20.1/)
documents the page wrappers and timestamp examples where the retained Swagger references only an item.
No runtime compatibility or live availability is inferred from that source interpretation.

`currentRegistry` pins the existing server registry source file's SHA-256 and native declaration
count. The reconciliation helper parses that file's literal `NATIVE` declarations and verified closed
`reads`/`writes` group builders with TypeScript's AST;
it does not import the runtime, evaluate source expressions, compile schemas or dispatch HTTP.
It rejects a registry identity absent from the pinned published inventory. Paths retain the exact
published parameter names, so even a wire-equivalent renamed placeholder must be reconciled with
the registry owner rather than silently changing provenance.

`sourceFiles` and `testFiles` identify implementation and relevant verification owners; they are
not claims that those tests ran on the current head. `verificationReferences` remains empty until
actual operation-level qualification is recorded. The registry digest is source accounting, not a
replacement for the runtime's immutable operation contract digest or one-use approval binding.

The current deletion, directory, configuration and core metadata deltas were edited directly during the explicit code-only
period.
Its registry digest is source-file bookkeeping, not a validation result. Inventory reconciliation,
checks and final current-head verification remain pending until the permitted final verification
phase tomorrow morning; no runtime qualification was added.

Run `node scripts/reconcile-jira-api-inventory.mjs` after a reviewed registry change in that phase. A new native
tool first needs explicit constraints and code/test references in `currentCapabilities`; missing or
extra notes fail closed. The generator refreshes identities and row mappings and advances a
recorded constrained tool only from `not-implemented` to `partial`. It preserves historical baseline
facts, source provenance, dependencies, runtime availability and verification references. It never
marks an operation complete or runtime-qualified. No source download or application build is needed.

## Source caveats that affect implementations

The published schemas are retained as evidence, not blindly trusted as sufficient validators:

- The 10.4 `info.version` is a placeholder. It cannot serve as a runtime compatibility fact.
- Several Agile paginated responses reference a singular item schema. Qualify their page wrappers
  and completion markers independently; do not infer completeness from an item count alone.
- Workflow default/mapping GETs incorrectly reference `WorkflowSchemeBean` in the published
  Swagger. Official [DefaultBean](https://docs.atlassian.com/software/jira/docs/api/11.3.0/com/atlassian/jira/rest/v2/admin/workflowscheme/DefaultBean.html)
  and [WorkflowMappingBean](https://docs.atlassian.com/software/jira/docs/api/11.3.0/com/atlassian/jira/rest/v2/admin/workflowscheme/WorkflowMappingBean.html)
  document the native fields; the [native REST reference](https://docs.atlassian.com/software/jira/docs/api/REST/9.12.2/)
  distinguishes selected-object and unfiltered-array mappings. These sources explain constrained
  decoding without establishing live availability or broader version compatibility.
- Input schemas sometimes omit `required` despite documented requirements. Board creation requires
  name, type and filter ID; sprint creation requires name and origin board ID.
- Project-key validation returns HTTP 200 for an error collection. Successful HTTP status alone
  does not establish a valid key. Project creation can return 409 after a workflow assignment
  failure; reconcile possible creation before any retry.
- Sprint POST is a partial update. Sprint PUT clears omitted fields. Closing a sprint has native
  state/subtask constraints and a server-owned completion date.
- Issue ranking can return 207 with per-issue outcomes. Filter creation inherits the person's
  default sharing settings; do not silently assume a private filter.
- HTTP method does not determine effects: POST search is a read, while a GET exporter may create
  an artifact. Each implemented operation needs an explicit effect and permission contract.

Cloud, Service Management, Assets, webhooks, plugins and private/UI-only APIs are outside this
439-operation denominator. No source snapshot or declaration count proves their coverage.

## Integrity verification

Run `node scripts/check-jira-api-inventory.mjs` for offline ledger integrity. It checks the pinned
normalized identity/source-ID digest, historical union and per-release counts, family/cluster
assignments, historical capability references, prerequisites and state claims. It also reconciles
every current capability and row mapping with the existing registry source, rejecting stale digests,
missing declarations and unpublished identities. The provenance digest is SHA-256 of
UTF-8 `JSON.stringify` over identity/source-ID tuples sorted by identity and release; the shared
script helper owns that projection. Implementation state is excluded so delivery can advance
without rewriting source provenance. This check reports `PASS ledger`; it does not assert that
original source bytes were present or reconciled.

For full source reconciliation, run `node scripts/provision-jira-api-sources.mjs` followed by
`node scripts/check-jira-api-inventory.mjs --sources`. The latter never downloads implicitly: missing or
modified originals fail closed. It verifies every original-byte digest and retained component
count, independently reconstructs the complete method/path union from the original documents,
and compares all source operation IDs and ledger rows. Only that mode reports `PASS sources`.
The ordinary root test lane exercises both modes with adversarial normalized-ledger changes and
small, repository-authored source fixtures; full upstream schemas are not copied into tests.

Both gate modes check accounting integrity. They make no network calls, probe no Jira installation,
and cannot certify operation correctness, authority, permissions, live compatibility or workflow
acceptance. Refreshing sources requires retaining new original bytes, reviewing changes and
updating provenance and all affected rows together; a changed digest is never silently accepted.

