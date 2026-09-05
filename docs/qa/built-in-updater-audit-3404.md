# Built-in updater audit — Issue #3404

**Audience:** maintainers, release/security reviewers, and the #3405 implementer. This body-free,
read-only audit describes exact HEAD `9348fb9c36bbae730c6856d79d91ee6a6cadcbc3`; it does not repair
production behavior or qualify an installed release.

## Scope, invariants, and non-goals

Scope is release discovery, install attestation, preflight, confirmation, staging, activation,
relaunch, recovery, remediation, UI/CLI projections, native setup/launch, release workflows,
logging, and tests. Invariants are explicit confirmation; reviewed candidate binding; one active
session; fixed argv; managed-root attestation; stage-before-promotion; atomic promotion; current
install preservation; fail-closed trust; content-free state/evidence; and server-only release fetch.

Non-goals are rollback/downgrade, prerelease/private/beta channels, background updates, new
platforms/installers, privileged helpers, IT-managed mutation, package caches, repository repair,
and making evaluation `0.3.17` eligible. Production one-click remains externally blocked on #2198,
provider/runners, and two production-signed releases.

## Concrete artifact inventory

This production ownership table is deliberately separate from the exhaustive appendix. Native provider
execution remains outside this checkout; tests and design evidence are verification inputs, not
production authorities.

| Repo-relative artifact path(s)                                                                                                                                                                                                                                                     | Owner/role                                                                      | Consumers                           | Disposition                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| `packages/keiko-contracts/src/release-impact.ts`, `packages/keiko-contracts/src/update-preflight.ts`, `packages/keiko-contracts/src/update-session.ts`, `packages/keiko-contracts/src/update-local-state.ts`, `packages/keiko-contracts/src/update-remediation.ts`                 | Contracts: compatibility, preflight, session, recovery, and remediation schemas | Server, CLI, UI                     | Retain; extend only through public contracts             |
| `packages/keiko-contracts/src/index.ts`, `packages/keiko-contracts/package.json`                                                                                                                                                                                                   | Contracts composition and public subpath exports                                | Server, CLI, UI, external consumers | Retain export compatibility                              |
| `packages/keiko-server/src/update-install-mode.ts`, `packages/keiko-server/src/update-portable-install-mode.ts`                                                                                                                                                                    | Server install attestation                                                      | Preflight, session, UI, CLI         | Retain                                                   |
| `packages/keiko-server/src/update-preflight.ts`, `packages/keiko-server/src/update-preflight-registry.ts`, `packages/keiko-server/src/update-preflight-catalog.ts`, `packages/keiko-server/src/update-preflight-impact.ts`, `packages/keiko-server/src/update-preflight-report.ts` | Server discovery and report projection                                          | Routes, session, UI                 | Repair candidate binding and startup caching             |
| `packages/keiko-server/src/update-preflight-portable-assets.ts`, `packages/keiko-server/src/update-preflight-portable-evidence.ts`, `packages/keiko-server/src/update-preflight-portable-shared.ts`                                                                                | Server portable candidate/evidence policy                                       | Preflight, staging                  | Repair redirect handling; retain shared guards           |
| `packages/keiko-server/src/update-session.ts`, `packages/keiko-server/src/update-session-lock.ts`, `packages/keiko-server/src/update-session-support.ts`, `packages/keiko-server/src/update-local-state.ts`                                                                        | Server lifecycle, locking, support, and durable state                           | Routes, CLI, activation, recovery   | Repair durability/cancellation; preserve lock boundary   |
| `packages/keiko-server/src/update-portable-staging.ts`, `packages/keiko-server/src/update-portable-staging-archive.ts`, `packages/keiko-server/src/update-portable-staging-manifest.ts`, `packages/keiko-server/src/update-portable-staging-shared.ts`                             | Server archive staging and resource policy                                      | Session, activation                 | Repair streaming/cancellation; retain fail-closed policy |
| `packages/keiko-server/src/update-portable-sidecar-verification.ts`, `packages/keiko-server/src/update-portable-sidecar-staging-verification.ts`, `packages/keiko-server/src/update-portable-platform-verification.ts`                                                             | Server sidecar and platform verification                                        | Staging, activation                 | Retain; qualify on native runners                        |
| `packages/keiko-server/src/update-portable-activation.ts`, `packages/keiko-server/src/update-portable-activation-files.ts`                                                                                                                                                         | Server atomic promotion, relaunch, recovery                                     | Session, native launcher            | Repair durable recovery and cancellation                 |
| `packages/keiko-server/src/update-preflight-routes.ts`, `packages/keiko-server/src/update-session-routes.ts`, `packages/keiko-server/src/update-remediation-routes.ts`                                                                                                             | Server BFF endpoints                                                            | UI, CLI                             | Retain routes; bind starts to reviewed candidates        |
| `packages/keiko-server/src/index.ts`, `packages/keiko-server/src/deps.ts`, `packages/keiko-server/src/routes.ts`                                                                                                                                                                   | Server exports and production composition                                       | Server host, UI BFF, CLI            | Retain composition boundary                              |
| `packages/keiko-cli/src/update.ts`, `packages/keiko-cli/src/update-output.ts`                                                                                                                                                                                                      | CLI status/check/apply projection                                               | Operators, server session           | Repair execution authority; retain body-free output      |
| `packages/keiko-cli/src/portable.ts`, `packages/keiko-cli/src/portable-install.ts`, `packages/keiko-cli/src/portable-registration.ts`, `packages/keiko-cli/src/portable-maintenance.ts`, `packages/keiko-cli/src/portable-macos-activation.ts`                                     | CLI portable setup and recovery                                                 | Operators, launcher, activation     | Retain                                                   |
| `packages/keiko-cli/src/launcher.ts`, `packages/keiko-cli/src/launcher-paths.ts`, `packages/keiko-cli/src/launcher-platforms.ts`, `packages/keiko-cli/src/launcher-state.ts`                                                                                                       | CLI launcher state/launch boundary                                              | Setup and portable commands         | Retain                                                   |
| `packages/keiko-cli/src/index.ts`, `packages/keiko-cli/src/runner.ts`, `packages/keiko-cli/package.json`                                                                                                                                                                           | CLI exports, command dispatch, package boundary                                 | Command-line consumers              | Retain public command contract                           |
| `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx`, `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx`, `packages/keiko-ui/src/app/components/desktop/update/update-copy.ts`                                                        | UI update review and startup projection                                         | Desktop shell, Settings             | Repair startup behavior; retain presentation boundary    |
| `packages/keiko-ui/src/app/relationships/api.ts`, `packages/keiko-ui/src/app/components/desktop/widgets/index.tsx`                                                                                                                                                                 | UI API/widget composition boundaries                                            | Desktop shell, BFF consumers        | Retain; register update window through widgets           |
| `native/portable-launcher/keiko-portable-launcher.c`, `native/portable-launcher/keiko-portable-launcher.rc`, `native/setup-bootstrap/keiko-setup-bootstrap.c`, `native/setup-bootstrap/keiko-setup-bootstrap.rc`                                                                   | Native launcher and setup sources                                               | Portable activation and installers  | Retain; production qualification externally blocked      |
| `scripts/portable-runtime.mjs`, `scripts/assemble-portable-release-assets.mjs`, `scripts/resolve-release-portable-assets.mjs`, `.github/workflows/portable-assets.yml`                                                                                                             | Release assembly, verification, and workflow                                    | CI, release engineering             | Retain release authority                                 |

## Authoritative lifecycle and durability

The contract is `checking → confirmed → preparing → downloading → verifying → staging →
handoff-pending → activating → verifying-relaunch → cleanup-pending/remediation-required →
succeeded`. Cancellation is allowed only before durable handoff/package mutation. After the cutoff,
outcomes roll forward, perform a verified restore, or become `recovery-required`.

The candidate snapshot contains candidate id, release tag/id, asset name/id/size, archive/manifest/
sidecar/catalog digests, current/target versions, platform/architecture, install kind/root identity,
trust-policy version, issued/expiry, and install snapshot. It contains no payload, raw URL/path, log,
credential, or customer data. The semantic aggregate contains schema/version, revision, session and
candidate ids, correlation id, state/phase timestamps, target/install summaries, progress counters,
cancellation cutoff, terminal proof, error/recovery kind, and remediation status.

Durability is same-volume temp write + fsync + atomic rename + parent-directory fsync. The aggregate
intent revision is written before each irreversible WAL phase. WAL phases are `prepared`,
`old-exited`, `promoted`, `registered`, `new-started`, `verified`, `cleanup-pending`, `complete`.
If WAL is ahead, it is mechanical fact authority; if equal, the aggregate is semantic authority; a
stale aggregate advances from validated WAL/runtime attestation, and a stale WAL never rolls semantic
state backward.

Handoff order is fixed: old BFF atomically persists `handoff-pending` and WAL intent, resolves an
existing packaged, locally verified neutral coordinator through a server-owned absolute executable
identity, then quiesces/releases the port and exits. The coordinator never accepts caller-controlled
executable, path, or command input; it consumes only durable candidate/WAL authority. It verifies the
executable and exact old/new process identity without logging raw paths or signing material, then
promotes/registers/starts N. N BFF reconciles WAL before serving normal status, verifies exact N, and
settles cleanup/remediation. On failure it restores N−1 only after proving N does not own the tree,
then proves N−1 healthy.

| Crash point       | Write order / commit point           | Startup observation       | Result                                                 |
| ----------------- | ------------------------------------ | ------------------------- | ------------------------------------------------------ |
| `prepared`        | aggregate intent, WAL `prepared`     | no handoff                | delete staging; failed/cancelled                       |
| `old-exited`      | WAL after verified exit/port release | old absent, N not active  | coordinator rolls forward or recovery-required         |
| `promoted`        | tree swap then WAL                   | candidate owns tree       | verify N; restore only after ownership proof           |
| `registered`      | registration then WAL                | registration may point N  | verify registration/N, repair or recovery-required     |
| `new-started`     | process identity then WAL            | N may own port            | N reconciles before normal status                      |
| `verified`        | target proof then WAL/aggregate      | exact N healthy           | cleanup/remediation                                    |
| `cleanup-pending` | cleanup intent then aggregate        | N healthy, backup remains | bounded cleanup; >24h visible recovery-required/manual |
| `complete`        | cleanup proof then aggregate         | terminal proof            | succeeded                                              |

Every irreversible action has an intent/completion pair: `promote-intent` is fsynced before swap
and `promoted` is fsynced after; `start-intent` is fsynced before spawn and `new-started` after. If
the action happened but completion is absent, recovery probes filesystem, registration, and exact
process identity; it never assumes the prior phase.

## Trust, redirect, resource, and retry bindings

Package-manager execution must consume a server-produced short-lived single-use candidate; arbitrary
stable semver is not a valid execution input. Portable staging keeps manifest/digest/platform checks,
then performs full-tree/platform rebinding before promotion. Windows verifies PublicTrust/code-signing
chain, timestamp, and subscriber identity-validation EKU without leaf pin. macOS retains Developer ID
and notarization authority.

The initial asset is the reviewed name at the configured approved repository release-asset origin.
Each manual redirect requires nonempty `Location`, secure transport/no credentials, membership in the
approved GitHub-owned content-origin family, at most three hops, per-hop gateway egress/DNS
revalidation, and loop rejection. Missing, unsafe, excessive, or non-success responses return closed
`portable-download-failed` with no mutation. This is the policy exercised by
`packages/keiko-server/src/update-preflight-portable-evidence.ts:64-82` and
`packages/keiko-model-gateway/src/http.ts:1364-1375`; preflight must reuse it. The observed redirect
rejection is a preflight defect, distinct from the staging-origin-policy non-finding.

Pattern evidence is available for public v0.3.17 `keiko-macos-arm64.zip`: 134,924,040 bytes,
SHA-256 `8bf1986962d570893fbe52b48ded7bbf41f86115a01624ffb7bbd7ef866ff7ae`, 10,311 ZIP entries, central-directory compressed bytes 131,840,224,
and declared uncompressed E=423,122,345. A Node 24.18.0 chunk accumulation → Uint8Array →
Buffer.from probe retained 269,848,080 bytes; RSS was 352,403,456 before copy and 486,735,872 after,
maxRSS 475,328 KiB, time-max resident 487,063,552, wall 0.25s, exit 0. This is a whole-buffer
pattern probe, not the full stager or a native release-device baseline; temporary bytes were removed.
Current-tree M is unavailable, so the disk formula fails closed rather than claiming a pass.

Frozen engineering defaults are: current caps 256,000-byte text, 512 MiB archive, 60,000 entries,
2 GiB tree, 256 MiB/entry, 100x ratio, three redirects, five minutes/request, 30 seconds/platform
command; preflight 8 seconds/request; portable operation 15-minute monotonic deadline covering
archive read, extraction/hash/native verify/cleanup; relaunch 30 seconds; native output 16 KiB;
`maxConcurrent=1`. No automatic full-session retry. Metadata/download may retry two additional times
only for DNS/timeout/429/5xx before trusted bytes, honoring `Retry-After` up to 30s with 1s/3s
backoff, all sharing 15m; redirects are not retries. Progress is at least once per 1 MiB or 1s.
Cleanup retains one backup, uses existing six-attempt/620ms Windows rename behavior, reconciles each
startup, and exposes >24h pending cleanup as recovery-required/manual. Missing or invalid statfs,
archive size, manifest E, or current-tree measurement fails closed before mutation with a closed
manual/recovery result. Disk refusal precedes download/staging: `F >= A + E + max(512MiB, ceil(0.10*(M+A+E)))`, where M is
current tree, A archive, E manifest uncompressed size. These defaults are frozen engineering inputs
subject to #3405 tests and native qualification.

Reproduction requires Node 24.18.0 and npm 11.16.0 on `PATH`. This executable probe is deliberately
body-free and leaves no retained asset:

```sh
(
set -eu
tmp_dir="$(mktemp -d)"
asset="$tmp_dir/keiko-macos-arm64.zip"
trap 'rm -f "$asset"; rmdir "$tmp_dir"' EXIT
gh release download v0.3.17 --repo oscharko-dev/Keiko --pattern keiko-macos-arm64.zip --dir "$tmp_dir"
printf '%s  %s\n' '8bf1986962d570893fbe52b48ded7bbf41f86115a01624ffb7bbd7ef866ff7ae' "$asset" | shasum -a 256 --check --status
unzip -l "$asset"
node --expose-gc --input-type=module --eval '
  import { createReadStream, statSync } from "node:fs";
  import { once } from "node:events";
  const asset = process.argv[1];
  const beforeCopy = process.memoryUsage().rss;
  const chunks = [];
  const input = createReadStream(asset);
  input.on("data", (chunk) => chunks.push(chunk));
  await once(input, "end");
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const assembled = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { assembled.set(chunk, offset); offset += chunk.byteLength; }
  chunks.length = 0;
  global.gc();
  const afterCopy = process.memoryUsage().rss;
  const retained = Buffer.from(assembled);
  const maxRSS = process.resourceUsage().maxRSS;
  process.stdout.write(JSON.stringify({ bytes: statSync(asset).size, beforeCopy, afterCopy,
    retained: retained.byteLength, maxRSS }) + "\n");
' "$asset"
)
```

The probe used the real asset and recorded the metrics above; it is not the full stager or a native
release-device baseline. Full stager, `statfs`, managed-tree M, disk, latency, and native measurements
remain blocked.

## Supported matrix and reproducibility ledger

Every row has one status. Evidence is body-free; `unavailable` means no artifact/runner/digest was
available, not a guessed result.

| Environment/cell                                                                   | Immutable input or unavailable marker                           | Exact evidence                                                                                                                                                                                                                                                                                                     | Observed result                                                                        | Status             | Owner           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------ | --------------- |
| npm persistent/current and Yarn persistent/newer                                   | checkout HEAD; synthetic package metadata                       | `packages/keiko-server/src/update-session-routes.test.ts:254` (`validates start request bodies and starts a session`); `packages/keiko-server/src/update-session.ts:201-204`                                                                                                                                       | direct mutation owner accepts an arbitrary stable target                               | confirmed defect   | server          |
| npm/Yarn equal/older and stable latest discovery                                   | synthetic versions/catalog                                      | `packages/keiko-server/src/update-preflight.test.ts:433` (`reports current with GitHub release notes when npm latest matches the running version`); `packages/keiko-server/src/update-preflight.test.ts:533` (`keeps the running version as target when it is ahead of the registry latest`)                       | pass only for discovery producer                                                       | pass               | server          |
| npx/yarn dlx; local/dev/linked/ambiguous                                           | synthetic transient/unsupported roots                           | `packages/keiko-server/src/update-install-mode.test.ts:1`                                                                                                                                                                                                                                                          | manual-only                                                                            | intentional block  | server/CLI      |
| evaluation `0.3.17`                                                                | evaluation marker                                               | `docs/adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md:48-61`; `docs/adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md:232-290`                                                                                                                               | intentionally ineligible                                                               | intentional block  | release         |
| windows-x64, macos-arm64, macos-x64 native N−1/N                                   | signed artifacts/native runners unavailable                     | unavailable native input: protected provider artifacts, immutable digest, and runner                                                                                                                                                                                                                               | absent prerequisites                                                                   | externally blocked | native/release  |
| prerelease/private/missing/unreviewed                                              | synthetic catalog                                               | `packages/keiko-server/src/update-preflight.test.ts:1022` (`fails closed on prerelease portable GitHub metadata without consulting npm`)                                                                                                                                                                           | blocked/manual                                                                         | intentional block  | release         |
| approved-origin metadata redirect                                                  | redirect fixture                                                | `packages/keiko-server/src/update-preflight-portable-evidence.ts:64-82`; `packages/keiko-model-gateway/src/http.ts:1364-1375`                                                                                                                                                                                      | redirect is rejected                                                                   | confirmed defect   | server          |
| staging origin policy                                                              | source policy                                                   | `packages/keiko-server/src/update-portable-staging-manifest.ts:173-215`                                                                                                                                                                                                                                            | safe walker exists; no missing-policy finding                                          | pass               | security/server |
| offline/DNS, proxy/custom CA, timeout, 403/404/429/5xx                             | synthetic gateway errors                                        | `packages/keiko-server/src/update-preflight.test.ts:1101` (`fails quietly with a degraded report when the registry times out`)                                                                                                                                                                                     | bounded degraded result                                                                | pass               | server          |
| truncated/oversized body                                                           | bounded fixture                                                 | `packages/keiko-server/src/update-portable-staging.test.ts:1`                                                                                                                                                                                                                                                      | rejected                                                                               | pass               | server          |
| first/fresh manual check                                                           | server/UI fixtures                                              | `packages/keiko-server/src/update-preflight.test.ts:1743` (`reuses the startup session on GET and retries on manual POST`); `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx:887` (`surfaces load errors and recovers through a manual check`)                                           | projected                                                                              | pass               | server/UI       |
| cached startup check                                                               | startup fixture                                                 | `packages/keiko-server/src/update-preflight.test.ts:1684` (`caches the startup result per BFF while manual checks always retry`); `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.test.tsx:117` (`keeps a dismissed startup notice hidden when only the startup check timestamp changes`) | cached memoization is a defect                                                         | confirmed defect   | UI              |
| confirmation                                                                       | CSRF/session fixture                                            | `packages/keiko-server/src/update-session-routes.test.ts:244` (`requires CSRF for state-changing update session routes`); `packages/keiko-server/src/update-session-routes.test.ts:254` (`validates start request bodies and starts a session`)                                                                    | CSRF and request-shape coverage; confirmation required                                 | pass               | server          |
| concurrent start                                                                   | two-session fixture                                             | `packages/keiko-server/src/update-session-lock-race.test.ts:1`                                                                                                                                                                                                                                                     | one active lock                                                                        | pass               | server          |
| process restart                                                                    | no durable aggregate fixture                                    | `packages/keiko-server/src/update-session.ts:158-184`                                                                                                                                                                                                                                                              | state loss                                                                             | confirmed defect   | server          |
| crash prepared/old-exited/promoted/registered/new-started/verified/cleanup-pending | signed package, immutable digest, and native runner unavailable | unavailable native input: protected provider artifact and runner                                                                                                                                                                                                                                                   | no execution result may be inferred                                                    | externally blocked | native/server   |
| metadata cancellation                                                              | abort fixture                                                   | `packages/keiko-server/src/update-session.test.ts:388` (`allows cancellation before package-manager execution starts only`); `packages/keiko-server/src/update-session.test.ts:408` (`aborts cancellation requests once package mutation is running`)                                                              | cancellation behavior exercised; cutoff semantics need repair proof                    | confirmed defect   | server          |
| manifest/checksum cancellation                                                     | abort fixture                                                   | `packages/keiko-server/src/update-portable-staging.test.ts:509` (`downloads, verifies, stages, and records content-free state`)                                                                                                                                                                                    | staging fixture does not prove safe cleanup; local fixture does not prove safe cleanup | confirmed defect   | server          |
| artifact-read cancellation                                                         | abort fixture                                                   | `packages/keiko-server/src/update-session.test.ts:388` (`allows cancellation before package-manager execution starts only`); `packages/keiko-server/src/update-session.test.ts:408` (`aborts cancellation requests once package mutation is running`)                                                              | cancellation behavior exercised; abort misclassified retryable                         | confirmed defect   | server          |
| extraction cancellation                                                            | no producer support                                             | `packages/keiko-server/src/update-portable-staging-archive.ts:347-421`                                                                                                                                                                                                                                             | extraction lacks an abort-aware producer; missing                                      | confirmed defect   | server          |
| pre-promotion cancellation                                                         | abort fixture                                                   | `packages/keiko-server/src/update-portable-activation.test.ts:348` (`terminates an already-spawned relaunch before rolling the promotion back`)                                                                                                                                                                    | cutoff proof required; cutoff proof required                                           | confirmed defect   | server          |
| post-promotion/relaunch/version                                                    | signed package, immutable digest, and native runner unavailable | unavailable native input: protected provider artifact and runner                                                                                                                                                                                                                                                   | no execution result may be inferred                                                    | externally blocked | native          |
| UI update journey                                                                  | contract-shaped route fixtures                                  | `tests/e2e/update-ui-1696.spec.ts:460-558` (all update BFF routes are mocked)                                                                                                                                                                                                                                      | route-mocked journey only; all update routes mocked                                    | not applicable     | UI/QA           |

Executed evidence: `npm ci` (0 vulnerabilities); `npm run check:typescript-toolchain` PASS;
`npm run build:packages` PASS; focused server updater tests 91 passed/1 skipped; UI update tests
57 passed; the five-file security-focused command below produced 116 passed. The exact commands are
listed in the test-plan section.

## Security findings

Security-only settled verdict: **0 Critical, 0 High, 4 Medium, 2 Low**. Broader reliability,
performance, and accessibility findings are classified separately below and are not security
severity claims.

| Finding / severity               | Exact evidence                                                                                                                                                                         | #3405 owner            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Candidate binding / Medium       | `packages/keiko-server/src/update-session.ts:201-204`; `packages/keiko-server/src/update-preflight-registry.ts:267-300`; `packages/keiko-server/src/update-session-routes.test.ts:254` | candidate issuer/route |
| Windows trust / Medium           | `packages/keiko-server/src/update-portable-platform-verification.test.ts:157`; `docs/adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md: D7`                  | Windows adapter        |
| Durable recovery / Medium        | `packages/keiko-server/src/update-session.ts:158-184`                                                                                                                                  | aggregate/WAL          |
| Preflight redirect / Medium      | `packages/keiko-server/src/update-preflight-portable-evidence.ts:64-82`; `packages/keiko-model-gateway/src/http.ts:1364-1375`                                                          | gateway/preflight      |
| Stage-to-activation TOCTOU / Low | `packages/keiko-server/src/update-portable-activation-files.ts:197-208`; `packages/keiko-server/src/update-portable-activation-files.ts:309-341`                                       | promotion rebind       |
| Canonical logging / Low          | `packages/keiko-server/src/update-local-state.ts:572-593`; `packages/keiko-server/src/update-session-routes.ts:116-129`; `packages/keiko-server/src/server.ts:472-503`                 | observability          |

## Reliability, performance, and accessibility findings

These are independent operational severities, not security severities.

| Finding / operational severity                  | Exact evidence                                                                                                                                                                                                                                                                                                                                  | #3405 owner  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Portable cancellation / P2 reliability          | `packages/keiko-server/src/update-session.ts:489-497`; `packages/keiko-server/src/update-portable-staging-archive.ts:1-496`; `packages/keiko-server/src/update-portable-activation.test.ts:344-348` documents rollback after failed relaunch verification, not an abort case; activation abort coverage is absent and remains a test obligation | cancellation |
| UI polling/startup diagnostics / P2 reliability | `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx:1459-1518`; `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx:107-123`                                                                                                                                                                         | UI reconnect |
| Resource bounds / P2 performance                | `packages/keiko-server/src/update-portable-staging-manifest.ts:173-215`; `packages/keiko-server/src/update-portable-staging-shared.ts:1-260`; `packages/keiko-server/src/update-portable-staging-archive.ts:347-421`; `packages/keiko-server/src/update-portable-activation-files.ts:197-208`                                                   | bounded I/O  |
| Accessibility/evidence drift / P3 accessibility | `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx:602-680`; `docs/design-system/evidence/1696/update-experience-fidelity-proof.json:1`; `docs/design-system/update-experience.md:1`                                                                                                                                         | UI/a11y      |

Disproved/non-findings: archive traversal, shell injection, remote-auth bypass, macOS continuity
bug, and missing staging origin policy. Native relaunch deadlock and exact disk behavior remain
unconfirmed until signed artifacts/runners exist. L1 is latent, not an observed incident.

### Native-unconfirmed hypotheses and latent obligations

| Hypothesis/obligation      | Evidence and boundary                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Same-port handoff deadlock | `packages/keiko-server/src/update-portable-activation.ts:397-415`; requires real two-process native run; no severity assigned   |
| `beforeExecute` strand     | `packages/keiko-server/src/update-session.ts:433-434`; latent because no production hook composition was found; test obligation |

## Duplication/deletion and canonical support register

Retain contracts/catalog/manifest authorities and test doubles. Consolidate in-memory session fields
into projections over the durable aggregate. Migrate legacy updater JSONL into canonical body-free
`update.*` operations, then retire JSONL after compatibility checks. Do not retain a parallel updater
authority, channel UI, or sidecar updater.

Canonical operations cover preflight, candidate claim, every state/WAL phase, stage, trust verify,
activation, relaunch, remediation, recovery, and cleanup. Each includes request/background correlation,
session/candidate ids, phase/result, closed error kind, redacted digest references, and no body/path/
credential. Current JSONL is separate from `server.log`, lacks request correlation, and ignores
persistence warnings; support cannot reconstruct a reliable updater timeline.

## UI, CLI, and accessibility truth table

| Condition                   | Current UI/CLI truth                        | Required assertion                                     |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| current/manual/eligible     | version and impact review; CLI fixed output | exact candidate/install identity                       |
| preparing/running           | progress; cancel exposed too broadly        | cutoff and bounded progress                            |
| relaunch                    | route polling exists                        | durable reconnect, polite status, no premature success |
| success/remediation/failure | projections exist                           | terminal proof, remediation, closed error kind         |
| blocked/manual              | instructions, no guessed command            | accessible reason/action, no mutation                  |
| startup/poll error          | startup swallows; poll can stop             | visible diagnostic and bounded continuation            |

Positive evidence: i18n parity 177/177 and UI tests 57/57. Current gaps are the success/restart
polite status announcement, stale Issue #1696 proof `cssSha256` versus `globals.css`, missing
UpdateWindow/UpdateStartupNotice owner row in the fidelity matrix, and missing loading glyph.
Playwright must assert widths 320/420; dark/light/high-contrast/forced-colors/reduced-motion;
EN/DE accessible names/statuses; keyboard/focus/live regions/progress; no horizontal overflow;
24×24 controls; and axe results. Identify mocked routes and use production routes where available.

## Documentation drift register

ADR-0099/0121 remain authority for confirmation, impact, managed roots, promotion, and non-pinned
Windows trust, but must describe aggregate/WAL, handoff ownership, redirect policy, and native limits.
Update `docs/design-system/update-experience.md`, `docs/design-system/fidelity-matrix.md` and its
proof hash/owner rows, `docs/qa/local-runtime-state-verification.md`, observability/support guidance,
portable launch/troubleshooting, portable runtime artifact/signing docs, release-impact/publish
runbooks, and both updater QA matrices. Existing mocked/synthetic lifecycle claims must be labeled
repository-only.

## Frozen minimal repair contract for #3405

The lifecycle, schemas, durability, handoff, trust, redirect, resource, retry, progress, logging,
UI reconnect, and migration rules above are frozen engineering inputs. Production one-click remains
blocked until #2198/provider/runners provide two signed releases and all three native target journeys.

## Failure-first / passing-after test plan and commands

For each named production producer, the test must fail before #3405 and pass after it: metadata
candidate binding; manifest/checksum; artifact read; extraction cancellation; pre-promotion; post-
promotion; relaunch; version verification; and crash points `prepared`, `old-exited`, `promoted`,
`registered`, `new-started`, `verified`, `cleanup-pending`, `complete`. Assertions are exact state,
WAL/aggregate revision, cleanup/ownership proof, and body-free operations.

Exact executed commands and outcomes are:

```sh
npm ci                                      # 0 vulnerabilities
npm run check:typescript-toolchain          # PASS
npm run build:packages                      # PASS
NODE_OPTIONS=--max-old-space-size=8192 \
  ./node_modules/.bin/vitest run packages/keiko-server/src/update-session.test.ts \
  packages/keiko-server/src/update-session-routes.test.ts packages/keiko-server/src/update-preflight.test.ts \
  packages/keiko-server/src/update-integration.test.ts       # 4 files, 91 passed, 1 skipped
NODE_OPTIONS=--max-old-space-size=8192 \
  npm --workspace @oscharko-dev/keiko-ui run test -- \
  src/app/components/desktop/update/UpdateWindow.test.tsx \
  src/app/components/desktop/update/UpdateStartupNotice.test.tsx # 2 files, 57 passed
NODE_OPTIONS=--max-old-space-size=8192 \
  ./node_modules/.bin/vitest run packages/keiko-server/src/update-portable-activation.test.ts \
  packages/keiko-server/src/update-portable-sidecar-verification.test.ts \
  packages/keiko-server/src/update-local-state.test.ts packages/keiko-server/src/update-session-lock.test.ts \
  packages/keiko-server/src/update-local-state-hardlink-fallback.test.ts # 5 files, 116 passed
NODE_OPTIONS=--max-old-space-size=8192 \
  ./node_modules/.bin/vitest run packages/keiko-server/src/update-session-routes.test.ts \
  packages/keiko-server/src/update-portable-platform-verification.test.ts \
  --testNamePattern='validates start request bodies and starts a session|fails closed when staged and active signer identities differ' # 2 passed, 15 skipped
```

The focused server result is the source-level proof for M1/M2: the session route assertion is at
`packages/keiko-server/src/update-session-routes.test.ts:254`, and signer-identity rejection is at
`packages/keiko-server/src/update-portable-platform-verification.test.ts:157`. Supplemental Node
evaluation observed rejected `beforeExecute` with `activePhase=preparing` and `lockHeld=true`.
The update UI E2E command, portable smoke, manual review, and native packaged commands remain #3405
obligations; no result is claimed for those unrun lanes.

## Sanitized support examples and gap analysis

Illustrative only; this does not claim current `server.log` produces the timeline:
`request r-001 → preflight c-001 target-vN digest d-001 → confirm s-001 → download 1MiB/1s → verify
d-001 → handoff h-001 → relaunch pid-class p-001 → terminal succeeded`. Identifiers and digests are
fake bounded labels. The current gap is generic HTTP plus separate JSONL, so request, session, and
terminal events cannot be joined.

## Acceptance and deliverable closure

| #3404 acceptance/deliverable                    | Report evidence                                           | Disposition                                                               |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| enumerated repository surface                   | concrete artifact inventory                               | Satisfied                                                                 |
| confirmed gaps reproduced/bounded               | findings register and ledger                              | Satisfied                                                                 |
| arbitrary target bypass shown                   | M1 and package rows; exact focused test command above     | Satisfied                                                                 |
| rotating Windows leaf settled                   | M2 static contradiction and repair rule                   | Satisfied; native accept/reject externally blocked                        |
| packaged native N−1→N each target               | native ledger rows                                        | Externally blocked                                                        |
| crash checkpoints mapped                        | WAL crash table and ambiguous-window rule                 | Satisfied; native execution externally blocked                            |
| cancellation traced at every checkpoint         | ledger and failure-first plan                             | Satisfied (repair proof pending)                                          |
| finite resource semantics measured              | caps/formula/static review and whole-buffer pattern probe | Satisfied for pattern; full stager/disk/latency/native externally blocked |
| UI/CLI truth and a11y                           | truth table and Playwright obligations                    | Satisfied (packaged proof pending)                                        |
| canonical log/support contract                  | canonical support register                                | Satisfied (implementation pending)                                        |
| intentional non-goals/evaluation gate           | scope and matrix                                          | Satisfied                                                                 |
| implementer can proceed without scope reopening | frozen contract/schema/handoff                            | Satisfied                                                                 |
| sanitized support examples/gap analysis         | canonical support register                                | Satisfied                                                                 |
| exact commands/evidence recorded                | verification section and baseline                         | Satisfied with retained-command limitation                                |

## External blockers and limitations

Windows x64, macOS arm64, and macOS x64 production-signed N−1/N archives, immutable digests,
protected provider access, native runners, and #2198 are unavailable. No native result is inferred
from static or mocked evidence. This report contains no customer/private runtime-state paths,
URLs/endpoints, credentials, certificate material, bodies, or raw logs, and makes no claim for an
unobserved execution result.

## Appendix A — updater seed inventory and shared dependency boundaries

The filename discovery command below produced 194 paths at audited HEAD. This is a seed set, not a
proof that all dependencies contain an updater keyword. The marker-bounded inventory accounts for each
discovered path exactly once: this report is self/excluded, and the two explicitly identified
context-only paths remain listed but are not updater-owned. Group preambles provide the owner,
consumers, and disposition for every following path. The additional composition and shared dependency
registers below are required parts of the audit; the 194/194 comparison alone does not settle scope.

```sh
rg --files packages native scripts tests .github docs | rg '(^|/)([^/]*(update|portable|launcher|release-impact)[^/]*)' | sort
```

The following recorded check must print `194` twice and no `comm` output; it compares only the
marker, not the additional composition records below it.

```sh
rg --files packages native scripts tests .github docs | rg '(^|/)([^/]*(update|portable|launcher|release-impact)[^/]*)' | sort > /tmp/discovered-3404
sed -n '/^<!-- updater-surface:start -->$/,/^<!-- updater-surface:end -->$/p' docs/qa/built-in-updater-audit-3404.md | rg -o '`[^`]+`' | tr -d '`' | rg '^(\.github|docs|native|packages|scripts|tests)/' | sort -u > /tmp/marker-3404
wc -l /tmp/discovered-3404 /tmp/marker-3404
comm -3 /tmp/discovered-3404 /tmp/marker-3404
```

<!-- updater-surface:start -->

### Self / excluded

Owner: audit; consumers: reviewers; disposition: self/excluded from updater ownership.

- `docs/qa/built-in-updater-audit-3404.md`

### Context-only / not updater-owned

Owner: contextual documentation/evaluation fixture; consumers: adjacent decision and memory evaluation; disposition: context-only/not updater-owned.

- `docs/release/2293-dependency-update-decision-matrix.md`
- `tests/memory-eval/fixtures/knowledge-update.json`

### Release workflow

Owner: release engineering; consumers: CI and release maintainers; disposition: retain as production workflow.

- `.github/workflows/portable-assets.yml`

### Documentation

Owner: documentation/QA; consumers: maintainers and release reviewers; disposition: retain as authority or audit input.

- `docs/adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md`
- `docs/adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md`
- `docs/adr/ADR-0122-portable-first-browser-install-suppression.md`
- `docs/design-system/update-experience.md`
- `docs/qa/governed-update-qa-matrix.md`
- `docs/qa/portable-product-delivery-v2-integrated-qa.md`
- `docs/qa/portable-updater-v2-qa-matrix.md`
- `docs/release/portable-launch-setup-guide.md`
- `docs/release/portable-production-signing-contract.md`
- `docs/release/portable-runtime-artifact-contract.md`
- `docs/release/release-impact-runbook.md`
- `docs/troubleshooting/macos-portable-first-launch.md`
- `docs/troubleshooting/portable-launch-setup.md`
- `docs/troubleshooting/windows-portable-first-launch.md`

### Design evidence

Owner: design-system QA; consumers: UI/review; disposition: retain as stale design evidence pending live-route coverage. These screenshots and JSON are the complete Issue #1696 evidence set; the E2E route rewrite is mocked below.

- `docs/design-system/evidence/1696/01-update-window-dark.png`
- `docs/design-system/evidence/1696/02-update-window-light.png`
- `docs/design-system/evidence/1696/03-update-window-dark-high-contrast.png`
- `docs/design-system/evidence/1696/04-update-window-light-high-contrast.png`
- `docs/design-system/evidence/1696/05-update-window-prefers-contrast.png`
- `docs/design-system/evidence/1696/06-update-window-forced-colors.png`
- `docs/design-system/evidence/1696/07-update-window-reduced-motion.png`
- `docs/design-system/evidence/1696/12-portable-managed-one-click.png`
- `docs/design-system/evidence/1696/update-experience-fidelity-proof.json`

### Native launcher/setup

Owner: native setup; consumers: portable activation and installers; disposition: retain implementation or native proof; provider qualification remains externally blocked.

- `native/portable-launcher/keiko-portable-launcher.c`
- `native/portable-launcher/keiko-portable-launcher.rc`
- `native/portable-launcher/keiko-portable-launcher.test.c`
- `native/portable-launcher/keiko-portable-launcher.windows.test.c`
- `native/portable-launcher/keiko.icns`
- `native/portable-launcher/keiko.ico`
- `native/portable-launcher/macos-entitlements.plist`
- `native/portable-launcher/macos-keychain-helper.c`
- `native/portable-launcher/macos-node-entitlements.plist`

### Contracts

Owner: contracts; consumers: server, CLI, and UI; disposition: retain public schema or proof.

- `packages/keiko-contracts/src/release-impact.ts`
- `packages/keiko-contracts/src/update-local-state.ts`
- `packages/keiko-contracts/src/update-preflight.ts`
- `packages/keiko-contracts/src/update-remediation.test.ts`
- `packages/keiko-contracts/src/update-remediation.ts`
- `packages/keiko-contracts/src/update-session.test.ts`
- `packages/keiko-contracts/src/update-session.ts`

### Server

Owner: server; consumers: BFF routes, session manager, CLI, and activation; disposition: retain or repair under #3405.

- `packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.test.ts`
- `packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.ts`
- `packages/keiko-server/src/coding-runtime/portableRuntimeLane.test.ts`
- `packages/keiko-server/src/coding-runtime/portableRuntimeLane.ts`
- `packages/keiko-server/src/update-install-mode.test.ts`
- `packages/keiko-server/src/update-install-mode.ts`
- `packages/keiko-server/src/update-integration.test.ts`
- `packages/keiko-server/src/update-local-state-hardlink-fallback.test.ts`
- `packages/keiko-server/src/update-local-state-repair.ts`
- `packages/keiko-server/src/update-local-state-scan.ts`
- `packages/keiko-server/src/update-local-state-snapshot.ts`
- `packages/keiko-server/src/update-local-state.test.ts`
- `packages/keiko-server/src/update-local-state.ts`
- `packages/keiko-server/src/update-portable-activation-files.ts`
- `packages/keiko-server/src/update-portable-activation.test.ts`
- `packages/keiko-server/src/update-portable-activation.ts`
- `packages/keiko-server/src/update-portable-install-mode.test.ts`
- `packages/keiko-server/src/update-portable-install-mode.ts`
- `packages/keiko-server/src/update-portable-platform-verification.test.ts`
- `packages/keiko-server/src/update-portable-platform-verification.ts`
- `packages/keiko-server/src/update-portable-sidecar-staging-verification.ts`
- `packages/keiko-server/src/update-portable-sidecar-verification.test.ts`
- `packages/keiko-server/src/update-portable-sidecar-verification.ts`
- `packages/keiko-server/src/update-portable-staging-archive-rename.test.ts`
- `packages/keiko-server/src/update-portable-staging-archive.ts`
- `packages/keiko-server/src/update-portable-staging-manifest.ts`
- `packages/keiko-server/src/update-portable-staging-shared.ts`
- `packages/keiko-server/src/update-portable-staging.test.ts`
- `packages/keiko-server/src/update-portable-staging.ts`
- `packages/keiko-server/src/update-preflight-catalog.test.ts`
- `packages/keiko-server/src/update-preflight-catalog.ts`
- `packages/keiko-server/src/update-preflight-impact.ts`
- `packages/keiko-server/src/update-preflight-portable-assets.ts`
- `packages/keiko-server/src/update-preflight-portable-evidence.ts`
- `packages/keiko-server/src/update-preflight-portable-shared.ts`
- `packages/keiko-server/src/update-preflight-registry.test.ts`
- `packages/keiko-server/src/update-preflight-registry.ts`
- `packages/keiko-server/src/update-preflight-report.ts`
- `packages/keiko-server/src/update-preflight-routes.ts`
- `packages/keiko-server/src/update-preflight.test.ts`
- `packages/keiko-server/src/update-preflight.ts`
- `packages/keiko-server/src/update-remediation-drafts.ts`
- `packages/keiko-server/src/update-remediation-routes.test.ts`
- `packages/keiko-server/src/update-remediation-routes.ts`
- `packages/keiko-server/src/update-remediation.test.ts`
- `packages/keiko-server/src/update-remediation.ts`
- `packages/keiko-server/src/update-session-lock-race.test.ts`
- `packages/keiko-server/src/update-session-lock-rename-sink.test.ts`
- `packages/keiko-server/src/update-session-lock.test.ts`
- `packages/keiko-server/src/update-session-lock.ts`
- `packages/keiko-server/src/update-session-routes.test.ts`
- `packages/keiko-server/src/update-session-routes.ts`
- `packages/keiko-server/src/update-session-support.ts`
- `packages/keiko-server/src/update-session.test.ts`
- `packages/keiko-server/src/update-session.ts`

### CLI

Owner: CLI; consumers: operators, launcher, and activation; disposition: retain implementation or proof.

- `packages/keiko-cli/src/launcher-paths.ts`
- `packages/keiko-cli/src/launcher-platforms.test.ts`
- `packages/keiko-cli/src/launcher-platforms.ts`
- `packages/keiko-cli/src/launcher-state-rename-backoff.test.ts`
- `packages/keiko-cli/src/launcher-state.test.ts`
- `packages/keiko-cli/src/launcher-state.ts`
- `packages/keiko-cli/src/launcher-toctou.test.ts`
- `packages/keiko-cli/src/launcher.test.ts`
- `packages/keiko-cli/src/launcher.ts`
- `packages/keiko-cli/src/portable-install.test.ts`
- `packages/keiko-cli/src/portable-install.ts`
- `packages/keiko-cli/src/portable-launch-notifier.test.ts`
- `packages/keiko-cli/src/portable-launch-notifier.ts`
- `packages/keiko-cli/src/portable-macos-activation.test.ts`
- `packages/keiko-cli/src/portable-macos-activation.ts`
- `packages/keiko-cli/src/portable-maintenance.test.ts`
- `packages/keiko-cli/src/portable-maintenance.ts`
- `packages/keiko-cli/src/portable-registration-rename-backoff.test.ts`
- `packages/keiko-cli/src/portable-registration.ts`
- `packages/keiko-cli/src/portable-root-policy.test.ts`
- `packages/keiko-cli/src/portable-root-policy.ts`
- `packages/keiko-cli/src/portable-shared.test.ts`
- `packages/keiko-cli/src/portable-shared.ts`
- `packages/keiko-cli/src/portable.test.ts`
- `packages/keiko-cli/src/portable.ts`
- `packages/keiko-cli/src/update-output.ts`
- `packages/keiko-cli/src/update.test.ts`
- `packages/keiko-cli/src/update.ts`

### UI

Owner: UI; consumers: desktop shell and Settings; disposition: retain presentation implementation and proof.

- `packages/keiko-ui/src/app/components/desktop/update/update-copy.ts`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.module.css`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.test.tsx`
- `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx`

### Release-script tests

Owner: release engineering; consumers: script/workflow verification; disposition: retain proof.

- `scripts/__tests__/macos-portable-inventory.test.mjs`
- `scripts/__tests__/macos-portable-signing.test.mjs`
- `scripts/__tests__/portable-evaluation-manifest.test.mjs`
- `scripts/__tests__/portable-launch-setup-smoke.test.mjs`
- `scripts/__tests__/portable-manual-review.test.mjs`
- `scripts/__tests__/portable-release-verification.test.mjs`
- `scripts/__tests__/portable-runtime-approvals.test.mjs`
- `scripts/__tests__/portable-runtime-release-docs.test.mjs`
- `scripts/__tests__/portable-runtime.test.mjs`
- `scripts/__tests__/portable-secure-read-smoke.test.mjs`
- `scripts/__tests__/portable-setup-companion.test.mjs`
- `scripts/__tests__/portable-setup-overlay.test.mjs`
- `scripts/__tests__/portable-zip-adapter.test.mjs`
- `scripts/__tests__/release-impact-governance.test.mjs`
- `scripts/__tests__/release-impact-notes.test.mjs`
- `scripts/__tests__/release-portable-assets-workflow.test.mjs`
- `scripts/__tests__/release-portable-prerelease.test.mjs`
- `scripts/__tests__/stage-portable-usearch.test.mjs`
- `scripts/__tests__/verify-portable-runtime-signing-args.test.mjs`
- `scripts/__tests__/windows-portable-setup.test.mjs`
- `scripts/__tests__/windows-portable-signing.test.mjs`

### Release scripts

Owner: release engineering; consumers: release automation and manual reviewers; disposition: retain production script.

- `scripts/assemble-portable-release-assets.mjs`
- `scripts/build-windows-portable-setup.mjs`
- `scripts/check-portable-runtime-approvals.mjs`
- `scripts/check-portable-runtime-manifest.mjs`
- `scripts/check-release-impact.mjs`
- `scripts/cleanup-macos-portable-signing.sh`
- `scripts/lib/portable-evaluation-manifest.mjs`
- `scripts/lib/portable-executable.mjs`
- `scripts/lib/portable-release-verification.mjs`
- `scripts/lib/portable-setup-companion.mjs`
- `scripts/lib/portable-setup-overlay.mjs`
- `scripts/macos-portable-inventory.mjs`
- `scripts/macos-portable-signing.mjs`
- `scripts/portable-launch-setup-smoke.mjs`
- `scripts/portable-launch-setup-stage.mjs`
- `scripts/portable-manual-review.mjs`
- `scripts/portable-runtime-approvals.mjs`
- `scripts/portable-runtime.mjs`
- `scripts/portable-secure-read-smoke.mjs`
- `scripts/portable-signed-archive.mjs`
- `scripts/portable-verification-input.mjs`
- `scripts/prepare-macos-portable-signing.sh`
- `scripts/release-impact-notes.mjs`
- `scripts/release-portable-prerelease.mjs`
- `scripts/resolve-release-portable-assets.mjs`
- `scripts/run-macos-portable-signing.sh`
- `scripts/run-portable-assets-stage.mjs`
- `scripts/smoke-portable-usearch.mjs`
- `scripts/stage-portable-runtime.mjs`
- `scripts/update-portable-runtime-approvals.mjs`
- `scripts/verify-fresh-macos-portable-artifact.sh`
- `scripts/verify-fresh-windows-portable-artifact.ps1`
- `scripts/verify-portable-runtime-signing.mjs`
- `scripts/verify-windows-portable-setup-signing.ps1`
- `scripts/verify-windows-portable-signing.ps1`
- `scripts/windows-portable-native-policy.ps1`
- `scripts/windows-portable-rfc3161.cs`
- `scripts/windows-portable-signing.mjs`
- `scripts/windows-portable-verification-input.mjs`

### End-to-end test configuration

Owner: QA; consumers: Playwright/UI review; disposition: rewrite the route-mocked update journey before claiming end-to-end coverage.

- `tests/e2e/config/playwright.issue-1696-update-ui.config.ts`
- `tests/e2e/update-ui-1696.spec.ts`

<!-- updater-surface:end -->

### Additional composition/export boundaries

These full paths do not match the discovery filename predicate and are intentionally outside its 194-path set and its marker.

Run this TypeScript-AST inventory command before changing a public export; it prints every selected
source module and every exported identifier (no family expansion or placeholder is used):

```sh
node --input-type=module <<'NODE'
import ts from 'typescript'; import { readFileSync } from 'node:fs';
for (const file of ['packages/keiko-contracts/src/index.ts','packages/keiko-server/src/index.ts']) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (!/^(\.\/release-impact|\.\/update-|\.\/local-knowledge-remediation|\.\/coding-runtime\/productionPortableCodingRuntime)/.test(module)) continue;
    const names = statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements.map((entry) => entry.name.text).join(', ') : '*';
    console.log(`${file} | ${module} | ${names}`);
  }
}
NODE
```

- `packages/keiko-contracts/src/index.ts` — the executable inventory above is the authoritative complete export list for release-impact, preflight, session, local-state, and remediation runtime/type declarations; contracts owns it and server, CLI, and UI consume it.
- `packages/keiko-contracts/package.json` — public subpaths: `./release-impact`, `./runtime/release-impact`, `./runtime/update-local-state`, `./runtime/update-preflight`, `./runtime/update-remediation`, `./runtime/update-session`.
- `packages/keiko-server/src/index.ts` — public updater exports: `createUpdateLocalStateManager`, `CreateUpdateSnapshotInput`, `UpdateLocalStateRepairResult`, `UpdateLocalStateManager`, `UpdateLocalStateManagerOptions`, `createUpdatePreflightService`, `runUpdatePreflight`, `UpdatePreflightService`, `createFileUpdateSessionLock`, `createStateDirUpdateSessionLock`, `updateSessionLockPath`, `FileUpdateSessionLockOptions`, `UpdateSessionLock`, `UpdateSessionLockRecord`, `createUpdateSessionManager`, `UpdateSessionError`, `UpdateSessionManager`, `UpdateSessionManagerOptions`, `UpdateSessionStartOutcome`, `createUpdateRemediationManager`, `UpdateRemediationError`, `UpdateRemediationManager`, `UpdateRemediationManagerOptions`, `detectUpdateInstallMode`, and `productionUpdateFacts` at `packages/keiko-server/src/index.ts:55-93,452`.
- `packages/keiko-server/src/index.ts` — also exports `portableInstallCarriesReleaseSignature`, `createLocalKnowledgeRemediationPort`, `CreateLocalKnowledgeRemediationPortOptions`, `LocalKnowledgeRemediationPort`, `LocalKnowledgeRemediationRunResult`, and `LocalKnowledgeRemediationScope`; their source/proof ownership is `packages/keiko-server/src/coding-runtime/productionPortableCodingRuntime.ts`, `packages/keiko-server/src/coding-runtime/productionPortableCodingRuntime.test.ts`, `packages/keiko-server/src/coding-runtime/productionPortableCodingRuntimePlatform.test.ts`, `packages/keiko-server/src/local-knowledge-remediation.ts`, `packages/keiko-server/src/local-knowledge-remediation.test.ts`, and `packages/keiko-cli/src/portable-macos-activation.ts`.
- `packages/keiko-server/src/deps.ts` — production composition: `buildUpdateSession`, `buildUpdateLocalState`, `buildUpdateRemediation`.
- `packages/keiko-server/src/routes.ts` — BFF subpaths: `/api/update/preflight`, `/api/update/preflight/check`, `/api/update/session`, `/api/update/session/retry`, `/api/update/session/verify-restart`, `/api/update/remediation`, `/api/update/remediation/status`, `/api/update/remediation/actions`.
- `packages/keiko-cli/src/index.ts` — public exports: `runUpdateCli`, `UpdateCliDeps`, `UpdateCliPreflight`, `runPortableCli`, `PortableSetupDeps`.
- `packages/keiko-cli/package.json` — package boundary; no updater-specific export subpath is declared.
- `packages/keiko-cli/src/runner.ts` — dispatches `update` to `runUpdateCli` and `portable` to `runPortableCommand`.
- `packages/keiko-ui/src/app/relationships/api.ts` — UI API module; no updater export is declared.
- `packages/keiko-ui/src/app/components/desktop/widgets/index.tsx` — registers the `updates` window and lazy-loads `UpdateWindow`.
- `packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx` — `UpdateWindow` component.
- `packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx` — `UpdateStartupNotice` component.

### Shared dependency and native build/proof register

The following non-keyword paths are outside the filename marker, but not outside the audit. The
relative-import scan below finds 41 direct shared dependencies at the audited baseline. Every one is
assigned here or in the composition register above. Workspace package exports, UI aliases, and native
build/test inputs are recorded separately because a relative-import scan cannot discover them.
These are shared authorities to reuse, not permission to fork their policies or rewrite unrelated
framework/domain internals. Their transitive implementation remains owned by the named subsystem;
#3405 must re-audit any shared authority it changes through its existing tests and gates.

| Shared paths                                                                                                                                                                                                                                                            | Owner / updater consumer                                                                                             | Disposition                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/keiko-server/src/coding-runtime/windowsPortableAuthenticode.ts`, `packages/keiko-server/src/coding-runtime/windowsPortableAuthenticode.test.ts`                                                                                                               | Security/native trust; imported by `update-portable-platform-verification.ts`                                        | Repair cross-release identity in this existing owner; retain strict same-release consistency and native timestamp/chain proof. |
| `packages/keiko-model-gateway/src/http.ts`, `packages/keiko-model-gateway/src/http.test.ts`, `packages/keiko-model-gateway/src/index.ts`, `packages/keiko-model-gateway/package.json`                                                                                   | Gateway egress/redirect and command ports; preflight/staging import `internal/http`, CLI/activation use root exports | Reuse the existing HTTP/command boundaries and their proofs; do not add a second redirect or host-execution policy.            |
| `packages/keiko-security/src/index.ts`, `packages/keiko-security/src/fs-atomic-rename.ts`, `packages/keiko-security/package.json`                                                                                                                                       | Security filesystem/host boundaries; CLI setup, staging, activation, lock/local state                                | Retain root and `fs-atomic-rename` export contracts; preserve bounded rename and protected path checks.                        |
| `packages/keiko-tools/src/index.ts`, `packages/keiko-tools/src/exec.ts`, `packages/keiko-tools/package.json`, `packages/keiko-workspace/src/index.ts`, `packages/keiko-workspace/src/fs.ts`, `packages/keiko-workspace/package.json`, `packages/keiko-sdk/src/index.ts` | Tool/workspace/SDK boundaries; session execution and integration                                                     | Retain governed command/workspace interfaces, including `internal/exec` and `internal/fs`; no updater-owned replacement.       |
| `packages/keiko-cli/src/install-layout.ts`, `packages/keiko-cli/src/state-paths.ts`, `packages/keiko-cli/src/lifecycle.ts`, `packages/keiko-cli/src/lazy-modules.ts`                                                                                                    | CLI layout, deletion-safe state roots, lifecycle and lazy composition; launcher/portable/update                      | Retain canonical paths/loaders; extend lifecycle only for the reviewed handoff.                                                |
| `packages/keiko-cli/src/security-log.ts`, `packages/keiko-cli/src/test-support/cli-io.ts`                                                                                                                                                                               | CLI evidence and test I/O; launcher/setup tests                                                                      | Retain existing log port and test harness; no second updater sink.                                                             |
| `packages/keiko-server/src/correlation.ts`, `packages/keiko-server/src/diagnostics-log.ts`, `packages/keiko-server/src/process-identity.ts`, `packages/keiko-server/src/publish-file-without-replacement.ts`                                                            | Server correlation, diagnostics, PID binding and atomic publication; session lock/local state/preflight              | Reuse these authorities for durable recovery and canonical evidence.                                                           |
| `packages/keiko-server/src/csp.ts`, `packages/keiko-server/src/runs.ts`, `packages/keiko-server/src/server.ts`, `packages/keiko-server/src/store/index.ts`, `packages/keiko-server/src/ui-test-server/_support.ts`                                                      | Server host and existing integration fixtures; update route tests                                                    | Retain security/host/test boundaries; real BFF composition is required in addition to fixtures.                                |
| `packages/keiko-server/src/coding-runtime/opencodeProtocolSurface.ts`, `packages/keiko-server/src/coding-runtime/opencodeToolSchemas.ts`                                                                                                                                | Coding-runtime protocol authority; portable sidecar verifier                                                         | Retain shared protocol/schema validation; no parallel sidecar updater.                                                         |
| `packages/keiko-server/src/coding-app-session/sessionPairingPort.ts`, `packages/keiko-contracts/src/coding-app-session.ts`                                                                                                                                              | Coding-app pairing contract; keyword-matched launcher pairing adapter                                                | Contextual shared dependency, not updater lifecycle ownership; preserve unchanged.                                             |
| `packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts`                                                                                                                                                                                              | Local Knowledge runtime manifest; portable staging/signing scripts and tests                                         | Retain the pinned payload authority; do not duplicate runtime metadata.                                                        |
| `packages/keiko-ui/src/lib/api.ts`, `packages/keiko-ui/src/lib/types.ts`, `packages/keiko-ui/src/lib/i18n.tsx`, `packages/keiko-ui/src/app/components/desktop/Icons.tsx`                                                                                                | UI API/types/i18n/icons; Update window and startup notice, including `@/lib/*` imports                               | Extend existing API/diagnostic/i18n projections; preserve design-system ownership.                                             |
| `scripts/lib/digest.mjs`, `scripts/lib/host-executable.mjs`, `scripts/lib/windows-msvc.mjs`, `scripts/lib/zip-archive.mjs`                                                                                                                                              | Release/toolchain/hash/archive authorities; portable assembly, signing and verification                              | Reuse validated primitives and compiler discovery; retain hostile-input tests.                                                 |
| `scripts/check-release-required-workflow-names.mjs`, `scripts/lib/release-owner-allowlist.mjs`, `scripts/release-tag-contract.mjs`                                                                                                                                      | Release workflow, owner and tag policy; portable release publication                                                 | Retain release authority; no updater-specific bypass.                                                                          |
| `scripts/runtime-activation-manifest.mjs`, `scripts/prepare-approved-sidecar-payloads.mjs`                                                                                                                                                                              | Runtime activation/approved payload authority; portable assembly and approval tests                                  | Retain immutable payload/activation bindings.                                                                                  |
| `scripts/isolated-macos-production-smoke.mjs`, `scripts/macos-runtime-qualification-transport.mjs`, `scripts/qualify-macos-runtime-release.mjs`, `scripts/qualify-windows-runtime-release.mjs`                                                                          | Native release qualification; portable signing tests and release lanes                                               | Retain actual platform proof; fixture imports are not native qualification.                                                    |
| `native/setup-bootstrap/keiko-setup-bootstrap.c`, `native/setup-bootstrap/keiko-setup-bootstrap.rc`, `native/setup-bootstrap/keiko-setup-bootstrap.windows.test.c`, `scripts/__tests__/windows-setup-bootstrap-smoke.mjs`                                               | Native setup source/resource/boundary and smoke harness; Windows portable build/smoke                                | Retain and run native setup proof alongside launcher changes; no new installer surface.                                        |
| `scripts/check-macos-native-quality.sh`, `scripts/check-windows-native-quality.ps1`, `scripts/__tests__/check-windows-native-quality.test.mjs`, `package.json`, `.github/workflows/ci.yml`                                                                              | Native compiler/analyzer/boundary gates and their script/CI wiring; portable launcher/setup delivery                 | Extend the existing gates for handoff code, keeping original checks and direct smoke reachability.                             |
| `tests/e2e/support/e2e-state-dir.ts`, `tests/e2e/support/evidence.ts`                                                                                                                                                                                                   | E2E state isolation/evidence; update UI config/spec                                                                  | Retain isolated state and evidence paths; add real outage proof through the existing lane.                                     |

The remaining relative dependencies (`runner.ts`, server `deps.ts`/`index.ts`/`routes.ts`, and
`local-knowledge-remediation.ts`) have exact ownership in the composition register above. Node
built-ins and npm test/UI/archive libraries remain governed by the existing lockfile and their
owning package boundary; they are not omitted updater-owned modules.

Reproduce the direct relative-import boundary inventory without relying on dependency filenames:

```sh
node --input-type=module <<'NODE'
import ts from 'typescript';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
const keyword = /(^|\/)([^/]*(update|portable|launcher|release-impact)[^/]*)/;
const files = execFileSync('rg', ['--files', 'packages', 'native', 'scripts', 'tests', '.github', 'docs'], { encoding: 'utf8' }).trim().split('\n');
const edges = new Map();
const isFile = (path) => { try { return statSync(path).isFile(); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; } };
for (const file of files.filter((path) => keyword.test(path) && /\.[cm]?[jt]sx?$/.test(path))) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const specifier of imports.filter((entry) => entry.startsWith('.'))) {
    const base = resolve(dirname(file), specifier);
    const found = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base + '.ts', base + '.tsx', base + '/index.ts'].find(isFile);
    if (!found) throw new Error(`Unresolved relative import: ${file} -> ${specifier}`);
    const target = relative(process.cwd(), found);
    if (keyword.test(target)) continue;
    const consumers = edges.get(target) ?? new Set();
    consumers.add(file); edges.set(target, consumers);
  }
}
for (const [target, consumers] of [...edges].sort(([left], [right]) => left.localeCompare(right))) console.log(`${target} <- ${[...consumers].sort().join(', ')}`);
console.log(`Shared relative-import boundaries: ${edges.size}`);
NODE
```
