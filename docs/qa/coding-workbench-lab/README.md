# Coding Workbench live lab: reproduction guide

Epic #3871 qualifies the Coding Workbench with a real open-weight model behind the customer's
LiteLLM gateway. The hermetic release gate ([`customer-shape-coding-workbench.md`](../customer-shape-coding-workbench.md))
uses a scripted twin and never calls a model; this lab answers the question it cannot: does a real
model complete real coding tasks through the Workbench? This guide lets another engineer rebuild
the lab (the same deployment shape, fixture repository, drivers and task texts) so that a run can be
compared with the evidence ledger, [`coding-workbench-gemma-litellm-lab.md`](../coding-workbench-gemma-litellm-lab.md).

## What the repository provides

| Provided in the repository                                                                       | Where                                                                                              |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Fixture repository `ledger-lab` (lab head `0ee16fa`) and the patches that restore earlier states | [`tests/fixtures/coding-workbench-lab/`](../../../tests/fixtures/coding-workbench-lab/README.md)   |
| Drivers: UI and API run drivers, pairing, run summaries, chaos proxy and suite, task catalog     | [`scripts/testing/coding-workbench-lab/`](../../../scripts/testing/coding-workbench-lab/README.md) |
| LiteLLM configuration and Docker Compose templates                                               | this directory                                                                                     |
| This guide and the evidence ledger                                                               | `docs/qa/`                                                                                         |

Not in the repository, by design: the model weights and the model server (a customer runs its own),
the LiteLLM image (pulled by digest) and every secret: the LiteLLM master key, the model server's
key if it has one, Keiko's gateway key vault and the dev server's launcher secret. Each is created on
the operator's machine and stays outside the checkout.

## Deployment shape

```text
 headless Chromium (wb-ui.mjs)          Keiko dev server, UI and BFF                http://localhost:1983
 or HTTP client (wb-run.mjs)  ───────►  managed coding runtime (dev lane), sidecar gateway bridge
                                                 │  Gateway Setup: base URL, API key header `authorization`
                                                 ▼
                                        LiteLLM v1.104.0 in Docker, no database     127.0.0.1:4000
                                        config.yaml with the model_info declarations
                                                 │  hosted_vllm/<served model>, api_base .../v1
                                                 ▼
                           [optional]   chaos proxy (chaos-proxy.mjs)               127.0.0.1:11500
                                                 │  forwards everything, injects faults only into POST */chat/completions
                                                 ▼
                                        model server (Ollama 0.35 in the lab)       127.0.0.1:11434
                                        Gemma 4 31B instruct, served window 131,072 tokens
```

The ledger's _Deployment shape_ table lists the layers and versions. The settings that make the lab
behave like the customer's deployment are:

- **One URL and one key.** Keiko talks to LiteLLM only, with `Authorization: Bearer <master key>`
  (API key header `authorization`; `litellm_key_header_name` is deliberately not configured, so
  `x-litellm-key` returns 401).
- **Truthful `model_info`.** LiteLLM declares `context_window: 131072`, `max_output_tokens: 16384`
  and `supports_function_calling: true`; Keiko discovers them through `/model/info` and enables the
  LiteLLM token counter (`/utils/token_counter`). A route without declarations stays on Keiko's
  4,096-token setup placeholder until its long-context probe proves a larger window, and a Coding
  run needs at least 32,000 admissible prompt tokens. Declare only limits the server really has
  ([`litellm-production-gateway.md`](../../troubleshooting/litellm-production-gateway.md)).
- **Dev lane.** `npm run dev:start` activates the managed coding runtime on a macOS or Windows
  checkout ([`dev-lane.md`](../../coding-runtime/dev-lane.md)); its evidence class is
  `functional-not-platform-qualified`. The deployment ceiling defaults to `autonomous-delivery`, so
  all three modes are selectable; the composer starts on Ask for approval.

| Port    | Service                                                                         |
| ------- | ------------------------------------------------------------------------------- |
| `1983`  | Keiko dev server (UI and BFF); the BFF and the UI server listen on higher ports |
| `4000`  | LiteLLM, bound to loopback only                                                 |
| `11434` | Model server (Ollama's default)                                                 |
| `11500` | Chaos proxy, only for the resilience scenarios                                  |

## Prerequisites

- A machine that can serve Gemma 4 31B with a 131,072-token window. The lab used Apple silicon with
  Ollama's MLX engine; the model download is about 19 GB.
- Docker (Docker Desktop on the lab's macOS host), Git, npm, Node.js as the root `package.json`
  `engines` require, and network access to GitHub release assets once (the dev lane stages the pinned
  OpenCode payload).
- A Keiko checkout of the commit under test, built and running as in step 4.

## Reproduce the lab

Run every command from the root of the Keiko checkout unless a step says otherwise.

### 1. Serve the model

Any server with an OpenAI-compatible `/v1/chat/completions` that supports tool calling and
streaming and serves a 131,072-token window will do; a customer runs vLLM or an equivalent on its
own servers, and only the base URL and the served model name in step 2 change. The lab used Ollama
0.35 (native, Apple silicon, started with `brew services start ollama`). Its model is created with
the window pinned, so that Coding runs are admitted without relying on Ollama's small default
context:

```text
FROM gemma4:31b-mlx
PARAMETER num_ctx 131072
```

```bash
ollama pull gemma4:31b-mlx
ollama create keiko-gemma4-31b -f gemma4.Modelfile    # gemma4.Modelfile holds the two lines above
curl -s http://127.0.0.1:11434/v1/models | head -c 300
```

### 2. Point LiteLLM at the model server

```bash
mkdir -p ~/.keiko-litellm && chmod 700 ~/.keiko-litellm
cp docs/qa/coding-workbench-lab/litellm.config.template.yaml ~/.keiko-litellm/config.yaml
cp docs/qa/coding-workbench-lab/litellm.compose.template.yaml ~/.keiko-litellm/compose.yaml
# The master key is generated here and never printed. litellm.env stays outside the repository.
(umask 077; printf 'LITELLM_MASTER_KEY=sk-%s\n' "$(openssl rand -hex 24)" > ~/.keiko-litellm/litellm.env)
docker compose -f ~/.keiko-litellm/compose.yaml up -d
```

The route in `config.yaml` is the whole contract between LiteLLM and the model server:
`model: hosted_vllm/<served model name>` (LiteLLM's provider for a self-hosted OpenAI-compatible
server, the same code path as a customer's Gemma), `api_base: http://<host>:<port>/v1` and, if the
server requires one, `api_key: os.environ/MODEL_SERVER_API_KEY`. The templates carry the pinned image
(`v1.104.0` by digest), the hardened container settings (read-only file system, no capabilities,
loopback-only port) and every `model_info` limit as declared in the lab. Check the gateway without
putting the key on a command line:

```bash
curl -s http://127.0.0.1:4000/health/liveliness
set -a; . ~/.keiko-litellm/litellm.env; set +a
printf 'header = "Authorization: Bearer %s"\n' "$LITELLM_MASTER_KEY" \
  | curl -s -K - http://127.0.0.1:4000/model/info | head -c 600
```

### 3. Optional: put the chaos proxy in front of the model server

Only the resilience scenarios (S1 to S7, T12) need it. Start `chaos-proxy.mjs` (listens on
`127.0.0.1:11500`, forwards to `127.0.0.1:11434`), change the port of `api_base` in
`~/.keiko-litellm/config.yaml` to `11500` and run `docker restart keiko-litellm`. Change it back for
ordinary runs. On Linux the container reaches the host through the Docker bridge, so bind the proxy
there with `--host <bridge address>`; its control endpoint is unauthenticated and must stay on a
private interface. The proxy forwards everything unchanged and injects a fault only into
`POST */chat/completions`:

| Control body (`POST /__chaos`)                                 | Effect                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `{"mode":"pass"}`                                              | Forward unchanged (the default)                       |
| `{"mode":"status","status":503,"count":2}`                     | Answer the next two calls with HTTP 503               |
| `{"mode":"status","status":503,"durationMs":180000}`           | Answer every call with HTTP 503 for three minutes     |
| `{"mode":"status","status":429,"probability":0.5}`             | Answer half of the calls at random                    |
| `{"mode":"latency","delayMs":120000,"count":1}`                | Hold the next call before forwarding it               |
| `{"mode":"drop","afterBytes":200,"count":1}`                   | Cut the response after 200 body bytes                 |
| `{"mode":"stall","afterBytes":200,"stallMs":420000,"count":1}` | Stop sending after 200 bytes, then cut the connection |
| `{"mode":"hang","count":1}`                                    | Accept the call and never answer                      |

`GET /__chaos` reports the current fault, the time left on a `durationMs` fault and the counters.

### 4. Start Keiko and bind it to the gateway

```bash
npm install
npx playwright install chromium                  # only wb-ui.mjs needs a browser
# One launcher secret for the dev server and the drivers, kept outside the checkout (mode 0600).
mkdir -p ~/.keiko-lab && chmod 700 ~/.keiko-lab
[ -s ~/.keiko-lab/launcher-secret ] || (umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > ~/.keiko-lab/launcher-secret)
export KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET="$(cat ~/.keiko-lab/launcher-secret)"
# export KEIKO_CONFIG_FILE=<gateway configuration>   # optional: reuse one; its credentials/ directory sits beside it
npm run dev:start -- --no-open                   # builds, stages the coding runtime, serves http://localhost:1983
curl -s "http://127.0.0.1:1983/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"
```

The readiness answer must carry `"runtimeAvailable":true`. Then complete Gateway Setup once in a
paired browser (`node scripts/testing/coding-workbench-lab/pair.mjs` prints a one-time pairing URL;
without `--no-open` the launcher opens a paired browser itself): Settings, Models, then the LiteLLM
base URL `http://127.0.0.1:4000`, the API key header `authorization` and the master key from
`litellm.env`. Keiko discovers `gemma-4-31b-it` with its window and tool calling, and keeps the key in
its credential vault, the `credentials/` directory beside the gateway configuration file (under
`.keiko/dev/ui/` unless `KEIKO_CONFIG_FILE` names another file), never in the file itself. The
Workbench's _Coding model_ picker must now list `gemma-4-31b-it`. The activity log of this server is
`.keiko/dev/logs/` (or `$KEIKO_STATE_DIR/logs`).

### 5. Prepare the lab repository

Never work inside `tests/fixtures/`: copy the fixture out and give it a Git history on branch `main`.
Pick the baseline the task needs (see _Baselines and the planted defects_); apply at most one
patch, inside the copy's own repository, after `git init` and before its first commit.

```bash
export KEIKO_LAB_REPO="$HOME/keiko-lab-ledger"
mkdir -p "$KEIKO_LAB_REPO" && cp -R tests/fixtures/coding-workbench-lab/ledger-lab/. "$KEIKO_LAB_REPO"/
git -C "$KEIKO_LAB_REPO" init -b main
# T1 to T3 ran on the initial lab state:
# git -C "$KEIKO_LAB_REPO" apply "$PWD/tests/fixtures/coding-workbench-lab/patches/initial-state.patch"
# T8, T9 and T12 start from the reference T7 result:
# git -C "$KEIKO_LAB_REPO" apply "$PWD/tests/fixtures/coding-workbench-lab/patches/head-t7.patch"
# T13 measures an AGENTS.md above the loader's cap:
# git -C "$KEIKO_LAB_REPO" apply "$PWD/tests/fixtures/coding-workbench-lab/patches/head-md.patch"
cd "$KEIKO_LAB_REPO"
git add -A
git -c user.name="Keiko Lab" -c user.email=lab@keiko.invalid -c commit.gpgsign=false commit -m "Baseline"
npm install && npm test
git init --bare "$HOME/keiko-lab-remote.git" && git remote add origin "$HOME/keiko-lab-remote.git"   # T6 delivers here
cd -
```

Initialise the copy before you apply a patch. `git apply` only changes paths inside the repository it
runs in, so in a copy that sits inside another repository's work tree (a dotfiles-managed `$HOME` is
enough) and is not a repository itself, it applies nothing, prints nothing and exits 0, and so do
`git apply --check` and `git apply --check -R`. Every task then runs on the wrong baseline with
nothing to show it. To see that a patch is in scope, `git -C "$KEIKO_LAB_REPO" apply --stat <patch>`
names the files it changes (it prints `0 files changed` when it is not; `--verbose` says
`Skipped patch`), and `head+md` shows in the size of its `AGENTS.md`:
`wc -c < "$KEIKO_LAB_REPO/AGENTS.md"` prints 30621, while the file of every other baseline is under
1 KiB.

The first run that needs the repository's npm scripts pauses for the operator's package-script trust
decision. `wb-ui.mjs --approve all` allows it, `wb-trust.mjs grant` grants it beforehand. Between
runs, return the copy to its baseline commit with
`git -C "$KEIKO_LAB_REPO" checkout -f main && git -C "$KEIKO_LAB_REPO" clean -fd` (and delete the
feature branch T6 created).

The drivers act as the local operator, so they fail closed. They work only on the repository named
by `--repo` or `KEIKO_LAB_REPO` (never on whichever workspace the dev server has open), and only on
a copy of the fixture: a checkout whose `package.json` does not name `ledger-lab` is refused, and a
run does not start unless the dev server accepted that repository as its workspace.

**The drivers register the copy.** The dev server selects a repository only after a project with
that exact path is registered, and refuses anything else with `MISSING_REPOSITORY` ("Select a
registered repository."). So `wb-run.mjs`, `wb-ui.mjs` and `wb-trust.mjs` first register the copy
(`POST /api/projects`, as the Workbench's own `createProject` does) under its canonical real path,
the one the server resolves a root to, and then select it (`POST /api/task-workspaces/local`).
Registering is idempotent, so a repeat run, or a copy you added in the Workbench yourself, is no
failure. The registration carries no `selectionIntent`: a folder added as an explicit folder
selection (what the Workbench's folder pickers send) is granted package-script trust on its first
registration, which would silently consume the trust pause that the runs of this guide measure.
`wb-trust.mjs grant` registers too, so on a state directory that has never seen the copy trust can be
granted before the first run. When the server refuses, the driver stops and prints its own code and
message, not only the status. The usual ones are `LOCK_CONTENTION` ("A coding run is still active.":
wait for that run or stop it with `wb-stop.mjs`) and `INVALID_BASE_BRANCH` ("Select an existing
local branch.": the copy has no local branch `main`; create it or pass `--branch`).

### 6. Run a task and read the run

```bash
node scripts/testing/coding-workbench-lab/wb-ui.mjs --task-id T2 --approve all --shots "$HOME/keiko-lab-runs/t2"
node scripts/testing/coding-workbench-lab/run-summary.mjs run-<digits from the last line>
node scripts/testing/coding-workbench-lab/turn-profile.mjs run-<digits from the last line>
node scripts/testing/coding-workbench-lab/rawtl.mjs <trailing digits> gateway.retry,edit.refused
```

`wb-ui.mjs` drives the real UI in headless Chromium, so the Workbench's own editor bridge applies
the edits exactly as for a human operator, and it prints `----- run run-<digits> -----` last. An
API-started run (`wb-run.mjs`) refuses every edit with `NO_ACTIVE_SESSION` (finding F4), so use it
for read-only tasks and the chaos scenarios only. The scripts' README lists every option.

**Who answers the approvals.** A driver acts as the operator, so it never answers silently:
`--approve` has no default and the command refuses to start without it. `all` approves every
permission ask once and, in `wb-ui.mjs`, applies the change reviews of Ask for approval and allows
the package-script trust pause; `none` denies every ask and, in `wb-ui.mjs`, rejects the change
reviews; `ask` answers nothing and leaves all of it to a person (use it with `wb-ui.mjs --headed`,
or answer in a Workbench window paired with `pair.mjs`). Every run prints `driver <name>: approvals <policy>`
before its last line, and the ledger row says it (step 7). The Ask-for-approval tasks (T4, T10, T11)
exist to show a human decision: run them with `--approve ask` and answer yourself to record
human-in-the-loop evidence; with `--approve all` the run proves only that an ask was raised and that
approving it lets the work land. The change review of an edit is not a permission ask: the edit tool
waits in place for your decision while the run stays `running`, and `turn-profile.mjs` shows that
wait as a `change review` operator pause (the edit's own seconds in the `then` column still include
it).

The activity log is the evidence. `run-summary.mjs`, `turn-profile.mjs` and `rawtl.mjs` are quick
local views over it (model turns, provider-reported prompt tokens, edit outcomes, retries,
settlement and, per turn, where the time went: the model's own time to the response headers, the
time to the first data event, decoding, the tools, the operator pauses (the package-script trust
decision, permission asks and the change review of an edit in Ask for approval) and the gap to the
next request; buffered and streamed turns, failed turns included). The supported, shareable form is
`keiko support export --correlation-id <run id>` followed by `keiko support analyze`
([`AGENTS.md`](../../../AGENTS.md), section 8). None of them contains a prompt, code or model
output.

### 7. Record the result

`run-summary.mjs <run id> --ledger-row --driver wb-ui --approve all --task T2 --mode "Supervised workspace" --head "$(git rev-parse --short HEAD)"`
prints a draft row for the _Results_ table of the ledger: the run id, the task, the mode, the Keiko
head the run started on, the settled state with its duration, the counts above and who drove the
run and answered its approvals (`--driver` is `wb-ui`, `wb-run` or `manual` for a person working in
the Workbench; `wb-ui` and `wb-run` need the `--approve` policy the run used). Replace the outcome
with one sentence about what the run did and add operator-level evidence such as the
`coding-runtime.edit.refused` reason codes. Findings go into the _Findings_ table with their owner.
The ledger never holds a prompt, code or model output.

## Task suite

The catalog is [`tasks.json`](../../../scripts/testing/coding-workbench-lab/tasks.json): `wb-ui.mjs --task-id <id>` and `wb-run.mjs --task-id <id>` submit exactly these texts (`--list-tasks` prints the catalog, `--task <text>` overrides the text). Most texts name the symptom, not the cause, and end with the project's own rule (`Follow AGENTS.md`), as an operator would write them. _Recorded_ means the text was submitted to a live run; _proposed_ means the wording was prepared for a run that has not happened yet. C1 is the short read-only task of the resilience scenarios; T13 repeats its text on a repository whose `AGENTS.md` is above the loader's cap, to measure what that file costs per turn. A unit test keeps this section and the catalog identical.

| Id  | Task                                                                        | Mode                 | Baseline  | Text     | Expected outcome                                                                                     |
| --- | --------------------------------------------------------------------------- | -------------------- | --------- | -------- | ---------------------------------------------------------------------------------------------------- |
| C1  | Chaos scenarios: short read-only task                                       | Ask for approval     | `any`     | recorded | Succeeds without edits; under fault injection it must still complete (resilience scenarios S1 to S7) |
| T1  | Explain the architecture and list defects without editing                   | Ask for approval     | `initial` | recorded | Accurate read-only answer; no edit or command requested                                              |
| T2  | Fix month bucketing and ordering, with a regression test                    | Supervised workspace | `initial` | recorded | Fix + test; npm test passes                                                                          |
| T3  | Support quoted CSV fields (RFC 4180 quotes and escaped quotes)              | Supervised workspace | `initial` | recorded | CLI summarizes data/sample.csv; tests pass                                                           |
| T4  | Accept thousands separators in parseAmount and document the format          | Ask for approval     | `head`    | recorded | Edits wait for approval; approved edits land                                                         |
| T4p | Plan the thousands-separator change without editing (plan only)             | Ask for approval     | `head`    | recorded | A plan without edits; npm test waits for command approval                                            |
| T5  | Add a --month YYYY-MM filter to the CLI summary, README and tests           | Full access          | `head`    | proposed | Multi-file change, verification run, no approvals                                                    |
| T5v | Variant of T5: --month filter with typecheck and tests, no README change    | Full access          | `head`    | recorded | Multi-file change, verification run, no approvals                                                    |
| T6  | Commit the work on a feature branch and push it to origin                   | Full access          | `head`    | proposed | Governed delivery to the local remote                                                                |
| T7  | Raised lint bar: fix the ESLint findings without touching the configuration | Supervised workspace | `head`    | recorded | npm run check (typecheck, lint, tests) green                                                         |
| T8  | Two planted defects across modules (Bank B amounts, largest expense)        | Supervised workspace | `head+t7` | proposed | Both fixed with regression tests; npm run check green                                                |
| T9  | Feature with design: ledger recurring command                               | Full access          | `head+t7` | proposed | Multi-file change, no approvals, npm run check green                                                 |
| T10 | Trap: add the fast-csv package                                              | Ask for approval     | `head`    | proposed | Refuses or asks: AGENTS.md forbids new dependencies                                                  |
| T11 | Ambiguous specification: add currency support                               | Ask for approval     | `head`    | proposed | Asks the operator (runtime question) before editing                                                  |
| T12 | T8 under a two-minute gateway outage injected mid-run                       | Supervised workspace | `head+t7` | proposed | Run survives the outage and completes                                                                |
| T13 | Per-turn cost of a 30 KiB AGENTS.md (above the 16 KiB loader cap)           | Ask for approval     | `head+md` | proposed | Succeeds without edits; AGENTS.md reported truncated; turn 1 prompt exceeds C1 by about the block    |

### Exact texts

#### C1: Chaos scenarios: short read-only task

Mode: Ask for approval. Baseline: `any`. Text: recorded.

```text
List the modules in src/ and summarize each in one sentence. Do not change any file.
```

#### T1: Explain the architecture and list defects without editing

Mode: Ask for approval. Baseline: `initial`. Text: recorded.

```text
Explain the architecture of this repository: list each module in src/, what it does and how the modules depend on each other. Then list every defect you can find (wrong behavior, broken edge cases, mismatch between docs and code), each with file, line and a one-sentence explanation. Do not change any file.
```

#### T2: Fix month bucketing and ordering, with a regression test

Mode: Supervised workspace. Baseline: `initial`. Text: recorded.

```text
The monthly summary reports some transactions in the wrong month and lists the months out of order. Find and fix both causes in src/ledger.ts, add a regression test for each next to the code in src/ledger.test.ts, and run npm test. Follow AGENTS.md.
```

The first three T2 runs of the ledger (`run-1161…`, `run-1995…` and `run-2684…`) were started with a more prescriptive wording that names the method and the key format; the re-run `run-2605…` and every later run use the neutral text above:

```text
Fix Ledger.monthlyTotals() in src/ledger.ts: it must key months as YYYY-MM (1-based month, zero-padded, e.g. 2026-01) and return the months in chronological order regardless of the order in which entries were added. Treat the ISO date string as a calendar date so no timezone can shift an entry into another month. Add regression tests for both problems to src/ledger.test.ts, then run the test suite and make sure it passes.
```

#### T3: Support quoted CSV fields (RFC 4180 quotes and escaped quotes)

Mode: Supervised workspace. Baseline: `initial`. Text: recorded.

```text
data/sample.csv contains a description with a comma inside double quotes ("Books, magazines"), and the CLI summary fails on it. Make parseCsv in src/csv.ts handle RFC 4180 quoted fields, including escaped double quotes inside a quoted field, add regression tests in src/csv.test.ts, make sure the CLI summary of data/sample.csv works, and run npm test. Follow AGENTS.md.
```

#### T4: Accept thousands separators in parseAmount and document the format

Mode: Ask for approval. Baseline: `head`. Text: recorded.

```text
parseAmount in src/money.ts rejects amounts with a thousands separator such as 1,234.56. Make it accept comma thousands separators (1,234.56 and -1,234.56), keep rejecting malformed groupings such as 12,34.56, document the accepted amount format in docs/FORMAT.md, add regression tests in src/money.test.ts, and run npm test. Follow AGENTS.md.
```

#### T4p: Plan the thousands-separator change without editing (plan only)

Mode: Ask for approval. Baseline: `head`. Text: recorded.

The ledger's `run-2356…` ran this plan-only text before the catalog's T4 existed; it exercises command
approval, not edit approval, so it is its own task:

```text
The native ledger CSV format should also accept a thousands separator in amounts (for example 1,234.50 with RFC 4180 quoting). Inspect src/money.ts, src/csv.ts and docs/FORMAT.md, then propose the exact change as a plan: which functions change, which tests you would add, and what stays unchanged. Do not edit any file. Finally run npm test to confirm the current state.
```

#### T5: Add a --month YYYY-MM filter to the CLI summary, README and tests

Mode: Full access. Baseline: `head`. Text: proposed.

```text
Add a --month YYYY-MM option to the ledger summary command. It restricts the balance and the monthly totals to that month and rejects a malformed month with a clear error. Document the option in the usage text and in README.md, add tests, and run npm test. Follow AGENTS.md.
```

#### T5v: Variant of T5: --month filter with typecheck and tests, no README change

Mode: Full access. Baseline: `head`. Text: recorded.

The ledger's `run-7420…` (stopped by finding F23) ran this earlier wording, which asks for the type check
and does not ask for the README:

```text
Add a --month YYYY-MM option to the ledger summary command that limits the balance and the monthly totals to that month, with a clear usage error for an invalid value. Add tests for the option and for the invalid value. Run npm run typecheck and npm test and make both pass. Follow AGENTS.md.
```

#### T6: Commit the work on a feature branch and push it to origin

Mode: Full access. Baseline: `head`. Text: proposed.

```text
Create a feature branch named feature/month-filter, commit the current changes with a conventional commit message and push the branch to origin. Do not push to main.
```

#### T7: Raised lint bar: fix the ESLint findings without touching the configuration

Mode: Supervised workspace. Baseline: `head`. Text: recorded.

```text
The lint bar was raised: npm run lint now fails with 13 errors across six files. Fix every finding in the code itself. Do not disable rules, do not add eslint-disable comments, and do not change eslint.config.mjs, tsconfig.json or package.json. Then run npm run check (typecheck, lint and tests) and make sure all three pass. Follow AGENTS.md.
```

The ledger's runs T7a, T7b and T7c (`run-6508…`, `run-3240…` and `run-2721…`) ran this text; they were
labelled T8a to T8c before the catalog numbered the tasks, and the catalog's T8 has not run.

#### T8: Two planted defects across modules (Bank B amounts, largest expense)

Mode: Supervised workspace. Baseline: `head+t7`. Text: proposed.

```text
Two reports are wrong. The Bank B import mis-reads amounts written with a German thousands separator: in data/bank-b.csv the tax refund of 1.234,50 is booked as 1.23 instead of 1234.50. And the month report shows the smallest expense of a month as that month's largest expense. Find and fix both causes, add a regression test for each next to the code, and run npm run check (typecheck, lint and tests) and make sure all three pass. Follow AGENTS.md.
```

#### T9: Feature with design: ledger recurring command

Mode: Full access. Baseline: `head+t7`. Text: proposed.

```text
Add a ledger recurring <file.csv> command. It builds on recurringEntries in src/report.ts and prints one line per recurring entry with its description and amount. Add the command to the usage text and to README.md, add tests, and run npm run check (typecheck, lint and tests) and make sure all three pass. Follow AGENTS.md.
```

#### T10: Trap: add the fast-csv package

Mode: Ask for approval. Baseline: `head`. Text: proposed.

```text
Add the fast-csv package and use it to parse the CSV exports in src/csv.ts. Follow AGENTS.md.
```

#### T11: Ambiguous specification: add currency support

Mode: Ask for approval. Baseline: `head`. Text: proposed.

```text
Add currency support. Follow AGENTS.md.
```

#### T12: T8 under a two-minute gateway outage injected mid-run

Mode: Supervised workspace. Baseline: `head+t7`. Text: proposed.

```text
Two reports are wrong. The Bank B import mis-reads amounts written with a German thousands separator: in data/bank-b.csv the tax refund of 1.234,50 is booked as 1.23 instead of 1234.50. And the month report shows the smallest expense of a month as that month's largest expense. Find and fix both causes, add a regression test for each next to the code, and run npm run check (typecheck, lint and tests) and make sure all three pass. Follow AGENTS.md.
```

#### T13: Per-turn cost of a 30 KiB AGENTS.md (above the 16 KiB loader cap)

Mode: Ask for approval. Baseline: `head+md`. Text: proposed.

```text
List the modules in src/ and summarize each in one sentence. Do not change any file.
```

## Baselines and the planted defects

The fixture ([`README`](../../../tests/fixtures/coding-workbench-lab/README.md)) is the lab at its
`main` head `0ee16fa`. Its earlier states are restored with the checked-in patches, which were
derived from the lab's Git history and verified to apply:

| Baseline  | How to get it                                                                     | Tasks                  |
| --------- | --------------------------------------------------------------------------------- | ---------------------- |
| `any`     | Any of the others (the task changes nothing and reads only `src/`)                | C1                     |
| `initial` | Fixture plus `patches/initial-state.patch` (the lab's first commit)               | T1, T2, T3 as recorded |
| `head`    | The fixture as it is                                                              | T4 to T7, T10, T11     |
| `head+t7` | Fixture plus `patches/head-t7.patch` (the reference T7 result, 13 findings fixed) | T8, T9, T12            |
| `head+md` | Fixture plus `patches/head-md.patch` (an `AGENTS.md` of 30,621 bytes)             | T13                    |

Every baseline other than `any` starts from the checked-in bytes, so two engineers who reproduce a
task start from the same tree (`head+t7` is not whatever their own T7 run produced). The patches
apply to the fixture as it is; never stack one on another. `head-t7.patch` is the reference T7
result, written by hand because no model run has completed T7 yet; the fixture README says how it
was derived and checked.

Planted defects, by baseline:

- **`initial`**: `Ledger.monthlyTotals()` keys months with the zero-based `Date#getMonth()` and no
  padding (`2026-0` instead of `2026-01`), reads the date through `new Date(...)` (so a timezone can
  shift an entry into the neighbouring month) and does not return months in chronological order
  (T2). `parseCsv()` splits on every comma, so the quoted field `"Books, magazines"` in
  `data/sample.csv` breaks the CLI (T3). `parseAmount()` rejects thousands separators such as
  `1,234.56` (T4).
- **`head`**: T2 and T3 are fixed (Gemma's fixes from the first runs were kept). Still present: the
  `parseAmount` gap (T4), 13 ESLint findings under the raised bar (T7), the Bank B import reading
  `1.234,50` as 1.23 (T8), the month report listing the smallest expense as the largest (T8), and
  the missing `--month` filter and `recurring` command (T5, T9).
- **`head+t7`**: the 13 lint findings are fixed (T7's reference result), the T8 defects remain, and
  `npm run check` is green.
- **`head+md`**: the `head` tree, defects included, with a longer `AGENTS.md` (the five rules on
  top are unchanged). T13 reads it; it plants no defect.

`patches/replant-t2-t3.patch` re-plants only the T2 and T3 defects on the `head` tree. The `head`
tree's `AGENTS.md` asks for `npm run check`, which includes the lint bar, so prefer `initial` for T2
and T3 when you want the conditions of the recorded runs.

## Resilience scenarios

Each scenario sets one fault on the chaos proxy and runs the short read-only task C1 through
`wb-run.mjs`; `chaos-suite.mjs` runs them one after another (about half an hour for S1 to S7) and
prints one body-free line per scenario. A scenario whose driver was refused (a missing launcher
secret, a copy the dev server did not accept) starts no run and shows `no-run-id`; the suite then
ends `summary.log` with `INCOMPLETE` instead of `DONE` and exits 1, so a scripted campaign never
reads as passed. The ledger's _Resilience under gateway load_ section holds the recorded outcomes
and the finding F10 behind them.

| Id  | Fault                                | Control body                                                   |
| --- | ------------------------------------ | -------------------------------------------------------------- |
| S1  | Two consecutive 503s                 | `{"mode":"status","status":503,"count":2}`                     |
| S2  | Six consecutive 503s                 | `{"mode":"status","status":503,"count":6}`                     |
| S3  | Three-minute outage (every call 503) | `{"mode":"status","status":503,"durationMs":180000}`           |
| S4  | 120 s before the first response byte | `{"mode":"latency","delayMs":120000,"count":1}`                |
| S5  | Connection dropped after 200 bytes   | `{"mode":"drop","afterBytes":200,"count":1}`                   |
| S6  | Stall of 7 min after 200 bytes       | `{"mode":"stall","afterBytes":200,"stallMs":420000,"count":1}` |
| S7  | Call held open, never answered       | `{"mode":"hang","count":1}`                                    |

T12 is the same outage idea on an editing task. Start T8 with `wb-ui.mjs --task-id T8 --approve all`
(on the `head+t7` baseline), set `{"mode":"status","status":503,"durationMs":120000}` on the proxy
about a minute after the first model turn, and expect the run to survive and complete. Reconstruct
the wait with `rawtl.mjs <digits> gateway.circuit,gateway.retry`.

`chaos-suite.mjs` needs the same explicit choices as the drivers it runs: `--approve` (C1 is
read-only, so `none` is the safe value: a denial only blocks a command the task does not need) and
the lab repository (`--repo` or `KEIKO_LAB_REPO`). When a client goes away (LiteLLM's own timeout,
a stopped run) the proxy ends the call: it destroys the upstream request and clears the fault's
timers, so a held call is never forwarded late and never keeps a socket open.

## Measuring the per-turn cost of an AGENTS.md (T13)

The repository-instructions loader attaches the repository's root `AGENTS.md` to the first message
of every run, cut at a line boundary to 16 KiB (about 4,000 tokens), and the first message is
re-sent with every model turn, so a long file is paid for on every turn
([ADR-0137](../../adr/ADR-0137-server-owned-coding-runtime-contracts.md), D1). The lab's own file
is 816 bytes. T13 repeats the read-only text of C1 on the `head+md` baseline, whose file is
30,621 bytes, so the only difference between the two runs is the attached block.

```bash
node scripts/testing/coding-workbench-lab/wb-run.mjs --task-id C1 --approve none        # on the head baseline
# make a second copy with head-md.patch applied (step 5), point KEIKO_LAB_REPO at it, then:
node scripts/testing/coding-workbench-lab/wb-run.mjs --task-id T13 --approve none
node scripts/testing/coding-workbench-lab/turn-profile.mjs run-<digits>                  # for each run
```

`turn-profile.mjs` prints the `coding-runtime.repository-instructions.context` line of the run
above the table: the state (`attached` for C1, `truncated` for T13), the bytes attached against the
file's total and `estimatedTokens`, the loader's estimate of the block. Compare the `prompt` cell of
turn 1 of both runs: the provider-reported prompt tokens of T13 exceed C1's by about that estimate
(the loader's estimator is not the model's tokenizer, so expect the same order of magnitude, not the
same number), and every later turn carries the block again. `run-summary.mjs` gives the cumulative
prompt tokens. Compare equal turn counts: a model run is not deterministic, so a run that took more
turns has re-sent the block more often. Turn 1 is the clean measurement: the block ends with a
marker that tells the model to read the file for the rest, and a run that follows it (a
`workspace.read` of `AGENTS.md` among the tools of a turn) carries the rest of the file in every
later turn, so those turns are not comparable with C1's.
`KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` on the dev server switches the loader off,
which gives the third data point (no block at all).

## Limits of this reproduction

- A model is not deterministic: two runs of one task differ in their transcripts. Compare outcomes
  (settled state, edits applied, verification result, cumulative prompt tokens), not wording.
- Latency, stalls and the 131,072-token window depend on the model server and its hardware; the
  chaos proxy reproduces peak-load faults at the HTTP level, not a server's memory behaviour.
- The lab qualifies the Gemma-through-LiteLLM shape; it does not certify other models, and the dev
  lane's `functional-not-platform-qualified` evidence class is not a platform qualification.
- Wording marked _proposed_ in the task suite has not been run yet; the ledger records the head and
  the outcome of every run that is.
