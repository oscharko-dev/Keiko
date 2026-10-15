# Coding Workbench live lab: drivers

Tooling for the live qualification of the Coding Workbench with a self-hosted model behind LiteLLM
(epic #3871, issue #3872). The end-to-end reproduction (model server, LiteLLM, task suite, fixture
repository) is in [`docs/qa/coding-workbench-lab/README.md`](../../../docs/qa/coding-workbench-lab/README.md);
this page is the command reference. The Workbench drivers read the launcher secret from the
environment; none prints it, and run summaries are body-free. The separate
[connected-chat qualification](../../../docs/qa/connected-chat-local-model-qualification.md)
driver additionally reads owner-only runtime metadata and its launcher-secret file outside the
checkout. It uses the same pairing API, requires a held source SHA and explicit folder scope,
and starts no Workbench task. Its preparation mode makes no model request.

## Prerequisites

- A Keiko checkout with `npm install` done and the packages built (`npm run build:packages`, which
  `npm run dev:start` also does): the scripts import the built `packages/*/dist`. Node as the root
  `package.json` `engines` require.
- A Chromium build for the UI driver: `npx playwright install chromium`.
- LiteLLM, the model server and Keiko's Gateway Setup, as described in the lab README.
- The lab repository: a copy of `tests/fixtures/coding-workbench-lab/ledger-lab/` with a Git history on branch `main`.

## Fail closed

The run drivers act as the local operator, so they refuse to guess. These are errors (exit code 2),
not defaults:

- **No approval policy, no run.** `wb-ui.mjs`, `wb-run.mjs` and `chaos-suite.mjs` require
  `--approve all|none|ask`. `all` approves every permission ask once (`wb-ui.mjs` also applies the
  change reviews of Ask for approval and allows package scripts), `none` denies every ask
  (`wb-ui.mjs` also rejects the change reviews), `ask` answers nothing and leaves all of it to a
  person. Every run prints `driver <name>: approvals <policy>` before its last line.
- **No repository, no run.** `--repo` or `KEIKO_LAB_REPO` is required; the drivers never run in
  whichever workspace the dev server has open. The checkout must be a copy of the fixture (its
  `package.json` names `ledger-lab`), and a run does not start unless the dev server accepted it
  as its workspace. `wb-trust.mjs` and `verify-latency.mjs` apply the same rule. The drivers (and
  `wb-trust.mjs`) register the copy as a project first, since the server selects registered
  repositories only: `POST /api/projects` with its canonical real path and no `selectionIntent`
  (an explicit folder selection would also grant package-script trust), repeated without harm on
  every run. A refusal prints the server's own code and message, for example `MISSING_REPOSITORY`,
  `LOCK_CONTENTION` or `INVALID_BASE_BRANCH`.
- **No implicit trust.** `wb-trust.mjs` takes `grant` or `revoke`; neither is a default.

## Environment

| Variable                                   | Meaning                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET` | Required by `pair` and every `wb-*` script: the secret the dev server was started with (at least 32 characters). Read from the environment only |
| `KEIKO_LAB_REPO`                           | The lab repository checkout; the default of `--repo`, and one of the two is required                                                            |
| `KEIKO_LAB_BASE_URL`                       | The dev server origin; loopback `http` only, default `http://127.0.0.1:1983`                                                                    |
| `KEIKO_LAB_LOG_DIR`                        | Activity Log directory for `run-summary`, `turn-profile` and `rawtl`; default `$KEIKO_STATE_DIR/logs`, else `./.keiko/dev/logs`                 |
| `KEIKO_CONFIG_FILE`                        | The gateway configuration the dev server reads; set it when starting the server                                                                 |

## Command sequence

Run these from the root of the Keiko checkout.

**1. Launcher secret and dev server.** One secret for the server and the drivers, kept outside the
checkout in a file only you can read. `KEIKO_CONFIG_FILE` is optional: leave it unset on a first start
(the server uses `.keiko/dev/ui/keiko.config.json`, which Gateway Setup creates), or point it at an
existing gateway configuration whose `credentials/` directory sits beside it.

```bash
mkdir -p ~/.keiko-lab && chmod 700 ~/.keiko-lab
[ -s ~/.keiko-lab/launcher-secret ] || (umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > ~/.keiko-lab/launcher-secret)
export KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET="$(cat ~/.keiko-lab/launcher-secret)"
export KEIKO_CONFIG_FILE="$HOME/.keiko-lab/keiko.config.json"    # optional, see above
npm run dev:start -- --no-open
curl -s "http://127.0.0.1:1983/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"
```

The readiness answer must say `"runtimeAvailable":true`. `pair.mjs` prints a one-time URL that pairs a
browser, for example to finish Gateway Setup.

**2. Lab repository.** A copy of the fixture with a Git history (the fixture README has the baselines):

```bash
export KEIKO_LAB_REPO="$HOME/keiko-lab-ledger"
mkdir -p "$KEIKO_LAB_REPO" && cp -R tests/fixtures/coding-workbench-lab/ledger-lab/. "$KEIKO_LAB_REPO"/
(cd "$KEIKO_LAB_REPO" && git init -b main && git add -A \
  && git -c user.name="Keiko Lab" -c user.email=lab@keiko.invalid -c commit.gpgsign=false commit -m "Baseline" \
  && npm install)
```

**3. Run one task through the real UI.** The driver pairs a headless Chromium, selects the repository,
the model and the Run authority, starts the task, then, as `--approve` says, approves permissions,
applies the change reviews of Ask for approval (`--approve none` rejects them) and allows the
package-script trust pause until the run settles (`all` below: the driver approves; use
`--approve ask --headed` to decide yourself). The last line names the run
(`----- run run-<digits> -----`).

```bash
node scripts/testing/coding-workbench-lab/wb-ui.mjs --list-tasks
mkdir -p "$HOME/keiko-lab-runs"
node scripts/testing/coding-workbench-lab/wb-ui.mjs --task-id T2 --approve all \
  --shots "$HOME/keiko-lab-runs/t2" --text-out "$HOME/keiko-lab-runs/t2.txt"
node scripts/testing/coding-workbench-lab/wb-stop.mjs run-<digits>     # stop a run that must not continue
```

**4. Read the run.** These scripts read the Activity Log (`.keiko/dev/logs`, or `--log-dir`) and print
counts, durations, states and closed reason codes only; times are UTC. `turn-profile.mjs` prints one
row per model turn, buffered or streamed and failed turns included: dispatch offset, messages,
prompt tokens of the end line, `hdr s` (the model's own fetch, found by following the attempt's
`gateway.prompt.admission`, so the token-counter round trip is not mistaken for it), `ttft s` (the
first data event: headers plus `firstDataMs` of the read line), `gen s` (decoding: the read's duration
minus `firstDataMs`), completion tokens and tokens per second over `gen s`, reasoning tokens and
bytes of the end line, the finish reason, the tools the turn produced, the operator wait and the gap
to the next request. A model server that answers a tool call as one block (Ollama does) sends the
headers after the whole generation: `hdr s` is then the model's whole time, `gen s` is close to zero
and `tok/s` stays `-` (a rate needs a read that streamed). The breakdown that follows splits the wall
clock, bounded at the run's settlement, into slices that never overlap: model time (accepted,
failed and cancelled turns), operator pauses (a package-script trust wait, an approval from
`coding-runtime.approval.waiting` to its decision or expiry, or the change review of an edit in Ask
for approval, from `coding-runtime.editor-review.decided` to
`coding-runtime.editor-mutation.settled`: the edit tool waits in place for the person, so that wait
is carved out of its tool time), tools, the gaps between turns and "other". A
repository-instructions line (`AGENTS.md` state, bytes attached and the estimated tokens re-sent
with every turn) precedes the table when the run logged one. The log names these tools read are
checked against `docs/observability/op-catalog.generated.json` at start, so a renamed operation or
field fails loudly instead of printing zeros.

```bash
node scripts/testing/coding-workbench-lab/run-summary.mjs run-<digits>
node scripts/testing/coding-workbench-lab/turn-profile.mjs run-<digits>
node scripts/testing/coding-workbench-lab/rawtl.mjs <trailing digits> gateway.retry,edit.refused
```

**5. Inject a chaos scenario.** The proxy sits between LiteLLM and the model server (lab README,
step 3). A fault is one control call; `wb-run.mjs` runs the short read-only task C1 over HTTP:

```bash
node scripts/testing/coding-workbench-lab/chaos-proxy.mjs                  # terminal A: 127.0.0.1:11500 -> 127.0.0.1:11434
curl -s -X POST http://127.0.0.1:11500/__chaos -d '{"mode":"status","status":503,"durationMs":120000}'
node scripts/testing/coding-workbench-lab/wb-run.mjs --task-id C1 --approve none
curl -s http://127.0.0.1:11500/__chaos                                     # state and counters
curl -s -X POST http://127.0.0.1:11500/__chaos -d '{"mode":"pass"}'
node scripts/testing/coding-workbench-lab/chaos-suite.mjs --approve none --scenarios S4,S5 --out-dir "$HOME/keiko-lab-runs/chaos"
```

The proxy ends an abandoned call: when the client goes away (LiteLLM's timeout, a stopped run) it
destroys the upstream request and clears the timers of the fault, so a held call is never forwarded
late and never keeps a socket open.

**6. Record a ledger row.** The script prints a draft row for the _Results_ table of
`docs/qa/coding-workbench-gemma-litellm-lab.md`; edit its outcome and add operator-level evidence.
The row says who drove the run and answered its approvals: `--driver` is `wb-ui`, `wb-run` or
`manual` (a person worked in the Workbench), and `wb-ui` and `wb-run` need the `--approve` policy the
run used, so a driver-approved run never reads as human-in-the-loop evidence. Never paste a prompt,
code or model output into the ledger.

```bash
node scripts/testing/coding-workbench-lab/run-summary.mjs run-<digits> --ledger-row \
  --driver wb-ui --approve all --task T2 --mode "Supervised workspace" --head "$(git rev-parse --short HEAD)"
```

## Scripts

| Script                      | What it does                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tasks.json`                | The task catalog: ids T1 to T13 and C1, their exact texts, modes and baselines                                                       |
| `wb-ui.mjs`                 | Runs one task through the real Workbench UI in headless Chromium (`--headed` to watch); the driver for every editing task            |
| `wb-run.mjs`                | Runs one task over the HTTP API; read-only tasks only, because edits need the live editor bridge (finding F4)                        |
| `wb-stop.mjs`               | Stops a run                                                                                                                          |
| `wb-trust.mjs`              | Grants or revokes package-script trust for a lab repository (`grant` or `revoke`, no default); registers the copy first              |
| `pair.mjs`                  | Prints a one-time pairing URL (or the attestation JSON); valid about 30 seconds, usable once                                         |
| `run-summary.mjs`           | Body-free run summary and, with `--ledger-row`, a draft ledger row that names the driver and the approval policy                     |
| `turn-profile.mjs`          | Body-free per-turn timing profile of a run (model, operator pauses, tools, gaps), bounded at the run's settlement                    |
| `rawtl.mjs`                 | Body-free raw timeline of a run and its child requests, optionally filtered by operation                                             |
| `chaos-proxy.mjs`           | Fault-injecting proxy between LiteLLM and the model server (503 bursts, outage, latency, drop, stall, hang)                          |
| `chaos-suite.mjs`           | Runs the scenarios S1 to S7 against task C1, one summary line each; exits 1 if one started no run                                    |
| `verify-latency.mjs`        | Times the server's enforced verification path on the lab repository (finding F14)                                                    |
| `lab-common.mjs`            | Shared helpers: option parsing, approval policy, lab-repository check, loopback-only base URL, pairing, task catalog                 |
| `activity-log-events.mjs`   | Reads the Activity Log through the file grammar in `keiko-contracts` (a library, not a command)                                      |
| `op-contract.mjs`           | Compares the operation and field names a tool reads with the generated op catalog (a library, not a command)                         |
| `intervals.mjs`             | Interval algebra behind the non-overlapping slices of the turn profile (a library, not a command)                                    |
| `connected-chat-cases.mjs`  | Connected-chat campaign questions and ordinary-folder manual fixture bindings (a library, not a command)                             |
| `connected-chat-run.mjs`    | Runs an explicit connected-chat campaign against a held checkout and owner-only runtime metadata; `--prepare` makes no model request |
| `connected-chat-record.mjs` | Produces body-free connected-chat answer, citation, source-authority and Activity Log observations (a library, not a command)        |

The pure logic of these scripts (option parsing, the turn-profile pairing and slices, the proxy's
fault handling, the catalog and fixture consistency) is covered by
`scripts/__tests__/coding-workbench-lab-*.test.mjs`.

Every command prints its usage with `--help`. Exit codes of the run drivers: 0 the run succeeded,
1 it ended in another terminal state, 3 the timeout elapsed, 2 a usage error. `chaos-suite.mjs`
exits 0 when every scenario started a run (its `summary.log` ends with `DONE`), 1 when at least one
scenario was refused before a run started (it ends with `INCOMPLETE`), 2 for a usage error. The
drivers talk to a loopback `http` dev server only, since they send a pairing attestation; the dev
server serves pages on `localhost` and redirects `127.0.0.1` page loads, so the UI driver always
browses `localhost`.
