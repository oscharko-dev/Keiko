# Coding Workbench live lab: drivers

Tooling for the live qualification of the Coding Workbench with a self-hosted model behind LiteLLM
(epic #3871, issue #3872). The end-to-end reproduction (model server, LiteLLM, task suite, fixture
repository) is in [`docs/qa/coding-workbench-lab/README.md`](../../../docs/qa/coding-workbench-lab/README.md);
this page is the command reference. The scripts are lab tooling for a local operator: none reads a
secret from a file or from the repository, none prints one, and the run summaries are body-free.

## Prerequisites

- A Keiko checkout with `npm install` done and the packages built (`npm run build:packages`, which
  `npm run dev:start` also does): the scripts import the built `packages/*/dist`. Node as the root
  `package.json` `engines` require.
- A Chromium build for the UI driver: `npx playwright install chromium`.
- LiteLLM, the model server and Keiko's Gateway Setup, as described in the lab README.
- The lab repository: a copy of `tests/fixtures/coding-workbench-lab/ledger-lab/` with a Git history on branch `main`.

## Environment

| Variable                                   | Meaning                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET` | Required by `pair` and every `wb-*` script: the secret the dev server was started with (at least 32 characters). Read from the environment only |
| `KEIKO_LAB_REPO`                           | The lab repository checkout; the default of `--repo`                                                                                            |
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
the model and the Run authority, starts the task, then approves permissions, applies the change
reviews of Ask for approval (`--approve none` rejects them) and allows the package-script trust
pause until the run settles. The last line names the run (`----- run run-<digits> -----`).

```bash
node scripts/testing/coding-workbench-lab/wb-ui.mjs --list-tasks
mkdir -p "$HOME/keiko-lab-runs"
node scripts/testing/coding-workbench-lab/wb-ui.mjs --task-id T2 \
  --shots "$HOME/keiko-lab-runs/t2" --text-out "$HOME/keiko-lab-runs/t2.txt"
node scripts/testing/coding-workbench-lab/wb-stop.mjs run-<digits>     # stop a run that must not continue
```

**4. Read the run.** These scripts read the Activity Log (`.keiko/dev/logs`, or `--log-dir`) and print
counts, durations, states and closed reason codes only; times are UTC. `turn-profile.mjs` prints one row per
model turn (dispatch offset, messages, provider-reported prompt tokens, time to the response headers,
generation time, completion tokens and tokens per second, reasoning tokens and bytes when the log
carries them, finish reason, the tools the turn produced and the gap to the next request) and then
where the wall clock went (model, tools, sidecar and BFF gaps, operator pauses, other).

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
node scripts/testing/coding-workbench-lab/wb-run.mjs --task-id C1
curl -s http://127.0.0.1:11500/__chaos                                     # state and counters
curl -s -X POST http://127.0.0.1:11500/__chaos -d '{"mode":"pass"}'
node scripts/testing/coding-workbench-lab/chaos-suite.mjs --scenarios S4,S5 --out-dir "$HOME/keiko-lab-runs/chaos"
```

**6. Record a ledger row.** The script prints a draft row for the _Results_ table of
`docs/qa/coding-workbench-gemma-litellm-lab.md`; edit its outcome and add operator-level evidence.
Never paste a prompt, code or model output into the ledger.

```bash
node scripts/testing/coding-workbench-lab/run-summary.mjs run-<digits> --ledger-row \
  --task T2 --mode "Supervised workspace" --head "$(git rev-parse --short HEAD)"
```

## Scripts

| Script                    | What it does                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tasks.json`              | The task catalog: ids T1 to T12 and C1, their exact texts, modes and baselines                                            |
| `wb-ui.mjs`               | Runs one task through the real Workbench UI in headless Chromium (`--headed` to watch); the driver for every editing task |
| `wb-run.mjs`              | Runs one task over the HTTP API; read-only tasks only, because edits need the live editor bridge (finding F4)             |
| `wb-stop.mjs`             | Stops a run                                                                                                               |
| `wb-trust.mjs`            | Grants or revokes package-script trust for a repository                                                                   |
| `pair.mjs`                | Prints a one-time pairing URL (or the attestation JSON); valid about 30 seconds, usable once                              |
| `run-summary.mjs`         | Body-free run summary and, with `--ledger-row`, a draft ledger row                                                        |
| `turn-profile.mjs`        | Body-free per-turn timing profile of a run (model, tools, gaps, pauses), bounded at the run's settlement                  |
| `rawtl.mjs`               | Body-free raw timeline of a run and its child requests, optionally filtered by operation                                  |
| `chaos-proxy.mjs`         | Fault-injecting proxy between LiteLLM and the model server (503 bursts, outage, latency, drop, stall, hang)               |
| `chaos-suite.mjs`         | Runs the scenarios S1 to S7 against task C1 and writes one summary line per scenario                                      |
| `verify-latency.mjs`      | Times the server's enforced verification path on the lab repository (finding F14)                                         |
| `lab-common.mjs`          | Shared helpers: option parsing, loopback-only base URL, pairing, task catalog (a library, not a command)                  |
| `activity-log-events.mjs` | Reads the Activity Log through the file grammar in `keiko-contracts` (a library, not a command)                           |

Every command prints its usage with `--help`. Exit codes of the run drivers: 0 the run succeeded,
1 it ended in another terminal state, 3 the timeout elapsed, 2 a usage error. The drivers talk to a
loopback `http` dev server only, since they send a pairing attestation; the dev server serves pages on
`localhost` and redirects `127.0.0.1` page loads, so the UI driver always browses `localhost`.
