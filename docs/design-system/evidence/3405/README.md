# Updater reliability evidence — #3405 / #3403

The browser evidence proves that the startup notice yields only while a visible, foreground
**ready** Update window owns the same critical context and actions. The notice returns when that
window is backgrounded or minimized and remains available while the foreground updater is loading
or contains only a load error. Keyboard modality is established with a real Tab press before moving
focus; programmatic focus after a pointer click must not steal the foreground.

This set was regenerated on 2026-10-12 (UTC) from PR #3913 signed source head
`2eb5752bc9f5192b19a79117df4a5964d9707c57` in the main macOS arm64 checkout using Node 24.18.0,
npm 11.16.0, Next.js 16.3.8, and Playwright 1.63.0. The unchanged eight-test Chromium suite passed
in 41.6 seconds, including the real-BFF outage journey. The unchanged evidence freshness gate and
its three focused contract controls also passed. All eight UI source hashes and four harness
hashes match that inspected source head.

The original producer recreated all 17 tracked artifacts: 14 screenshots and three JSON records.
`11-progress-state.png` and `13-reconnecting-state-mocked.png` changed PNG bytes relative to the
previous committed set; the other 12 screenshots remained
byte-identical. All three JSON records now bind the actual inspected
sources. This is macOS browser and fixture qualification; it does not claim Linux execution,
production update success, native N−1→N replacement, or final integrated-head acceptance.

The current suite includes the real-BFF outage journey. Both the main server and the outage
harness use isolated copies of the fake-key gateway fixture, preserving the tracked source
through normal CLI credential migration and subsequent restarts.

The source-label cleanup in PR #4039 regenerated this evidence again on 2026-10-16 using the
same Node 24.18.0 runtime. All eight unchanged tests passed; only `11-progress-state.png` changed
PNG bytes, and the three JSON records now bind the updated English/German message sources.
The evidence freshness check passed. This remains updater fixture evidence, not Chat scope proof.

The source-intent repair for #4040 regenerated the original producer again on 2026-10-18
using Node 24.18.0. All eight unchanged Chromium cases passed in 46.7 seconds, including
the real-BFF outage case. Two PNGs changed bytes (`10-responsive-manual-path.png` and
`11-progress-state.png`); the three JSON records now bind the current message catalogs.
The evidence freshness gate passed. This remains updater evidence, not Chat acceptance.

The selected-skill handoff for governed agent runs (#4025 AC1, PR #4064) regenerated the original
producer on 2026-10-24 with Node 24.22.0, because it changes `api.ts` and the optional message
catalogs. All nine Chromium cases passed in 1.1 minutes, including the real-BFF outage case.
Twelve PNGs changed bytes at unchanged dimensions; the three JSON records now bind the current
sources. The evidence freshness gate passed. This remains updater evidence, not skill acceptance.

Merging `dev` with the Sonar repair (#4069) into PR #4064 moved the record to source provenance
version 2 while this branch still changes `api.ts` and the message catalogs, so the original
producer ran again on 2026-10-24 with Node 24.22.0. All nine Chromium cases passed in 1.1 minutes,
including the real-BFF outage case; only `11-progress-state.png` changed bytes. The three JSON
records bind the merged sources, and the evidence freshness gate passed.

The Jira Chat changes (Epic #4081, PR #4093) regenerated the complete original producer on
2026-10-27 with Node 24.22.0, npm 11.19.1 and Playwright 1.64.1 after a fresh production package/UI
build. All nine Chromium cases passed in 49.1 seconds, including the real-BFF outage case. Three
PNGs changed bytes (`10-responsive-manual-path.png`, `11-progress-state.png` and
`13-reconnecting-state-mocked.png`); their rendered output was inspected. The other eleven PNGs
remain byte-identical. The three JSON records now bind all 25 declared source digests and four
harness digests from the worktree. The unchanged freshness gate and 23 focused updater/editor
evidence contract tests pass. This remains updater fixture evidence; Jira-specific visual
acceptance and the platform-sensitive Linux editor bundle fingerprint are separate obligations.

The Jira accessibility repair regenerated this producer again on 2026-10-27 (UTC) in an isolated
Linux arm64 container with an init process, Node 24.18.0, npm 11.16.0, Playwright 1.64.1 and
Chromium 156.0.8078.4. The source was signed head `6c63f33a0f7aa37335ac48a6a02ea59b2d1565d2`
plus the question-map target-size repair in `globals.css`. The unchanged freshness gate first
rejected that stylesheet's old digest. The complete original nine-case producer then passed in
59.7 seconds, including real BFF stop/restart. All 14 PNGs changed on Linux and were visually
inspected; all three producer-generated JSON records bind the exact 25 source and four harness
digests in the reviewed worktree. The unchanged freshness gate, 23 updater/editor evidence
contract tests and both Linux Editor bundle gates pass. No numerical ceiling changed and the
Editor fingerprint remains unchanged. This qualifies the updater fixtures and BFF recovery,
not native update installation, real Jira/model behavior or final integrated-head acceptance.

The connector-verification guidance repair regenerated this original producer on 2026-10-28 (UTC)
from signed head `71d84996cf6308e714e17c7bfe1b44031c5f7604` in the same isolated Linux arm64
runtime. The unchanged freshness gate first rejected the previous message-catalog hashes. All nine
canonical Chromium cases then passed in 1.0 minute, including real BFF stop/restart. Twelve PNGs
remain byte-identical to the previously inspected set; the changed progress and reconnect captures
were inspected again. All 25 source hashes and four harness hashes match the reviewed checkout.
The unchanged freshness gate, 23 updater/editor evidence contract tests and both Linux Editor
bundle gates pass; no baseline or numerical ceiling changed. This remains updater fixture evidence.

The Jira backlog-draft review (#4178, PR #4182) adds draft-tree strings to both optional message
catalogs, so the unchanged freshness gate rejected their previous digests. The complete original
nine-case producer ran again on 2026-10-31 (UTC) on macOS arm64 with Node 24.22.0 and passed in
1.1 minutes, including real BFF stop/restart. All 14 captures were rewritten by this host's
renderer; the three records again bind every declared source and harness digest. No updater
behavior, baseline or numerical ceiling changed. This remains updater fixture evidence.

The partly refused draft guidance (#4178, PR #4182) changed the optional German message catalog
again. The complete original nine-case producer ran on 2026-11-01 (UTC) on macOS arm64 with Node
24.22.0 and passed in 1.4 minutes, including real BFF stop/restart; this host's renderer rewrote two
captures and the three records rebind every declared digest. No updater behavior, baseline or
numerical ceiling changed. This remains updater fixture evidence.

PR #4279 (#4271) shares identical mount reads in `packages/keiko-ui/src/lib/api.ts`, which made the
freshness gate reject that source's old digest. On 2026-11-07 (UTC) the complete original nine-case
producer ran in the Linux gates container, with `--init` and Node 24.18.0. It passed in 1.6 minutes,
including the real BFF stop and restart. The three records rebind only the `api.ts` digest.
That host's Chromium renderer drew all 14 captures with fallback fonts. No visible updater state
changed. No record binds capture bytes, so the existing macOS captures from 2026-11-06 are kept, which
keeps one renderer across the set; the new `generatedAt` describes the three records, not the captures. No updater behavior, baseline or numerical ceiling changed. This remains
updater fixture evidence.

## Reproduce

Use the supported Node 24 runtime and the checkout's own dependencies:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:update-ui-1696
npm run check:update-ui-evidence
```

The retained command name now captures this directory, not historical #1696. Run only one owner
against the suite's configured port/build tree. Container runs need an init process, for example
`docker run --init`, so detached BFF processes are reaped after the real stop/restart journey.
The required CI subset is:

```bash
npm run test:e2e:update-ui-1696 -- --grep @real-bff-outage
```

## Evidence and limits

- [Manifest](manifest.json): 14 screenshots, the proof documents, 25 declared source digests
  (including style/token/translation dependencies), and four harness provenance hashes.
- [Fidelity proof](update-experience-fidelity-proof.json): seven canonical modes, responsive/manual,
  progress, critical notice, portable eligibility, reconnect and remediation captures.
- [Accessibility proof](a11y-proof.json): axe-core 4.12.1 reported no violations in its 12 recorded
  captures; the suite also asserts English/German control, focus and polite-live-region parity.
- The ready-marker selector lives in `UpdateWindow.module.css` because it bridges the existing
  desktop-window and startup-notice contracts in compact viewports (≤720px), with 320px browser
  proof. Its scoped `:global()` references are registered in the Design System exception inventory;
  no shared stylesheet rule was added.
- `13-reconnecting-state-mocked.png` deliberately uses a deterministic transport-failure fixture.
  All screenshots use mocked update API responses and prove rendered UI behavior only.
- The separate real-BFF test passed actual HTTP start acceptance, process stop/restart, retained
  progress, reconnect and durable recovery-required projection. Its release metadata and
  non-mutating execution remain fixtures; it does not prove a native N−1→N replacement.

The manifest records all 17 artifacts and their current source hashes. This set is not final
accessibility acceptance. Final integrated-head verification remains required.
Subjective visual and assistive-technology judgment belongs to the final human review.
Production-signed release qualification is tracked separately in the
[repair ledger](../../../qa/built-in-updater-repair-3405.md).

Historical #1696 screenshots and JSON remain in [their original directory](../1696/README.md).

## Customer updater presentation — #4047

The startup notice uses availability-specific headings and distinguishes a required portable setup
from a confirmed newer version. Its notice-only translations follow the already-lazy widget into
the existing optional catalog. The original freshness producer now binds eleven UI sources,
including both optional catalogs and their translation owner; four harness inputs remain separate.
Three failure-first controls demonstrate that changing any newly bound translation source was
previously missed. The original eight-case browser producer plus the new setup-only reload/details regression
regenerated all 17 original artifacts on macOS arm64 with pinned Node 24.18.0. The nine
Chromium cases passed in 54.6 seconds, including real-BFF outage and the normal/critical
setup-only reload/details checks. All three records bind 11 UI sources and 4 harness inputs;
`10-responsive-manual-path.png`, `11-progress-state.png`, and
`13-reconnecting-state-mocked.png` changed PNG bytes. The unchanged numerical freshness and
Editor isolation gates pass. This remains UI/fixture evidence; actual signed package replacement,
restart and SSD qualification are separate #4047 obligations.

The subsequent #4047 repair preserves the unchanged startup import-boundary control: the thin
preflight/dismissal controller loads its optional-catalog view only when a visible notice is
admitted. A current or suppressed report does not load that view. The original control reproduced
locally as 1 failure/3 healthy controls before the repair and all four pass afterwards. Two existing
UI lint suppressions were removed. The final nine-case producer passed in 47.3 seconds and binds
12 UI sources, including the deferred presentation, plus the same four harness inputs. All 17
artifacts were regenerated through the original producer with tracked evidence enabled; only
`10-responsive-manual-path.png`, `11-progress-state.png`, and
`13-reconnecting-state-mocked.png` changed screenshot bytes in this increment. This still qualifies UI and the declared BFF recovery fixture, not native replacement.

A rejected optional notice-view import is contained locally. The failure-first control uses the
installed Next.js App Router loader and the real shell boundary, rather than the different Pages
loader that plain test resolution selects. It reproduces one desktop-loss failure with one healthy
suppressed-current control before repair. The repaired path records body-free failure evidence,
keeps the workspace mounted, and offers the existing Updates entry and dismissal using core
translations. The final three owning suites pass 77 cases, complete UI coverage passes 10,694 cases
(one existing skip), and the original nine-case browser producer passes again in 1.3 minutes.

The immediate-dismissal correction for #4047 then adds four failure-first action controls. The
common dismissal owner emits the existing presentation transition when the action occurs,
including the optional-view load-failure fallback. Its three owning suites pass 80 cases and
complete UI coverage passes 10,697 cases with one existing skip. The original nine-case browser
producer passes in 1.4 minutes and regenerates the same 17 artifacts, binding the same twelve UI
sources and four harness inputs. This does not establish native package replacement or restart.

The browser-approval integration for #4043 regenerated these updater artifacts again on
2026-10-19 using the original nine-case producer and Node 24.18.0. All nine cases passed
in 1.1 minutes after the final Sonar repairs, including the real-BFF outage and setup-only
notification controls.
All 17 artifacts were regenerated; 12 screenshot files changed bytes, while the three JSON
records bind the current twelve UI sources and four harness inputs. The evidence freshness
gate passes. This is updater presentation and declared BFF recovery evidence; native package
replacement, process-generation ownership and SSD qualification remain separate obligations.

The SonarCloud CSS maintenance on 2026-10-24 regenerated the original nine-case Chromium producer
on macOS arm64 with Node 24.22.0. All nine cases passed in 56.8 seconds, including the real-BFF
outage case; the unchanged freshness gate passed. These updater fixtures qualify presentation and
BFF recovery only. They do not replace the separate Editor smoke or native update qualification.

Source provenance version 2 stores each owned input as an explicit `{ path, sha256 }` record.
The checker rejects duplicates, extra row fields, unsupported versions and any changed source path
or digest. Harness hashes retain their existing exact map. This identifies public checksums as
checksums while preserving the complete input binding and all visual/accessibility thresholds.

## MCP Chat final-source refresh — 2026-10-28

The original nine-case producer passed in 1.7 minutes in the isolated Linux arm64 environment on Node
24.18.0/npm 11.16.0, from `01e3858cd` plus the MCP CSS class-prefix repair. This includes the real BFF
stop/restart journey. All 25 declared source hashes and four harness hashes are fresh. All 14 screenshots
were inspected; 11 are byte-identical to the preceding set, while Settings navigation, progress and
reconnecting-state captures changed. The unchanged updater freshness gate, 287 CSS/proof tests, 25
producer/freshness tests and both Editor bundle gates pass. No numerical ceiling, exception or suppression
changed. This remains updater fixture evidence; it does not prove native installation or MCP/Jira effects.

## Current source-bound regeneration — 2026-10-29

The original nine-case Chromium producer was rerun with tracked evidence enabled on the exact
source commit `4c129452229068c2cbde5d454b5add0d02187933` in the isolated Linux arm64 environment
(Node 24.18.0, npm 11.16.0). All nine cases passed in 1.1 minutes, including the real-BFF outage
journey. The run regenerated all 17 declared artifacts (14 screenshots and three JSON records).
The manifest binds all 25 declared UI sources and four harness inputs; `npm run check:update-ui-evidence`
passes against the current worktree. I visually reviewed the dark update window, Settings entry point,
and reconnecting-state captures. This remains updater presentation and declared BFF recovery evidence;
it does not prove native installation, replacement or restart.

## Registry dist-tags refresh — 2026-10-29 (#3904)

The update preflight now reads the registry's dist-tags document instead of the packument, so the
real-BFF harness (`tests/e2e/support/update-bff-outage-3405.mjs`) answers that document. The
unchanged freshness gate rejected the harness digest, and the original nine-case producer was
rerun with tracked evidence enabled on source commit `92c82e031` in an isolated Linux arm64
container (Node 24.18.0, npm 11.16.0, Playwright 1.64.1, Chromium build 1248, `fonts-liberation`
installed). All nine cases passed in 2.4 minutes, including the real-BFF outage journey. Thirteen
screenshots are pixel-identical to the previous set; `11-progress-state.png` differs in 58 pixels
along the progress bar's edge and was inspected. The three JSON records bind the same 25 UI sources
and four harness inputs; only the outage harness digest changed. A first run in the same image
without `fonts-liberation` rendered every capture in DejaVu Sans and was discarded: reproduce this
set with the Liberation fonts installed. This remains updater presentation and declared BFF recovery
evidence; it does not prove native installation, replacement or restart.

The Jira Pod create form's Data Center placeholders (PR #4182) changed both optional message
catalogs. The complete original nine-case producer ran on 2026-11-02 (UTC) on macOS arm64 with
Node 24.22.0 and passed in 1.1 minutes, including the real-BFF outage journey; only
`11-progress-state.png` changed bytes and was inspected, and the three records rebind every
declared digest. No updater behavior, baseline or numerical ceiling changed. This remains updater
fixture evidence.

The connector selection, Jira Pod card and read-grant changes of the same pull request changed the
optional message catalogs again. The complete original nine-case producer ran on 2026-11-02 (UTC)
on macOS arm64 with Node 26.13.0, npm 11.19.1 and Playwright 1.64.1 and passed in 48.0 seconds,
including the real-BFF outage journey; only `11-progress-state.png` changed bytes (the progress
bar's captured position) and was inspected, and the three records rebind every declared digest.
The evidence freshness gate passed. No updater behavior, baseline or numerical ceiling changed.

The Jira report card's two new messages (PR #4182, review repairs) changed the optional catalogs, so
the original producer ran again on 2026-11-02 with Node 24.18.0. All cases passed, including the
real-BFF outage journey, and the three records rebind every declared digest. The evidence freshness
gate passed. No updater behavior, baseline or numerical ceiling changed.

The requirements read's Chat row label and partial-list note (PR #4182) changed the optional catalogs
again, so the original producer ran on 2026-11-02 with Node 24.18.0. All cases passed, including the
real-BFF outage journey; only `11-progress-state.png` changed bytes (the progress bar's captured
position), and the three records rebind every declared digest. The evidence freshness gate passed.
No updater behavior, baseline or numerical ceiling changed.

The Chat's waiting status and the attachment and requirements labels (PR #4182) changed the core and
optional catalogs, so the original producer ran on 2026-11-02 with Node 24.18.0. All nine cases
passed, including the real-BFF outage journey, and the three records rebind every declared digest. The
evidence freshness gate passed. No updater behavior, baseline or numerical ceiling changed.

The approval card's link label (PR #4182) changed the optional catalogs again, so the original
producer ran on 2026-11-02 with Node 24.18.0. All nine cases passed, and the three records rebind
every declared digest. The evidence freshness gate passed. No updater behavior, baseline or
numerical ceiling changed.

## Message catalog translation — 2026-11-04 (#4183)

Moving hard-coded English texts into the message catalogs (PR #4198) changes the digests of the
declared UI sources `i18n-messages.{en,de}.ts` and `i18n-messages.optional.{en,de}.ts`. The original
producer ran with tracked evidence enabled on Windows 11 (Node 24.21.0, Playwright Chromium headless
shell build 1248) after merging `dev` (1.4.0). That Windows run recorded eight passes and one
failure in "routes default updater JSON and PNG evidence into one untracked output root" while
tracked evidence was enabled. It did not establish a nine-case pass. All 17 declared artifacts
were rewritten. The recorded source digests hash LF line endings, as CI does, because a Windows
checkout may hold CRLF copies. This is Windows rendering, not the Linux Liberation-font set used for
earlier captures, so the 14 PNGs differ in bytes from that set; the update window itself did not
change. A Linux regeneration remains preferable if byte-comparable captures are wanted.

## Source-bound Linux artifact refresh — 2026-11-04

The complete original nine-case producer ran on the exact signed source commit
`db8d4bc4d5cf3a776be135a37d1c278ba61a5db8` in an isolated Linux arm64 checkout, using Node 24.18.0,
npm 11.16.0, Playwright 1.64.1, Chromium build 1248 and Liberation Sans. All nine cases passed in
2.0 minutes, including the real-BFF stop/restart and default evidence-routing cases. The original
producer regenerated all 17 artifacts. All 14 PNGs differ from the preceding Windows set at unchanged
dimensions and were visually inspected; the three JSON records bind all 25 declared UI sources and
nine harness inputs. The unchanged freshness gate and all 65 updater/editor evidence contracts pass.

The same actual Linux production export regenerated the Editor B1/B2/B3 record through the original
producer, and its unchanged gate passes. The initial JavaScript totals 349,126 B gzip across 22
scripts against the unchanged 349,184 B ceiling, leaving 58 B. This artifact run used a 2-CPU quota
and a 20-GiB memory limit. It qualifies updater presentation and the declared BFF recovery fixture,
not D12, workspace or native-runtime performance, native update installation, or final integrated-head
acceptance.

## Chat memory sentences — 2026-11-05 (#4211)

The optional message catalogs are declared sources, and #4211 changed them: the Chat now confirms a
clear remember or forget statement in one sentence, and the former proposal texts are gone. The
producer ran with `KEIKO_WRITE_TRACKED_EVIDENCE=1` on macOS and rewrote all 17 declared artifacts;
`npm run check:update-ui-evidence` passes against this worktree. The update window itself did not
change, and this is macOS rendering, so the 14 PNGs differ in bytes from earlier captures. A Linux
regeneration remains preferable if byte-comparable captures are wanted.

## Keychain-free harness — 2026-11-05 (#4271)

The producer's Playwright configuration is a declared harness input, and #4271 added
`KEIKO_OS_KEYCHAIN: "off"` to its web server so the updater journey never reaches a real login
keychain. The complete original nine-case producer ran with `KEIKO_WRITE_TRACKED_EVIDENCE=1` on
source head `f98c0a4d7` in the Linux arm64 gates container, using Node 24.18.0, npm 11.16.0,
Playwright 1.64.1 and Chromium build 1248. All nine cases passed in 2.1 minutes, including the
real-BFF outage case. All 14 PNGs differ in bytes from the preceding macOS set because this is Linux
rendering; their dimensions are unchanged and they were visually inspected. The three JSON records
bind the current sources and harness inputs, and `npm run check:update-ui-evidence` passes. The
update window itself did not change.

The Jira tool-turn progress poll for #4292 changed `packages/keiko-ui/src/lib/api.ts`, a bound
source. The original nine-case producer ran again in the local gates container (Linux, Node
24.18.0, Chromium build 1248, with an init process). All nine cases passed in 1.6 minutes,
including the real-BFF outage case, and `npm run check:update-ui-evidence` passes. The three JSON
records bind the new API digest. Two screenshots changed bytes, without a visible change to the update window:
`06-update-window-forced-colors.png` and `13-reconnecting-state-mocked.png`.

## Jira UI verification refresh — 2026-11-08

The inherited API and translation fingerprints were refreshed with the complete original producer
on signed UI source head `575997e6caec9f86843cab1cae7f291569043164`, in the isolated Linux arm64
container with Node 24.18.0, Liberation fonts and a Tini subreaper for the BFF lifecycle. All nine
unchanged Chromium cases passed in 1.6 minutes, including the real-BFF stop/restart journey. The
producer regenerated all 17 artifacts, and the source/harness freshness gate passes. Representative
update-window and reconnect captures were visually inspected. No updater behavior, fixture,
assertion or threshold changed; this remains updater fixture and BFF recovery evidence.

## Jira report estimate field refresh — 2026-11-08

The C4 report-card translations changed the declared optional catalog digests. The complete
original producer ran in the Linux arm64 container with Node 24.18.0, an init process and Liberation
fonts: all nine tests passed in 2.4 minutes, including real BFF stop/restart. All source provenance
records were regenerated; the progress and reconnect captures changed and were visually inspected.
No updater behavior, fixture, assertion or numerical ceiling changed. This is updater presentation
and recovery evidence; it does not qualify native installation or a live Jira instance.

## Jira draft trace-warning refresh — 2026-11-08

The S16 trace-warning translations changed the declared optional catalog digests. The complete
canonical producer ran with `KEIKO_WRITE_TRACKED_EVIDENCE=1` and `KEIKO_OS_KEYCHAIN=off` in an
isolated Linux arm64 container limited to 4 CPUs and 4 GiB, using Node 24.18.0 and Chromium 156
(build 1248). All nine cases passed with one worker, including real BFF stop/restart; the recorded
command exited 0 after 136.4 seconds. The producer regenerated 14 PNGs and three JSON records,
and the unchanged source/harness freshness check exited 0. This renderer used DejaVu fallback
fonts, not the Liberation fonts of earlier Linux captures. No Jira operation or model generation
was exercised; startup recorded an unavailable gateway readiness check (`EAI_AGAIN`).

Visual inspection of captures 01–10 found the updater text and actions readable in the desktop
theme and contrast variants. Capture 10, at a 320-CSS-pixel viewport, shows a scrolled portion of
the manual-update window: its heading and the beginning of the first command are outside the
capture, while **Check again** remains visible. It therefore does not establish complete visual
acceptance of the manual path. These records describe this fixture run and its captured source
digests; they do not identify or qualify the final UI build, change any bundle budget, or establish
native update or Jira/model behavior.
