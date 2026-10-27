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

The driver fsyncs a private group/intent before dispatch and retains both that record
and its product database on failure. A pending group prevents another run. Read its
private state and reconcile Jira independently before archiving the pending record;
never replay an uncertain mutation. A successful receipt is emitted only after all
14 operations and the closing license check pass. An expired or incomplete group
does not count as acceptance and must be qualified again as a complete new group
after reconciliation. Raw REST fixture setup is not a substitute for this product
path. The final acceptance record identifies the exact tested product artifact.

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
