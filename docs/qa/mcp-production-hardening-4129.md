# MCP production hardening — PR #4129

This is an incremental audit receipt. Qualification remains in progress; this document does not
certify production readiness. Only MCP tools are in scope. The shared registry, encrypted vault,
managed protocol host and Activity Log remain the existing owners.

## Confirmed findings and repairs

| Finding                                                                                          | Impact                                                                    | Reproduction and repair                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry names stopped at 64 characters while MCP supports 128                                   | Valid tools could not be admitted consistently                            | A 128-character contract regression failed first. Registry and native identity limits now agree, without relaxing collision checks.                                                               |
| Central connections refused OAuth while Workbench used a separate path                           | An authenticated server could not be shared with Chat                     | The managed connection now obtains server-owned credentials; Workbench receives its existing scoped relay. Central settings own sign-in, status, cancellation and revocation.                     |
| OAuth entries could not be edited centrally                                                      | Operators could not maintain their own server definition                  | Editing preserves issuer, client ID, scope and central tool policy; OAuth configuration saves independently of sign-in.                                                                           |
| Legacy authorization URLs accepted ambiguous duplicate parameters and unsafe callback components | Confused callback and authorization matching                              | Eight negative regressions failed before strict uniqueness and loopback callback validation were added.                                                                                           |
| Legacy OAuth credential identity omitted scope                                                   | Changed permissions could reuse an old credential record                  | A scope-change regression failed first. The versioned credential key now binds scope; previous legacy records require a fresh sign-in.                                                            |
| Silent tool metadata changes were accepted between discovery and dispatch                        | An approved tool could change without a notification                      | A failure-first regression changed the tool description. Every invocation now checks uncached, bounded declarations before dispatch and rejects drift. Concurrent metadata checks are serialized. |
| SDK defaults requested advertised scopes and appended `offline_access`                           | Server metadata could widen requested permissions                         | Two regressions failed first. SDK discovery presented to the authorization flow is constrained to operator-selected scopes; extra returned scopes are refused.                                    |
| Tokens survived a failed authority-epoch commit in the new shared OAuth flow                     | A failed sign-in could leave usable credentials                           | A failure-first test rejects the registry commit. Authorization tokens are now staged in memory and only persisted after that commit succeeds.                                                    |
| Cancelled shared authorization retained a generation listener                                    | Repeated attempts accumulated listeners and retained state                | A failure-first listener-count regression now verifies cleanup. Shutdown also waits for owned callback listeners to close.                                                                        |
| Expired pending authorization was reported as cancelled                                          | Operators received the wrong recovery state                               | A deadline regression failed before the status path settled an elapsed attempt as expired.                                                                                                        |
| Refresh rejection retained invalid credentials                                                   | Repeated calls retried a rejected grant instead of requesting sign-in     | An invalid-grant regression now verifies durable invalidation and no repeated refresh. Transient errors preserve recoverable credentials.                                                         |
| Non-refreshable tokens inside the refresh margin were refused                                    | Still-valid credentials became unusable early                             | Boundary cases verify that a valid short-lived token remains usable until its actual expiry; expired tokens fail before network dispatch.                                                         |
| Rotated access tokens disappeared from the credential floor while still valid                    | A server could reflect an overlapping live token after refresh or restart | A rotation/restart regression retains live access credentials in bounded encrypted history and removes them after expiry plus clock skew.                                                         |
| Central MCP management was hidden before a first Workbench task                                  | A fresh Workbench could not reach central settings directly               | A UI regression failed first; the management entry now lives in the persistent Workbench header.                                                                                                  |

## Implemented boundaries

- OAuth uses the official MCP SDK inside `keiko-mcp`, with issuer/resource binding, PKCE S256,
  one-use callback state and a five-minute attempt lifetime. The callback listener binds IPv4
  loopback and validates its exact Host and path. The public attempt ID is separate from OAuth state.
- Metadata, registration, token and refresh requests use the existing hardened outbound gateway:
  HTTPS, bounded requests/responses, no redirects, DNS/proxy target pinning, no metadata/link-local
  destinations and explicit public/private target classification.
- Existing encrypted credential custody stores central OAuth state separately from opaque legacy
  runtime records. Resource, issuer, client ID and scope bind credential identity. Removing or
  changing a definition cleans incompatible central records.
- Credential rotation advances the server's persisted credential generation, invalidating old
  connection and approval authority. Static secrets and tokens materialized during refresh join
  the credential floor before metadata or results leave the connection boundary. Still-valid prior
  access tokens remain covered across refresh and process restart within bounded encrypted history.
- Tool calls are never automatically replayed to recover a lost response or authentication failure.
  Unknown tools remain writing tools; server annotations do not grant authority.
- Settings include advanced header selection, encrypted environment-variable inputs/removal and
  central tool risk policy. Workbench links to that same settings surface. New labels are bilingual.
- Authorization lifecycle evidence uses the registered `mcp.authorization.state` operation and
  contains correlation IDs, opaque attempt IDs, state and completeness counts only. Credential
  availability also records ready, required and temporarily unavailable states without token data.

## Qualification status

The production static UI build and editor release evidence passed. The complete UI coverage
lane passed 614 suites: 11,977 tests passed and one existing test was skipped. It measured 94.36%
lines and 85.26% branches. The final fixture location uses the existing `__tests__` artifact pruning;
the Chromium settings journey passed again with that source path.

The production-build app-browser OAuth journey completed central sign-in over verified HTTPS.
Independent synthetic server counters observed one authorization-code exchange, four refreshes
and zero reads/writes during discovery. The central surface reported signed-in and connected
with its discovered tool. Sign-in cancellation was exercised before the successful attempt.
This is authentication/discovery evidence; use by Chat and OpenCode remains to be proved.

The first checkpoint (`c0b50fb58`) covers name compatibility. The shared OAuth/UI checkpoint
passed 370 focused MCP, registry and native-runtime tests (25 suites), 39 related UI tests
(five suites), root and UI typechecks, root and UI lint, format checking, and the full
Activity Log gate. The latter ran its complete registry/scenario inventory, error observability,
architecture, 78 negative architecture fixtures and release-impact checks. The ADR index and
updater UI evidence freshness also passed.

Local Sonar passed with zero unresolved findings on the changed files after two reported code
findings were repaired. The documented 12 GiB analyzer heap was needed: the default 4.5 GiB
attempt exhausted memory. An earlier report had failed because a source file changed during
analysis (72 actual versus 82 expected lines); neither failed attempt is counted as passing.

The app-browser setup connected the existing local model gateway through the real UI using
isolated configuration and credential state. Gemma was admitted for conversation. Its first tool-calling
probe was unavailable; a later real gateway probe verified tool calling. Interactive real-model OAuth reads subsequently passed in both Chat and OpenCode, as recorded below.
The browser created a synthetic stdio server through central settings and observed the real
`Connected · Tools: 2` state. No synthetic write was dispatched during this discovery check.

The dedicated real-stdio settings journey passed in Chromium (including a repeat after cleanup
changes) and WebKit. Its `@smoke` tag is reachable from the existing lanes; the E2E wiring gate
passed. The journey verifies policy preservation, disable/enable, reconnect and removal, with an
independent empty effect counter. This does not qualify real-model tool dispatch.

Further targeted runs passed: 340 Workbench window/host tests, 262 MCP/authorization tests with
coverage, and 27 settings/authorization UI tests with coverage. The targeted MCP run measured
92.85% lines and 81.18% branches across its selected sources; it is not a complete coverage gate.
The full coverage chain was interrupted after a confirmed stale source-inventory failure; that
inventory was corrected without lowering coverage floors and its 70 gate tests passed afterward.
Generated support-code inventory, the i18n guard and semantic-duplication checks were also repaired
from reproduced failures. The extended credential-availability evidence passed the complete Activity Log gate (219 seconds).

The macOS Firefox binary fails before page load with an OS sandbox/profile error, including with a
fresh per-task installation. The isolated Linux Firefox run passed all three journeys (central MCP and both Workbench cases)
in 3.9 minutes. No browser checks disable TLS verification. The isolated HTTPS/OAuth fixture now
loads in the embedded browser after the owner approved temporary SSL trust for its single one-day
leaf certificate. Its issuing CA is not trusted; removal of that leaf trust is part of cleanup.

Still outstanding: final complete core and coverage gates, final generated evidence verification,
package-surface qualification and the full interactive acceptance
matrix with a real model and OpenCode. The in-app browser is available; tests use isolated state and
synthetic writes. Production connections remain read-only. The owner has conditionally authorized manual integration and a new release once final readiness is established. Auto-merge remains disabled.

## Additional confirmed repairs and interactive acceptance

A refresh rejection arriving after local revocation could recreate an already deleted vault
record. The regression failed first; custody now checks the current generation immediately before
all writes. Another regression reproduced rejection of valid fully qualified Windows executables.
Portable path admission now accepts drive paths while refusing drive-relative paths, UNC shares
and device namespaces. A real sibling-runtime launcher failed with the former fixed POSIX PATH;
it now connects using its own directory plus minimal system directories. No ambient PATH or
profile credentials are inherited. Windows keeps validated system lookup and private profiles,
normalizes explicit environment keys and refuses case collisions. Windows execution itself still
requires native qualification; the local process reproduction ran on macOS.

The built application was exercised interactively with the existing local Gemma model and the
real OpenCode runtime. One central OAuth login served both consumers: Workbench and Chat each
returned the real OAuth read marker, and the independent HTTPS provider counter advanced once
for each consumer. TLS verification remained enabled. A Full access stdio write returned the real
write marker and advanced its independent counter exactly once without approval or workspace
changes. A supervised MCP write was explicitly denied and an approval-mode write was stopped
while awaiting its native MCP decision; neither nonce occurred in the independent counter.

A further Full access write deliberately disconnected after its synthetic effect. The counter
advanced exactly once. The application displayed `Reconcile before retrying`, prevented automatic
repetition and preserved that requirement across a normal reload. These interactive results refer
to built head e0a6cc4cd; the final source still needs its own repeat qualification. Screenshots and
a body-free case manifest are held in the task's local acceptance artifacts. English and German
connection counters now use `Tools: {count}`, including the one-tool case.

The complete UI coverage run passed 614 suites (11,977 passed, one existing skip); the complete
scripts coverage run passed 323 suites (8,117 passed, 28 skips). The in-progress complete package
run has failures and is not counted as green. Final complete gates and assembled package surface
remain outstanding.

## Current review and lifecycle checkpoint

The central status projection is now also shown read-only inside Chat's Tool access panel. It
reuses the Settings API and translated connection labels; conversation mode and grants remain
separate. Failed reads can be retried and closing the consumer aborts pending reads.

Additional reproduced defects from review were repaired: disabled OAuth servers no longer request
an execution generation merely to display or protect stored credentials; sign-out is available for
disabled entries. Cached authorization is invalidated before custody mutation, including when
registry persistence subsequently fails, and unfinished authorizations are cancelled on sign-out.
Client-configuration refresh errors preserve custody; only `invalid_grant` clears the grant.
Repeated Workbench management links consume their initial navigation request and select MCP again
after a manual Settings tab change. Invalid JSON status bodies are covered explicitly. The Windows
missing-system-root test now uses host-independent invalid values.

An additional confirmed lifecycle defect was repaired: a real local MCP server's ordinary child
process survived closing its SDK connection. Both isolated reproductions reported the survivor;
the owned synthetic processes were then terminated. The POSIX lifetime owner now removes ordinary descendants on close, cancellation, input end,
output failure and provider exit. The same independent real-SDK probe reports no survivor and
158 ms close time. A checked-in SDK regression and process tests cover this repair. Windows
uses the existing native helper in a dedicated non-breakaway Job Object mode; the native
qualification harness exercises a provider and C grandchild with a quoted executable path.
Native Windows execution remains pending; macOS source-contract validation is not Windows proof.

The complete initial package run finished with 2,763 passing suites and four failures. One required
the repository's exact approved toolchain rather than the broader supported contributor range;
the two verify-route cases and that toolchain case all passed under Node 24.18.0/npm 11.16.0.
The fourth failure loaded an older cached contract export after source changed during the long
run. The final complete run must use frozen sources and the approved pair. A fresh focused MCP
coverage run passed 117 tests, 95.55% lines and 85.07% branches; this is not the full quality gate.

The staged App Browser build now verifies sign-out while an OAuth server is disabled, a required
new login after re-enabling, cancellation, and a fresh successful PKCE consent. Repeated Workbench
management links select MCP again after visiting Models. These are working-tree qualification,
not the final integrated-head release certificate.

An additional reproduced credential defect persisted a resource URL access_token in cleartext
and returned it to Settings. The shared Settings owner now normalizes this legacy bearer form
into the existing encrypted Authorization header before persistence or public projection. Startup
performs the same migration, preserving SSE/private-network options; OAuth entries discard the
obsolete URL token and require their normal bound authorization. Ambiguous credentials are refused.
The SDK adapter independently refuses raw access_token URLs. The original reproduction failed
before the repair; registry, restart, legacy migration, ambiguity, OAuth and no-dispatch controls
now pass. No new credential service or execution configuration was introduced.

## Qualification checkpoint after 49a2839b5

The complete UI coverage rerun passed 615 suites: 11,990 passing tests and one existing skip,
with 94.37% line and 85.28% branch coverage. Architecture, architecture negative cases,
formatting and the complete Activity Log inventory passed. The paired-host catalog producer
measured dev baseline 57cca43df and candidate 49a2839b5 with the approved Node/npm pair;
all six existing performance ceilings were preserved exactly.

The correctly staged App Browser build passed an OpenCode/Gemma OAuth read and a Chat/Gemma
OAuth read using the same central authorization. Chat required its own explicit read consent.
An independent verified-TLS counter recorded exactly one additional read for each consumer,
zero writes and no additional authorization exchange between the two consumers. Synthetic
screenshots and the content-free case receipt are retained outside the repository.

The final package coverage run, remaining interactive failure cases, native Windows execution,
required CI on the pushed head and release qualification remain outstanding. This checkpoint
does not authorize a production-readiness claim.

## Vault-read failure containment

A review identified another reproduced defect: constructing the authorization view could throw
on an unreadable or malformed encrypted OAuth record. GET Settings then failed; PUT could fail
after its configuration had already committed. Enabled and disabled-server regressions first
failed with the constructor exception. The authorization-status view now reports unauthorized
and emits the existing content-free credential-unavailable state under the request correlation.
GET and committed PUT integration regressions pass without exposing the stored error payload.
No grant is cleared and no network request is made. Runtime credential-floor reads deliberately
still fail closed; returning an empty floor there could disclose an unprojected credential.

The current staged browser build also passed supervised MCP write denial with zero effects,
Ask-mode cancellation while native MCP approval was pending with zero effects, and two independent
writes that each returned isError after exactly one effect. Both write-error tasks required recovery;
the second recovery state survived a complete app reload without replay.

## Final qualification checkpoint and restored-expiry defect

The complete package run passed 2,774 suites and 62,841 tests (21 suites and 299 existing tests
skipped). The package/UI/script coverage ratchets, strict release line targets and all 73 governed
file floors passed. The first changed-code check measured 84.6% against the unchanged 85% floor;
additional adversarial restoration cases are being qualified, rather than relaxing that gate.

Those cases reproduced five invalid persisted expiry shapes that were incorrectly interpreted
as a token without a lifetime. Restoration now requires a finite, non-negative expiry; explicit
zero remains supported. Rejected authority retains its known access token in the bounded
redaction floor and performs no token request or persistence write. Missing, null, string,
non-finite and negative expiry, malformed token fields and malformed/oversized credential history
have targeted regressions. A new complete package coverage run is required after this runtime fix.

The built App Browser also confirmed one successful Full-access write, central disable killing
both the live stdio provider and its SIGTERM-resistant child, and one lost response after an
independently counted effect. The unknown outcome remained recovery-required after a complete
document reload; the counter stayed at one. A pending Ask-mode write was cancelled across central
configuration changes with zero effects; overlapping windows caused additional enable/disable
changes, so that case does not isolate argument editing as the sole cancellation cause.

CI identified a missing standard stdio declaration in the Windows probe, now corrected with
`<stdio.h>`, and the missing direct-use decision row for the SDK's already shipped cross-spawn
dependency. The exact supply-chain gate now passes locally. The Windows compiler/execution result
remains pending. An unrelated existing finalization test raced a real 10 ms timer against its
injected clock; only that test's clock handling changed, and all 25 tests in its suite pass.

CodeQL alerts 96 and 97 concern public configuration identity digests, not password storage.
Their heuristic classification was reproduced with the actual CodeQL analyzer. No query or digest change was made. On 2026-10-30 the owner explicitly approved their false-positive
disposition and selected patch release 1.3.3. The configured delegated GitHub review path is used;
no security setting or token scope is widened. Both alerts are dismissed as false positives by
`oscharko`, and the CodeQL check on bb8012f81 passed. Final built-source browser qualification, remaining
failure journeys, release-version evidence and exact-head required CI remain open. This checkpoint is not a production-readiness certificate.

## Owner-selected 1.3.3 release candidate

On 2026-10-30 the owner selected patch version 1.3.3. The canonical version writer updated the
workspace manifests, lockfile and version constants; the public API document and one append-only
approval-bound release-impact record were updated separately. The record includes already merged
PRs #4093, #4126 and #4144 since v1.3.2 and retains the existing older-install bootstrap warning.
Publication remains conditional on final qualification; auto-merge remains disabled.

The actual built App Browser shows 1.3.3. An Ask-mode write received both its outer execution and
native MCP approval and completed with exactly one independent effect and the expected marker.
A pending sign-in was cancelled without acquiring a grant, and a subsequent consent produced one
new authorization exchange. The previous Chat permission was revoked: an unapproved new read
started no effect, while fresh consent allowed exactly one read under the new central grant.

On this candidate, 439 targeted regressions pass. The UI coverage rerun passes all 617 suites,
12,025 tests with one existing skip, after rerunning all four original historical design-evidence
producers. They retain zero gated neutral/token differences, 14/14 editor reference captures,
zero serious/critical accessibility findings or unresolved incompletes, and all 108 running-app
captures with active assertions. These historical fixtures do not replace the MCP App Browser
journeys. The Windows lane on bb8012f81 passed the real native Job Object qualification, including
the quoted provider path and provider/grandchild termination; the versioned final-head CI must
still pass independently.

The full final package run, installable-artifact qualification and the remaining interactive
matrix are still open. The earlier complete package result is retained as checkpoint evidence,
not substituted for the corrected release candidate. The macOS OpenCode acceptance uses the
existing admitted evaluation runtime; it does not qualify a stronger native isolation/signing
mode than that platform currently provides.

## Final review repair batch

The six remaining CodeRabbit conversations were rechecked against the current source. The process
leak was already repaired; its receipt incorrectly still called it open. The receipt now separates
the repaired defect from platform qualification. The other confirmed repairs are:

- **Medium — Windows argument corruption:** the native writer emitted only `b + 1` backslashes
  before a quote instead of `2b + 1`. Compiling the actual C function into a portable probe failed
  before the repair and passed afterward. The real Windows qualification now checks a backslash
  immediately before a quote, whitespace, an empty argument, a trailing backslash and Unicode.
- **Medium — final native output loss:** provider exit could terminate the lifetime owner before
  its stdout closed and always used status zero. Failure-first tests now prove final-response
  draining and exit-status propagation. A 150 ms deadline still closes a Job whose descendants
  retain its pipes; abort, input end and pipe failure stop immediately. The Windows native lane
  additionally executes the built Node lifetime worker and verifies its final bytes and status.
- **Low — probe refusals lacked evidence:** failed and mismatched probes now emit body-free
  diagnostics through the injected sink. Missing optional assets stay silent. Three failure-first
  cases and a successful-status/wrong-schema case cover refusal without recording private output.
- **Low — qualification cleanup could signal a reused PID:** each PID is removed from the forced
  cleanup set as soon as its absence is confirmed. Successful qualification does not signal those
  PIDs again.

All 44 focused process/owner tests and the corrected full typecheck pass. Actual Sonar, architecture,
negative architecture fixtures and error-observability pass for this batch. The complete final
qualification and current-head Windows execution remain required before production sign-off.

The candidate's last complete package run reported 2,772 passing suites, two failing suites and
21 existing skipped suites: 62,861 tests passed, three failed and 299 were skipped. One failure
copied the publish surface while a concurrent independent scripts run was changing that same
surface; two verification tests exceeded their existing terminal-wait budget. The independent
scripts run passed 322 suites but its workflow-inventory scan exceeded 15 seconds. That inventory's
23 tests subsequently passed both normally and with coverage without changing the timeout.
Neither red full run is counted as a passing release gate. The remaining exact failures are being
rerun in isolation, followed by serialized final qualification.

On the actual 1.3.3 App Browser, Supervised mode approved both an OAuth read and one stdio write,
with the expected markers and exactly one write. Full mode read the legacy-SSE and encrypted-header
servers and then exercised connection loss both before and after a synthetic write. Independent
counters remained zero and one respectively across complete document reloads, while the UI retained
recovery-required status. The central SSE server was removed and recreated through Settings and
connected again with one tool. The first post-effect attempt stopped before MCP dispatch while
model verification was pending; its zero-effect counter is retained as an unsuccessful attempt,
not positive MCP acceptance evidence.

The isolated release pipeline and native-source suites passed. The remaining verify-handler
failure was reproduced independently: verify launches a real npm subprocess, whereas its shared
helper incorrectly assumed all runs finished as soon as the fake model resolved. The helper now
observes the existing sink close after registry completion, under the unchanged Vitest deadline.
All 60 handler tests and the combined 104 process/handler regressions pass. Scoped lint over every
file in this repair batch, the production build, architecture, negative cases, Activity Log,
error observability and actual Sonar pass. Serialized complete final coverage is still pending.
A further real Gemma/OpenCode read against the newly launched built provider succeeded with its
expected marker and no write. A literal scan of 148 isolated application state/log files
(50,747,787 bytes) found zero occurrences of the current static test credential.
