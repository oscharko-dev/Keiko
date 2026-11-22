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

1. The run ended `succeeded`.
2. The tester's own `npm test` in the folder the run worked in exits 0.
3. Every file under `test/` is byte-identical to the copy the run started from.
4. The Activity Log of the run contains these lines:
   - `runtime.confinement.spawned` with the platform's boundary (`seatbelt` on macOS).
   - The last `coding-runtime.verification-summarized` with `verifierId` `test` and status
     `passed`.
   - `coding-runtime.run.settled` with state `succeeded`.

A fix that leaves the tests red must not end `succeeded`.

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
4. runs `npm test` again.

Its replacement comes from `variants/`.

Run it on macOS:

```bash
npm run dev:coding-runtime:stage
```

```bash
KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1 KEIKO_OS_KEYCHAIN=off KEIKO_ACCEPTANCE_EVIDENCE_FILE="$HOME/keiko-acceptance/evidence.json" npx vitest run packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts
```

`KEIKO_ACCEPTANCE_EVIDENCE_FILE` keeps body-free evidence for each case, outside the checkout. It
records:

- the platform, architecture and Node.js and OpenCode versions;
- whether the account is in the `admin` group;
- whether `docker` or `podman` is on `PATH`;
- the case's outcome as closed values and counts.

It records no path and no content.

**Real model, by hand.** Only this form closes an acceptance criterion. A person runs the same task
on the same project in the Coding Workbench with a real model. They use a clean state and a standard
user account, and start from the project folder or from a managed task worktree. The tester then
checks the same four points. A real model writes its own fix, so `variants/` plays no part.

## Baseline on macOS, 2026-11-22

Scripted form at `b26eab6e0` plus this change. The machine was an Apple silicon Mac:

- macOS (Darwin 27.0.0), Node.js 26.13.1, OpenCode 2.2.5;
- the account is an administrator;
- `docker` is on `PATH`, `podman` is not.

All six cases passed in 36 s.

| Project           | Mode             | Folder           | Fix   | Dependencies | Outcome                                                    |
| ----------------- | ---------------- | ---------------- | ----- | ------------ | ---------------------------------------------------------- |
| `no-dependencies` | Supervised       | managed worktree | right | not needed   | `succeeded`, tests `failed` then `passed`                  |
| `no-dependencies` | Full access      | managed worktree | right | not needed   | `succeeded`, tests `failed` then `passed`                  |
| `no-dependencies` | Ask for approval | managed worktree | right | not needed   | `succeeded` after 3 approvals                              |
| `no-dependencies` | Supervised       | managed worktree | wrong | not needed   | `failed` (`verification-not-evidenced`), tester's test red |
| `with-dependency` | Supervised       | own folder       | right | installed    | `succeeded`                                                |
| `with-dependency` | Supervised       | managed worktree | right | missing      | `failed` (`verification-not-evidenced`), tester's test red |

In every case:

- the boundary was `seatbelt`;
- the files under `test/` were unchanged;
- the run's edit had landed.

`verification-not-evidenced` is the closed failure code for "no passing check after the final edit".
It covers a check that ran and failed, as here.

## What this baseline does not prove yet

These points stay open:

- **No container runtime installed.** The machine had `docker` on `PATH`. The case without one, and
  the case with Docker installed but not running, belong to
  [#4519](https://github.com/oscharko-dev/Keiko/issues/4519).
- **Standard user.** The account was an administrator. The standard-user run belongs to #4519 and,
  for the delivery forms, [#4520](https://github.com/oscharko-dev/Keiko/issues/4520).
- **Dependencies in a managed worktree.** The last row is the expected baseline. A managed task
  worktree is a fresh checkout without `node_modules`, and below Full access the run's shell has no
  registry. [#4522](https://github.com/oscharko-dev/Keiko/issues/4522) installs dependencies under
  governance and turns that row into a success.
- **CI.** No workflow runs this test yet. That belongs to
  [#4521](https://github.com/oscharko-dev/Keiko/issues/4521).
- **Real model.** The scripted form closes no criterion. The real-model run on macOS is still to do.
- **Windows.** The Windows half of #4492 runs after the macOS gate. See the
  [Windows qualification](opencode-windows-qualification.md).
