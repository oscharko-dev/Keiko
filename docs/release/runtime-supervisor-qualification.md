# Coding Workbench runtime qualification and operator runbook

This runbook is the operator-facing release gate for issue #2258. It describes the supported
portable targets, managed OpenCode trust path, runtime recovery and rollback, evidence an auditor
must inspect, and claims that remain blocked. It extends the portable delivery authority in
ADR-0121, Coding Workbench authority model in ADR-0124 and ADR-0125, governed update model in
ADR-0099, and content-free evidence rules in ADR-0048. It does not create another process, model,
Git, update, or evidence authority.

Long-lived Coding Workbench runtimes are available only when the installed portable bytes match a
current `runtime-tree-qualification-v1` receipt. The receipt is content-free and binds the exact
platform target, source commit, portable artifact SHA-256, signed supervisor-helper SHA-256, sorted
sidecar payload digests, backend, suite version, and result. Unknown fields, failed results, private
paths, secret-like values, stale digests, or a backend/target mismatch fail closed.

## Current platform status

| Target      | Backend                              | Status      |
| ----------- | ------------------------------------ | ----------- |
| Windows x64 | Windows Job Object                   | Qualifiable |
| macOS arm64 | App Sandbox plus descendant observer | Unavailable |
| macOS x64   | App Sandbox plus descendant observer | Unavailable |

Linux and Windows arm64 are outside the ADR-0121 portable target set and issue #2258. A later
decision must define their native packaging, process-containment, update, and receipt requirements
before either platform can be enabled.

The Windows helper creates the runtime suspended, assigns it to a Job Object before resume, enables
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and accepts a reap proof only after the Job Object completion
notification and an independent `ActiveProcesses == 0` query agree. Microsoft documents that Job
Objects manage associated processes as a unit, that child processes join the job by default, and
that kill-on-close terminates all associated processes. See
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and
[JOBOBJECT_BASIC_ACCOUNTING_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information).

The release workflow publishes the Windows receipt as the fixed
`windows-x64-runtime-supervisor-qualification.json` asset and attests it alongside the portable
archive. Update staging fetches that asset from the same repository and release tag, verifies it
against the release commit, archive digest, extracted signed helper, and staged sidecars, and only
then persists it as `.portable/runtime-supervisor-qualification.json` in the atomically promoted
install. Initial or manually copied installs without that receipt remain unavailable. Activation
and rollback revalidate the receipt against the candidate bytes before promotion.

## Deployment prerequisites

An operator may enable a managed Coding Workbench runtime only when all of the following are true:

1. Keiko is installed from one reviewed `portable-managed` release asset for the current target.
2. The archive, bundled Node runtime, Keiko packages, supervisor helper, and sidecar payloads match
   the release metadata and signatures required by ADR-0121.
3. `.portable/runtime-supervisor-qualification.json` validates against the exact installed bytes. A
   copied, stale, mismatched, or failed receipt keeps runtime launch unavailable.
4. Deployment policy enables the requested runtime source, model source, and autonomy ceiling.
5. The selected repository has a Keiko-managed task workspace and current branch/head binding.
6. Outbound model traffic is configured through Keiko's Model Gateway. Corporate proxy and custom
   CA settings use the shared ADR-0038 egress boundary.
7. Commit, push, and pull-request actions use the existing governed Git delivery routes and a new,
   action-bound, expiring, one-use human approval. A runtime approval is never a Git approval.

The managed OpenCode path uses the SHA-verified sidecar staged inside the portable release. It does
not inspect or invoke a global OpenCode installation, run an upstream installer, self-update the
sidecar, or project provider credentials into OpenCode. Productive model requests are translated
through the Keiko-owned runtime port and Model Gateway. The browser owns no filesystem, shell, Git,
connector, provider, or process authority.

The Codex path is separate from OpenCode and API-key Model Gateway access. A release may claim
credentialed Codex support only after an explicitly approved maintainer-owned subscription and
approved redistributable runtime artifact pass release-host attestation using isolated Keiko state.
No such credentials or artifact were provided for issue #2258; this claim remains blocked and fails
closed.

## Authority and data boundaries

- The server mints and validates the Authority Envelope. Browser input cannot supply or elevate the
  effective mode, workspace, branch, action classes, connector scopes, runtime source, model source,
  or cumulative tool and patch budgets.
- The effective mode is the fail-closed minimum of requested mode and all deployment, role,
  repository, connector, model, and envelope ceilings. The display names **Ask for approval**,
  **Approve for me**, and **Full access** retain the ADR-0125 machine values.
- Read, edit, and verification requests are admitted at the existing governed producer boundaries.
  Workspace/head drift, replay, stale capabilities, exhausted budgets, schema mismatch, and
  out-of-scope targets deny before mutation.
- Evidence is content-free. It may retain bounded identifiers, digests, counts, state transitions,
  result codes, and artifact hashes. It must not retain prompts, answers, raw model output, raw
  diffs, repository content, commands or command output, credentials, private URLs, customer paths,
  approval claims, or subscription identity.
- The issue #2258 browser pack uses a synthetic repository and fixed identifiers. Its six PNG files
  were reviewed before retention and are hash-bound by
  `docs/design-system/evidence/2258/live-qualification-manifest.json`.

## Operating procedure

### Start and interact

1. Confirm the task workspace is healthy and the requested source and mode are available.
2. Start the run from Coding Workbench. Keiko binds the run to the current task, workspace, project,
   branch head, runtime payload, model profile, policy, and supervisor tree.
3. Treat runtime questions as untrusted plain text. Answer or reject them only through active-run
   BFF controls; stale, replayed, terminal-run, or cross-run responses are rejected.
4. Inspect the content-free timeline and terminal outcome. A retained `succeeded`, `failed`,
   `cancelled`, or `taken-over` card describes only the current run and can be dismissed.
5. Use the separate governed Git surfaces for commit, push, and pull-request create/update. Every
   retry requires a newly issued action-bound approval; replay is denied.

### Stop, takeover, and recovery

- Stop and takeover are serialized with runtime work. Keiko revokes authority before requesting
  tree termination and does not report completion until the supervisor's zero-descendant proof is
  accepted.
- On restart, a durable recovery handle may identify only the supervised process tree. Recovery
  reconciles and reaps that exact tree before clearing the run. A malformed, unqualified, or
  inconclusive receipt remains `recovery-required`.
- A user must acknowledge a successfully reaped recovery before retrying. The retry creates fresh
  run authority; late cleanup for an older run cannot clear or mutate the newer run.
- If the runtime, BFF, or browser becomes temporarily unavailable, the Workbench exposes an offline
  state and explicit refresh. It does not synthesize an answer, completion, or recovery.

### Update while a run is active

Portable update activation is quiescence-gated. Staging may verify a candidate, but activation must
not replace executable or sidecar bytes while a Coding Workbench runtime or recovery is active.
After the run is reaped, activation revalidates the candidate archive, helper, sidecars, target, and
qualification receipt before atomic promotion. A mismatch leaves the current install active and
records a content-free failure. There is no silent background update or downgrade path.

### Rollback and incident response

1. Stop or take over the active run. If Keiko reports `recovery-required`, complete recovery before
   changing installed bytes.
2. Preserve only the content-free evidence manifest, qualification receipt, release metadata,
   version and digest inventory, and coded failure outcomes required for review. Do not collect raw
   prompts, model output, repository content, environment variables, or command logs.
3. Disable the affected runtime source or lower the deployment ceiling until the incident is
   settled.
4. Restore only an operator-approved portable candidate whose archive, native helper, sidecars,
   signatures, target, and qualification receipt all validate together. Unsupported manual copies
   remain unavailable.
5. Re-run the platform qualification and live managed-runtime gates before re-enabling the runtime.
   Record the exact commit, artifact hashes, commands, result counts, and reviewer.

## macOS blocker

Apple App Sandbox is a supported kernel-enforced confinement primitive, and Apple documents sandbox
inheritance for an embedded signed command-line helper. It does not provide the independent,
race-free descendant fork/exec/exit observation required by ADR-0131 D5. See
[Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
and
[Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app).

Apple's supported event surface that observes process forks and executions is Endpoint Security. It
requires all of the following external architecture and program prerequisites:

1. An Endpoint Security client packaged as a System Extension in the signed Keiko application.
2. The Apple-granted `com.apple.developer.endpoint-security.client` entitlement. Apple states that
   `es_new_client` fails when this entitlement is absent.
3. User or enterprise approval and activation of that System Extension.
4. A signed helper/XPC boundary that binds App Sandbox confinement identity to Endpoint Security
   fork, exec, and exit observations, plus native arm64 and x64 qualification receipts.

See [Endpoint Security](https://developer.apple.com/documentation/endpointsecurity) and the
[Endpoint Security client entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client).

The current standalone portable architecture has none of these prerequisites. `sandbox-exec`,
process groups, parent-only waits, `kqueue` watches of already-known PIDs, and polling parent-PID
relationships do not close fork/reparent observation races and cannot substitute for the required
extension. Both macOS targets intentionally stage no runtime-supervisor helper, produce no passing
receipt, and remain unavailable.

## Shutdown semantics

The current Windows helper maps both supervisor shutdown requests to Job Object termination. A
portable GUI process cannot assume that a shared Windows console exists, so a nominally graceful
request cannot safely be represented as `CTRL_BREAK_EVENT`. The control protocol preserves the two
request kinds, but Keiko does not claim cooperative shutdown until that behavior has its own native
qualification. In both cases completion is reported only after the independent zero-active proof.

## Recovery receipt

Only a 32-character lowercase hexadecimal recovery handle is durable. On Windows it names the Job
Object; it contains no path, process ID, credential, environment value, or runtime content. Startup
reconciliation invokes the same fixed helper without a shell. The helper opens the named Job Object,
terminates remaining members, and waits for `ActiveProcesses == 0`. If the object is absent, the
persisted handle is considered reaped because a kill-on-close named Job Object is destroyed only
after its associated processes terminate. Malformed handles and inconclusive queries remain
`recovery-required`.

## Release qualification and audit procedure

Run commands with the repository's supported Node 24 toolchain. The live command uses a synthetic
managed repository, SHA-verified approved OpenCode artifact, actual built UI and BFF, and production
runtime resolver. It is stronger than preview or component-fixture rendering, but it is not
customer-environment, credentialed Codex, or native macOS containment evidence.

```bash
npm run test:functional:opencode-2258
npm run test:e2e:coding-workbench-2258
npm run smoke:portable-launch-setup
npm run check:security-regression-matrix
npm run check:shell-spawn-guardrails
npm run check:ui-i18n
npm run typecheck
npm run lint
npm run format:check
npm run arch:check
```

For a manual browser handoff, run `npm run launch:functional:opencode-2258` and wait for
`KEIKO_2258_READY http://127.0.0.1:32458`. Do not treat the readiness line alone as qualification;
execute the journeys in
`docs/design-system/evidence/2258/live-qualification-matrix.md` and confirm retained artifact hashes
against `live-qualification-manifest.json`.

An auditor must also inspect the target-specific portable workflow result. Windows x64 may produce a
passing native receipt only when the helper is built, signed, packaged, and exercised on Windows.
The two macOS targets must remain unavailable until the Endpoint Security prerequisites and native
receipts described above exist. CI or browser emulation cannot convert that blocker into a pass.

## Acceptance crosswalk

| Issue #2258 acceptance area                                                              | Evidence and verification                                                                                           | Release disposition                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Managed OpenCode starts without a global install, edits a contained file, and verifies   | `npm run test:functional:opencode-2258`; live positive journey in the #2258 matrix                                  | Passed for the managed OpenCode protocol and browser/BFF path                              |
| Credentialed Codex uses isolated Keiko state without credential crossover                | Dedicated release-host attestation with approved subscription and artifact                                          | **Blocked; no approved credential or artifact supplied**                                   |
| Task workspace through branch, edit, verification, commit, push, and PR                  | Live browser/BFF edit plus one-use commit/replay proof; Git delivery integration suites cover synthetic push and PR | Passed as split real-browser and governed-integration evidence; no customer remote used    |
| Three autonomy modes and delivery boundary                                               | Live keyboard/mode journey plus runtime authority and Git approval suites                                           | Passed; requested elevation remains server-capped and delivery remains separately approved |
| Adversarial runtime, origin, replay, drift, recovery, update, event, and reconnect cases | Functional runtime suite, live matrix, `check:security-regression-matrix`, and `check:shell-spawn-guardrails`       | Passed where exercised; exact scenario list is pinned in the matrix and manifest           |
| Windows x64, macOS arm64, and macOS x64 portable containment                             | Target workflow plus `runtime-tree-qualification-v1` receipt                                                        | Windows qualifiable; **both macOS targets blocked and fail closed**                        |
| Responsive, theme, keyboard, accessibility, offline, recovery, and terminal UX           | Live E2E; `a11y-proof.json`; `coding-workbench-live-fidelity-proof.json`; six retained PNGs                         | 15 live scenarios passed; 2 external-attestation scenarios remain fixme                    |
| Real-runtime gate cannot be replaced by preview fixtures                                 | Production resolver and harness separation tests plus live manifest                                                 | Passed; component and hermetic tests are supporting evidence only                          |
| Known limitations, prerequisites, boundaries, recovery, rollback, and audit procedure    | This runbook and the #2258 evidence pack                                                                            | Documented; blocked claims remain explicit                                                 |

## Release decision

Issue #2258 may establish that the managed OpenCode browser, BFF, and runtime workflow is
functionally and visually qualified on the tested host and that Windows x64 has a native
qualification design and workflow. It must not advertise the overall epic as
portable-production-complete while credentialed Codex attestation or native macOS containment is
absent. Both blockers are deliberate fail-closed outcomes required by the issue acceptance criteria
and ADRs; neither may be waived by a fixture, preview, browser click-through, or unsigned or manual
artifact.
