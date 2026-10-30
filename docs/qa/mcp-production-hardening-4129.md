# MCP production audit — PR #4129

This receipt covers the existing MCP tool integration: configuration, encrypted credentials,
OAuth, SDK/protocol adapters, transports, process ownership, Chat, OpenCode relay, permissions,
recovery and content-free observability. Resources, Prompts, Sampling and Tasks are outside scope.
Integration and publication require the owner's authorization and successful current-head gates;
this document does not replace those gates.

## One configuration and shared execution

`mcp-servers.json`, the existing Settings store, encrypted credential custody, `keiko-mcp` and
Activity Log remain the authoritative owners. There is no second configuration or management
service. Central Settings preserves advanced stdio arguments/environment, Streamable HTTP,
explicit legacy SSE, header credentials, OAuth and tool policy when editing. Chat and Workbench
share authentication while retaining separate consumer permissions. OpenCode receives a run-bound
relay capability and no external OAuth token.

The official client/server SDK packages are pinned at 2.4.0. The reviewed protocol references are
the [tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and [security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices).
SDK imports remain confined to the existing MCP package.

## Confirmed findings and repairs

All confirmed findings below have implemented repairs. Final production sign-off still requires
the current-head integration checks. Severity describes the verified impact; it is not a claim
of an observed external exploit.
Failure-first regressions were used where stated. Existing protected behavior was retained.

| Finding / cause                                                        | Severity | Repair and evidence                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry accepted only 64-character tools while protocol permits 128   | Medium   | Contract regression failed first; registry/native identities agree at 128/193, with collision rejection (`c0b50fb58`, `40051612b`).                                        |
| OAuth worked only through a separate Workbench path                    | High     | Shared server-owned SDK OAuth serves both consumers through existing custody/relay (`0babb1c7d`); real Chat and OpenCode reads share one grant.                            |
| Central OAuth definitions were not editable                            | Medium   | Central form preserves issuer/client/scope and advanced settings; UI regressions and actual browser edits pass.                                                            |
| Ambiguous legacy auth parameters and unsafe callback components        | High     | Eight negative regressions; strict parameter uniqueness, loopback callback, expected host/path and one-use matching.                                                       |
| Legacy credential identity omitted scope                               | High     | Scope-change regression; versioned issuer/resource/client/scope binding requires incompatible legacy states to sign in again.                                              |
| Silent tool-declaration drift bypassed discovery assumptions           | High     | Failure-first description/schema change; bounded uncached declaration validation immediately before dispatch.                                                              |
| SDK metadata defaults could widen scopes                               | High     | Failure-first cases constrain advertised/requested scopes and reject extra returned scopes; no implicit offline scope.                                                     |
| New tokens survived a failed authority commit                          | High     | Failure-first rejected commit; stage tokens until current generation/session commit succeeds.                                                                              |
| Refresh completion could resurrect revoked credentials                 | High     | Failure-first generation race; custody revalidates before every write (`51597cf9d`).                                                                                       |
| Invalid refresh grants were repeatedly retried                         | Medium   | Durable sign-in-required on invalid_grant; transient/client-configuration failures preserve recoverable grants. No tool replay.                                            |
| Valid non-refreshable tokens were refused early                        | Medium   | Boundary regressions keep them usable until actual expiry.                                                                                                                 |
| Rotated live access tokens left the redaction floor                    | High     | Encrypted bounded overlap history survives refresh/restart and expires with clock skew; malformed/oversized history fails closed.                                          |
| Malformed stored expiry became unlimited lifetime                      | High     | Missing/null/string/NaN/infinite/negative expiry refused; explicit zero remains supported. Known-token redaction custody is retained (`669ce0600`, `bb8012f81`).           |
| Cancelled auth retained listeners; expiry appeared cancelled           | Low      | Listener-count/deadline regressions, owned callback shutdown, separate expired state.                                                                                      |
| Disabled OAuth server hid sign-out                                     | Medium   | Revoke works while disabled; cancel attempts/cache before persistence (`8adb6eb24`).                                                                                       |
| Malformed status bodies were not consistently refused                  | Medium   | Safe bounded errors and negative status-body cases.                                                                                                                        |
| Workbench central-management access/tab selection was unreliable       | Low      | Persistent management entry and consumed MCP-tab requests; UI and actual browser checks.                                                                                   |
| Portable and executable-path rules disagreed                           | Medium   | Preserve portable configuration; require actual host absolute paths and refuse drive-relative/UNC/device forms at execution.                                               |
| SDK close left an ordinary stdio descendant alive                      | Medium   | Real process reproduction failed first; owned POSIX group / admitted Windows non-breakaway kill-on-close Job (`49a2839b5`). Independent provider/child termination probes. |
| Legacy URL bearer leaked into registry/Settings projection             | High     | Migrate into encrypted header custody before write/projection; preserve SSE/private options, refuse ambiguity and raw bearer URLs at adapter boundary (`49a2839b5`).       |
| Vault restoration error broke GET and made committed PUT appear failed | Medium   | Safe unauthorized status plus correlation; real facade GET/PUT regressions and chmod fault/recovery in App Browser (`6f5d3aa87`). Runtime floor reads still throw.         |
| Windows C probe lacked the stdio declaration                           | Medium   | Include stdio.h; real Windows compilation/qualification passes.                                                                                                            |
| Windows quoting emitted b+1 instead of 2b+1 backslashes before quotes  | Medium   | Actual compiled writer failed before/passed after repair; native argv fixture checks quote, whitespace, empty, trailing slash and Unicode (`0660e765f`).                   |
| Native owner could exit before final stdout and lost provider status   | Medium   | Drain on close, flush output and preserve status; bounded 150 ms fallback, immediate abort/EOF/pipe failure; focused and real Windows worker qualification (`0660e765f`).  |
| Probe refusal lacked body-free evidence/injected sink                  | Low      | Failed/mismatched/throwing probe regressions; closed reasons, no raw output, absent optional owner remains silent (`0660e765f`).                                           |
| Native qualification could signal a confirmed-exited reused PID        | Low      | Remove confirmed-gone PIDs from forced cleanup (`0660e765f`).                                                                                                              |

Two qualification defects were also repaired without changing product semantics: an existing
finalization test mixed a mocked clock with a real 10 ms timer; the verify-handler helper imposed
a one-second completion assumption on real npm subprocesses. It now observes the existing sink
close after registry completion under the unchanged Vitest deadline. The new native-output test
initially supplied closed stdin and therefore requested immediate cancellation: actual-port
reproduction gives status 0/no marker with EOF and status 7/full marker with open stdin. `f19f24871`
fixes only that test launcher. Publisher-test stderr is exposed in its assertion rather than hidden.

## Security and lifecycle boundaries

- SDK OAuth uses PKCE S256, issuer/resource/client/scope binding, private one-use callbacks,
  a separate public attempt ID, app-session ownership, five-minute expiry and coordinated refresh.
- Metadata/registration/token/refresh and MCP transports reuse hardened HTTPS egress, target
  resolution pinning, explicit network policy, bounded I/O and redirect refusal. No TLS bypass.
- App session, consumer/run capability, permission, budget and configuration generation are
  validated before effects. Changes invalidate incompatible state, connections and permissions.
- Tool descriptions/results are untrusted. Provider annotations do not grant authority; unknown
  tools remain writes. Credentials are excluded from model context and public diagnostics.
- A lost response never automatically repeats a write. Unknown outcomes persist across reload
  and require reconciliation. Failure of one server does not unnecessarily block healthy peers.
- New lifecycle/probe behavior records content-free Activity Log evidence through existing ports.

## Recorded qualification evidence for 0660e765f / f19f24871

The PASS rows below describe recorded qualification runs, not a declaration that the current PR
head has passed CI. Current-head integration qualification was still pending when this receipt
was recorded. Resolve that live status from PR #4129 before integration or publication.

Runtime production source froze at `0660e765f`. `f19f24871` only corrects the native test's stdin.
The complete coverage run uses that unchanged production source. The real Windows native-quality
step on `f19f24871` passed, including the corrected final-response/status integration. Current-head CI remains the
independent integration gate, including fresh real Windows execution.

| Check                                                       | Recorded qualification result                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full root/UI typecheck, lint and format                     | PASS; separate commands, not inferred from Vitest                                                                                                                                                       |
| Focused process/handler regressions                         | 104/104; native companion source/gate tests 19 passed, 26 platform skips                                                                                                                                |
| Full package coverage                                       | PASS: 2,775 suites; 62,873 passed tests, 21 existing skipped suites / 299 skipped tests                                                                                                                 |
| Full UI coverage                                            | PASS: 617 suites; 12,025 passed tests / one existing skip; 94.39% lines, 85.29% branches                                                                                                                |
| Full scripts coverage                                       | PASS: 323 suites; 8,123 passed tests / 28 existing skips                                                                                                                                                |
| Package/file/branch/function ratchets and release floors    | PASS: all four metrics over 28 packages; 73 file floors with zero violations; both strict release targets. New-code coverage 85.4% of 1,567 lines/conditions (minimum 85%)                              |
| Actual local Sonar analyzer                                 | PASS, zero unresolved changed-file findings; documented 12 GiB bridge heap                                                                                                                              |
| Real Windows native MCP qualification                       | PASS on f19f24871, job 123915253304 native-quality step; argv, Job lifetime, final output and status                                                                                                    |
| Architecture and negative fixtures                          | PASS                                                                                                                                                                                                    |
| Activity Log and error observability                        | PASS, full registered inventory; no lowered evidence controls                                                                                                                                           |
| E2E wiring, editor release and updater UI evidence          | PASS                                                                                                                                                                                                    |
| Chromium smoke                                              | 126/126 PASS; dedicated MCP target PASS; Jira/managed MCP 5/5 PASS                                                                                                                                      |
| Historical design-evidence producers                        | Zero gated neutral/token differences, 14 editor captures, no serious/critical accessibility findings or unresolved incompletes, 108 running-app captures                                                |
| Final assembled package and npm/Yarn consumer qualification | PASS: 7,263 assembled files; editor own-code gzip 78,757 B / 102,400 B; npm tarball + Yarn registry installs, optional deps omitted, 26 vendored packages; SDK/runtime/types/CLI/UI lifecycle reachable |

Earlier red runs are retained in the operator evidence: concurrent package/scripts qualification
raced the same publish surface, verify completion exceeded its incorrect helper deadline, and
workflow inventory exceeded its unchanged 15-second deadline under competing coverage. They are
not substituted for the final runs above. A redundant report-only Sonar run used its 4.8 GiB
default and exhausted the bridge heap; rerunning with the documented 12 GiB configuration passed. A Chromium trace collision caused by concurrent suites
was likewise rerun with isolated output directories: targeted repro and full 126-case smoke pass.

## Actual App Browser acceptance

The embedded browser used the built 1.3.3 UI/BFF, the existing local LiteLLM Gemma model and real
OpenCode. Only isolated synthetic systems received writes. Independent effect counts, verified
TLS oracles and synthetic screenshots were retained outside Git.

- Central CRUD/edit, connect, explicit SSE, encrypted-header migration/rotation, disable/reconnect
  and delete/recreate all exercised through Settings. The old rotated header credential was refused.
- Central OAuth sign-in, cancellation, sign-out while enabled/disabled, refresh and re-sign-in;
  real Chat and Workbench reads use the same grant. Wrong issuer produces no token exchange/effect.
- Ask, Supervised and Full modes exercised approval, rejection and cancellation. Versioned Ask
  and Supervised approved writes each produced exactly one independently counted effect.
- Full-mode disconnect before a write left zero effects; disconnect after a write left one.
  Both stayed recovery-required after complete reload with no duplicate dispatch.
- A fresh built-provider real-model read returned its expected marker with no added write.
- Controlled shutdown removed the actual provider and its resistant child. Restart preserved five
  definitions and the encrypted grant; four healthy servers reconnected with no new OAuth consent
  (three total code exchanges, eight OAuth reads, zero OAuth writes).
- Vault-read fault containment was checked in the real UI and restored without changing ciphertext.
  German/English labels and keyboard behavior were exercised; final UI source preserves them.
- The verified literal scan of 148 own state/log files (50,747,787 bytes) found zero current test
  credential matches. A later zero-file counter-capture attempt was invalid and is excluded.

Unsuccessful attempts remain explicit: one model-verification-blocked run dispatched no MCP call;
an earlier stale-approval scenario also included incidental enable/disable changes and does not
isolate argument editing as its sole cause. These are not counted as additional positive cases.

## Limits, dispositions and release authority

macOS Firefox failed before page load due to its OS sandbox/profile; Linux Firefox journeys pass.
The macOS OpenCode acceptance uses the existing admitted evaluation runtime and does not certify
stronger native isolation/signing. MCP process ownership is a lifetime scope, not a Coding sandbox;
POSIX groups do not contain deliberately daemonizing operator-trusted programs (ADR-0181).
Windows local stdio requires the admitted native owner; installations without it report that
capability unavailable and retain remote MCP. Portable builds compile and qualify that owner
from the candidate source; independent published macOS runtime versions are retained.

CodeQL 96/97 identify SHA-256 public configuration bindings as password hashes. The actual analyzer
reproduced that classification; tokens use separate encrypted custody. The owner explicitly
approved false-positive dispositions; delegated owner review resolved both without query/hash
obfuscation, privilege escalation or gate changes.

The owner selected patch 1.3.3. Canonical versions and one append-only reviewed impact record agree,
include already integrated #4093/#4126/#4144, preserve older-install bootstrap warnings and retain
manual review/one-click ineligibility. The installed reader requires canonical approval syntax;
the durable owner decision is
[PR comment 6514337888](https://github.com/oscharko-dev/Keiko/pull/4129#issuecomment-6514337888),
bound as `github-issue-comment:oscharko-dev/Keiko#4129#6514337888`. All ten portable-impact tests pass.

The owner conditionally authorized manual protected integration and governed publication after
qualification. Auto-merge remains off. Exact-head app-bound checks and resolved review discussions
remain mandatory; publishing uses the existing release workflow on the reviewed integrated source.

Test hygiene is complete: owned app/HTTPS fixtures and browser tabs closed; provider descendants
absent; fixture private keys/control credentials deleted; the exact temporary leaf trust and login
certificate removed, absent by fingerprint and rejected by system trust. Its CA was never trusted.
The user's LiteLLM service was retained.
