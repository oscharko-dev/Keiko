# Coding Workbench acceptance task

Issue [#4492](https://github.com/oscharko-dev/Keiko/issues/4492), parent epic
[#4491](https://github.com/oscharko-dev/Keiko/issues/4491). This document describes the instrument
the epic uses to check its promise on every platform. It runs one fixed task and checks the end
state outside Keiko, so what the run says about itself does not count.

## The task

A project's tests fail. The run is told:

> The tests in this project fail. Find the cause in src/, fix it there and run npm test until it
> passes. Do not change the tests.

The projects are under
[`tests/fixtures/coding-acceptance/`](../../tests/fixtures/coding-acceptance/README.md):

- `no-dependencies` needs only Node.js.
- `with-dependency` needs the `semver` package installed.

## What counts as passed

Before the run, the project's `npm test` must fail. After the run, the tester checks four things
outside Keiko:

1. The run ended `succeeded`: in the run's snapshot and in its `coding-runtime.run.settled` line.
2. The tester's own `npm test` in the folder the run worked in exits 0. A check that cannot run
   at all (no `npm`, a timeout) is an error of the procedure, never a red or a green result.
3. Every file under `test/` is byte-identical to the copy the run started from.
4. The Activity Log lines of the run (correlation: the run's id) say:
   - `runtime.confinement.spawned`: the run's runtime process started inside the platform's
     boundary. On macOS that is backend `seatbelt`, profile `keiko-native` and workspace access
     `read-write`. The network rule follows the mode: `loopback-only` below Full access,
     `inherited` at Full access.
   - The last `coding-runtime.verification-summarized` has `verifierId` `test` and status `passed`,
     and it came after the final edit.
   - `coding-runtime.run.settled` has state `succeeded`.

## What never counts as passed

These cases must end `failed` with the closed failure code `verification-not-evidenced`, which
means "no passing check after the final edit":

- **Failed:** the edit is wrong and the run's check stays red.
- **Skipped:** the run never reruns the check after its edit.
- **Stale:** the check passed, then the run edited again and did not rerun it.
- **Denied:** the person denies the check in Ask for approval. The run also records the blocked
  reason `verification-command-denied`.

In the skipped, stale and denied cases the fix is right, so the tester's own `npm test` passes.
Keiko must still not report success: the outcome follows what the run verified, not the file's
true state.

## Two ways to run it

**Scripted model, automatic.** This form checks Keiko's part of the job. It does not check any
model's skill.

The test is
[`productionOpenCodeBackend.acceptance.test.ts`](../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts).
It uses production composition only, the staged dev-lane runtime and the real Seatbelt boundary.
Only the model is scripted. The scripted model:

1. runs `npm test`,
2. reads the target file,
3. replaces it through the runtime's own `edit`,
4. runs `npm test` again, unless the case skips that check or makes it stale.

Its replacement comes from `variants/`. For the denied case the test denies every ask that comes
after the edit landed, the way a person would press Deny.

Run it on macOS:

```bash
npm run dev:coding-runtime:stage
```

```bash
KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1 KEIKO_OS_KEYCHAIN=off KEIKO_ACCEPTANCE_EVIDENCE_FILE="$HOME/keiko-acceptance/evidence.json" npx vitest run packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts
```

`KEIKO_ACCEPTANCE_EVIDENCE_FILE` keeps body-free evidence, owner-private and outside the checkout.
It records:

- the platform, architecture and Node.js and OpenCode versions;
- whether the account is in the `admin` group;
- whether `docker` or `podman` is on `PATH` and whether a Docker socket exists;
- `certifiesPromise` and the unmet preconditions: the evidence certifies the promise only for a
  standard user on a machine without a container runtime;
- each case's outcome as closed values and counts, or `harnessError` when a case did not complete.

It records no path, no task text, no model answer and no other content.

The scripted form has limits:

- The scripted model edits only the target file. The test-file check and the edit check guard the
  product, not a model. The real-model run is what tests a model that is tempted to change a test.
- The confinement line describes the runtime process. Its shell commands are child processes and
  inherit Seatbelt from it. Proving each boundary statement from the model's own shell belongs to
  [#4521](https://github.com/oscharko-dev/Keiko/issues/4521).
- It runs the runtime staged from this checkout, not an installed delivery form.

**Real model, by hand.** Only this form closes an acceptance criterion. A person runs the same task
in the Coding Workbench with a real model; the lab procedure is below. A real model writes its own
fix, so `variants/` plays no part.

## Coverage by mode and delivery form

|                                                 | Ask for approval | Supervised workspace | Full access |
| ----------------------------------------------- | ---------------- | -------------------- | ----------- |
| This checkout, scripted model                   | automated        | automated            | automated   |
| npm form (`npm install -g @oscharko-dev/keiko`) | lab              | lab                  | lab         |
| npm folder package                              | lab              | lab                  | lab         |
| Standalone folder package                       | lab              | lab                  | lab         |

The automated form covers all four never-a-pass cases. The three delivery forms are lab-only for
now:

- They are installed release artifacts, and the promise is about what a standard user without
  administrator rights can do with one.
- That needs a real standard account on a real machine.
- [#4520](https://github.com/oscharko-dev/Keiko/issues/4520) adds an automated start check for each
  form. The task itself stays a lab run with a real model.

## Lab procedure: real model, one delivery form

Do this once for each delivery form and mode you qualify.

**Prerequisites**

- A standard user account (not in the `admin` group on macOS).
- No Docker or Podman installed.
- A Keiko state directory that has never been used.
- A gateway with a model that calls tools.

**Run**

1. Install or unpack the delivery form as that user. Keiko's own documents describe each form.
2. Copy `tests/fixtures/coding-acceptance/no-dependencies` (or `with-dependency`, with
   `npm install` run in the copy) to a folder in the user's home directory. Commit it:

   ```bash
   git init -q -b main && git add . && git commit -q -m "acceptance fixture"
   ```

3. Start Keiko. Activate the model in Settings > Models.
4. Open the Coding Workbench, pick the folder, choose the mode, enter the task text above and
   press Start. In Ask for approval, approve each ask.
5. When the run has settled, run `npm test` in the folder yourself. Run `git diff --stat -- test`;
   it must print nothing.
6. Find the run in the Activity Log:

   ```bash
   keiko support query --op coding-runtime.run.settled --json
   ```

7. Export that run's report and check its timeline:

   ```bash
   keiko support export --correlation-id <run id>
   ```

   ```bash
   keiko support analyze <report file> --json
   ```

   The timeline must show the lines of "What counts as passed".

**Record, body-free:**

- the delivery form, mode and folder kind;
- the user class and whether a container runtime is present;
- the Keiko, Node.js and OpenCode versions;
- the run's state and failure code;
- the tester's `npm test` exit code;
- whether the test files are unchanged;
- whether the four Activity Log lines are present.

Never record the task text, a path or the model's answers.

To check the never-a-pass rule in the lab, deny the check after the edit in Ask for approval. The
run must end `failed`.

## Mapping to the Windows qualification (#4068)

These cases measure two Windows acceptance groups of
[#4068](https://github.com/oscharko-dev/Keiko/issues/4068), whose Windows run follows the macOS
gate:

| #4068 group | What it asks                                                                                                            | Cases here                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| W6          | the small task set (read-only analysis, focused fix, edit/test/repair) in all three modes                               | the right fix in all three modes; read-only analysis is not part of this task     |
| W8          | a real failing-test, repair, green loop in all three modes; denied, skipped, stale or failed checks never become a pass | the right fix in all three modes, and the failed, skipped, stale and denied cases |

W8's Windows shell paths (cmd, PowerShell, `npm.cmd`) belong to the Windows half of #4492.

## Baseline on macOS, 2026-11-22

Scripted form on branch `feat/4491-macos-promise`. The machine was an Apple silicon Mac:

- macOS (Darwin 27.0.0), Node.js 26.13.1, OpenCode 2.2.5;
- the account is an administrator;
- `docker` is on `PATH` (no socket present), `podman` is not.

The evidence therefore says `certifiesPromise: false`, with unmet preconditions `administrator` and
`container-runtime-present`. All nine cases passed in 49 s.

| Project           | Mode             | Folder           | Fix   | Check after the edit | Outcome                                                       |
| ----------------- | ---------------- | ---------------- | ----- | -------------------- | ------------------------------------------------------------- |
| `no-dependencies` | Supervised       | managed worktree | right | rerun                | `succeeded`; checks `failed`, `passed`                        |
| `no-dependencies` | Full access      | managed worktree | right | rerun                | `succeeded`; checks `failed`, `passed`                        |
| `no-dependencies` | Ask for approval | managed worktree | right | rerun                | `succeeded` after 3 approvals                                 |
| `no-dependencies` | Supervised       | managed worktree | wrong | rerun                | `failed`; checks `failed`, `failed`; tester's test red        |
| `no-dependencies` | Supervised       | managed worktree | right | skipped              | `failed`; check `failed`; tester's test green                 |
| `no-dependencies` | Full access      | managed worktree | right | stale                | `failed`; checks `failed`, `passed`, then an edit             |
| `no-dependencies` | Ask for approval | managed worktree | right | denied               | `failed`, `verification-command-denied`; 2 approved, 1 denied |
| `with-dependency` | Supervised       | own folder       | right | rerun (installed)    | `succeeded`                                                   |
| `with-dependency` | Supervised       | managed worktree | right | rerun (missing)      | `failed`; checks `failed`, `failed`; tester's test red        |

Every `failed` row carries `verification-not-evidenced`. In every case:

- the runtime started under `seatbelt`, profile `keiko-native`, workspace `read-write`;
- the network rule was `loopback-only`, or `inherited` in the Full access rows;
- the files under `test/` were unchanged;
- the run's edit had landed.

## What this baseline does not prove yet

These points stay open:

- **No container runtime installed.** The machine had `docker` on `PATH`. The case without one, and
  the case with Docker installed but not running, belong to
  [#4519](https://github.com/oscharko-dev/Keiko/issues/4519).
- **Standard user.** The account was an administrator. The standard-user run belongs to #4519 and,
  for the delivery forms, to #4520.
- **Dependencies in a managed worktree.** The last row is the expected baseline. A managed task
  worktree is a fresh checkout without `node_modules`, and below Full access the run's shell has no
  registry. [#4522](https://github.com/oscharko-dev/Keiko/issues/4522) installs dependencies under
  governance and turns that row into a success.
- **CI.** No workflow runs this test yet. That belongs to #4521.
- **Real model.** The scripted form closes no criterion. The real-model run on macOS is still to do.
- **Windows.** The Windows half of #4492 runs after the macOS gate. See the
  [Windows qualification](opencode-windows-qualification.md).
