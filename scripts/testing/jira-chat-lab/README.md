# Synthetic Jira HTTPS laboratory

This development/qualification harness supports #4081/#4082. It uses synthetic
data only and is independent of the product’s in-process MCP host. Jira Software
Data Center 10.3.26, PostgreSQL 16 and the TLS frontend have digest-pinned images.
Published ports bind loopback only; the frontend forwards to one fixed Jira service.

Prerequisites: Docker Compose, the repository’s supported Node version, OpenSSL
and built workspace packages. State, passwords, PATs, license material and private
keys stay outside the repository in a private session directory.

## Finite normal-Chat catalog qualification

After setup, identity/field fixtures and preflight, use the actual locally verified
tool-calling model to exercise all nine reads and five writes through normal Chat:

```sh
node scripts/testing/jira-chat-lab/catalog-chat.mjs /absolute/private/session actual-model-id buffered
node scripts/testing/jira-chat-lab/catalog-chat.mjs /absolute/private/session actual-model-id stream
```

Run groups serially with all other laboratory writers stopped. Each operation has
its own authenticated Chat, first-read grant and exact write approval. The group
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
The same Chat reuses its first read grant; no write approval is expected. Independent reads
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
three independent private passwords, and a private seven-day development CA and
server certificate under `secrets/tls`. The frontend container receives only its
server key/certificate as read-only mounts; the CA key remains on the host. System
trust is unchanged. HTTP administration uses port 18081 (an optional final `init`
argument changes it); product-path qualification uses HTTPS port 18443. Stop the
previous session before starting another frontend on that port.

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
not renew the original expired laboratory; its data remains retained.

`session.mjs stop <directory>` stops only that manifest’s containers and retains
its volumes. This harness does not delete existing laboratories or renew licenses
in the background. Use a new directory/project for an independent session.

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
encrypted vault, HTTP adapter and domain verifier, then removes its temporary vault.
It checks trusted HTTPS, rejection without CA trust, and refusal after exact admission
is removed, using the same already-created HTTP port throughout. It emits only closed
outcomes. This probe alone does not qualify mutations, model calls or Chat UX.

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

The equivalent operator-owned configuration is:

```json
{
  "atlassian": {
    "privateTargets": [{ "baseUrl": "https://127.0.0.1:18443", "addressClass": "loopback" }]
  }
}
```

Use the existing gateway `egress.caBundlePath` setting for the generated `ca.pem`.
Never disable certificate validation or enable global private-network access.

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
canonical turn, observes the server-owned pending read consent through GET, explicitly
approves through the authenticated consent route, and checks the completed canonical
turn, actual `jira_projects` result and final model answer. It uses the shared gateway,
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
exactly one matching comment and a total count increase of one. Every mode must first
request its Chat read disclosure; the first two modes additionally require exactly one
approval whose preview matches the proposed comment. Full access must require no write
approval. Streaming must emit the corresponding consent/approval events and one terminal
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
Knowledge Hub, chooses the requested mode and connects the Chat through visible controls.
It captures and persists the browser's actual canonical turn identity before approving
the first read disclosure, checks the exact action textarea, and approves through the
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
credential generation, invalidation of previously granted consent, credential removal and
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
Knowledge Hub, and connects an existing empty Chat through the visible controls.
It sends a prompt through the normal composer, approves the read disclosure,
and requires a completed canonical turn, the real project result and a final
model answer. There are no mocked browser, model or Jira transports.

Stage diagnostics contain no request bodies or credentials. Screenshots stay in
the private synthetic session directory. A failed or license-budget-rejected run
is not a completed journey; repeat the entire group in a valid session.

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
observation. The exact comment preview and read disclosure require visible decisions.
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

## Consent reuse after process restart and token replacement

```bash
node scripts/testing/jira-chat-lab/consent-lifecycle.mjs /absolute/private/session actual-model-id
```

This separate four-turn group uses one persisted Chat and one stable Jira Pod. It grants the first
buffered read, closes the server, and starts a fresh Node process against the retained product store.
The new process sends a **new** buffered read with a new canonical turn identity and proves an
actual Jira request without another disclosure. It then replaces the credential through the normal
authenticated API with the distinct seeded editor token, verifies that the old grant is unavailable,
reverifies the Pod, and performs a streamed read with fresh consent. A final streamed comment reuses
that new grant and requires its own concrete action approval. Independent Jira reads prove exactly
one comment and its editor author, demonstrating that the rotated credential was actually used.

The common Chat observer follows the single newly admitted user row, excluding historical pending
approvals. Consent reuse is explicit and checks the exact existing grant, Chat, Pod, both generations,
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
the Hub, connects the ordinary Chat through keyboard workspace ports, grants reading, and approves
the exact comment preview. Jira receives one real request through the production HTTP port; its
acknowledgement is preserved without injecting a Jira fault.

A qualification-only listener on the actual BFF server intercepts the exact terminal SSE `done`
frame. It first checks that the matching user turn and assistant answer are already committed in
the real store, then destroys the actual HTTP response without transmitting that completion frame.
The earlier read-grant and write-approval frames remain delivered. Chromium's failed-request metadata
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

`requirements/` holds the lab of epic #4173: the scenario catalog S01–S19, a model-free probe
layer, end-to-end Chat journeys and the scorecard that combines them. Every check is graded by an
independent oracle (Jira REST/JQL reads or the generated ground truth), never by the model's own
answer. `catalog.mjs` lists each scenario's obligations; a check names the obligations it covers
(`covers`) and `coverage.mjs` awards green only when every obligation is covered by a passing
check, one of them an end-to-end journey. A journey that verifies only part of the contract leaves
the scenario `partial` (for example S10 until per-epic progress and estimate totals are graded),
and an obligation nobody covers keeps it from ever turning green. Creation journeys (S05, S07,
S17) read the matching Jira issue keys before the turn and grade only the keys that appeared
during it, so earlier journeys, reruns and the Jira actor's timezone cannot leak into the verdict.
S05 additionally requires exactly one write approval for its batch, S04 requires title, priority
and chapter per requirement, S11 each seeded deviation twice over (the structured `jira.report` result of the turn names it for
that issue, and the answer attributes it to that issue without denying it; an answer such as
"Keine Abweichung" or "vollständig und korrekt" leaves it undescribed, and a turn without a
completed `jira.report` deviation list credits nothing and leaves S11 partial), and S17 a one-to-one mapping of the new
epics onto the Muss requirements plus every created key in the answer. The oracles are unit-tested
with stubbed turns in `scripts/__tests__/jira-lab-requirements-scorecard.test.mjs`.

```sh
# Once per session: the empty work project REQ and the report project RPT with known ground truth
node scripts/testing/jira-chat-lab/requirements/seed-projects.mjs /absolute/private/session

# Fast probes only (seconds, no model)
node scripts/testing/jira-chat-lab/requirements/scorecard.mjs /absolute/private/session --project REQ

# Probes plus Chat journeys through any configured Gateway model, for example local LiteLLM
KEIKO_JIRA_LAB_GATEWAY_CONFIG=/absolute/private/keiko.config.json \
  node scripts/testing/jira-chat-lab/requirements/scorecard.mjs /absolute/private/session \
  --project REQ --model <chat-model-id> --embedding-model <embedding-model-id> [--only S04,S05]
```

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
