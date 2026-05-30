# Customer pilot runbook

Audience: pilot teams, customer model evaluators, and regulated reviewers running Keiko in a Wave 1 pilot. This runbook takes you from a clean machine to a reviewed, evidence-backed workflow run, and sets the expectations a regulated review demands.

Keiko is bounded developer assistance: it proposes reviewable changes and records redacted evidence. It does not merge code. Every diff is reviewed by a person before it reaches a branch.

For the security model behind the controls referenced here, see [Security and audit boundaries](../security-and-audit-boundaries.md). For the pilot decision, see [Go/No-Go criteria](./go-no-go.md).

---

## Contents

- [Prerequisites](#prerequisites)
- [Safe setup](#safe-setup)
- [Model configuration](#model-configuration)
- [CLI workflows](#cli-workflows)
- [SDK workflows](#sdk-workflows)
- [Local UI operation](#local-ui-operation)
- [Review expectations](#review-expectations)
- [Evaluation criteria](#evaluation-criteria)
- [Evidence artifacts and retention](#evidence-artifacts-and-retention)
- [Running a multi-day pilot](#running-a-multi-day-pilot)
- [Feedback and escalation](#feedback-and-escalation)
- [Limitations](#limitations)

---

## Prerequisites

- Node.js >= 22 and npm >= 10.
- A configured model gateway: at least one model endpoint the customer hosts or provides, with its credentials. See [Model configuration](#model-configuration).
- For the local UI: a current Chromium, Firefox, or Safari. See the [local UI runbook](../ui-runbook.md).

Keiko has zero runtime dependencies. Install it with `npm install keiko`.

---

## Safe setup

Start in dry-run, credential-free territory and add credentials only when you reach a model-backed step. Nothing in steps 1–3 contacts a model or writes to your tree.

1. **Confirm the install and the model registry.** No credentials needed:

   ```bash
   keiko models list
   ```

   This prints the registered models and their declared capabilities. It never reads or prints credentials.

2. **Validate your gateway configuration** once you have a config file:

   ```bash
   keiko models validate --config ./keiko.config.json
   ```

   Exit `0` means the structure is valid. The command reports structural errors without printing any configured value.

3. **Inspect what the workspace layer would read** — dry-run by construction:

   ```bash
   keiko context --dir .
   ```

   The summary is redacted. Secret-shaped files (`.env`, keys, `.git/`) are never read. Review the counts and source/test directories to confirm Keiko sees the project you expect.

Only after these pass should you run a model-backed workflow.

---

## Model configuration

Keiko reads credentials from environment variables or a JSON config file, never from CLI flags. Precedence, first match wins:

1. Per-model environment variables: `KEIKO_MODEL_<UPPER_MODEL_ID>_API_KEY` / `_BASE_URL`, where `<UPPER_MODEL_ID>` is the model id with every non-alphanumeric character replaced by `_` and uppercased (for example `gpt-oss-120b` → `KEIKO_MODEL_GPT_OSS_120B_API_KEY`).
2. Config-file value for that model's `apiKey` / `baseUrl`.
3. Global fallback: `KEIKO_DEFAULT_API_KEY` / `KEIKO_DEFAULT_BASE_URL`.

Live model CLI surfaces (`keiko models validate`, `keiko gen-tests`, `keiko investigate`, and `keiko evaluate --live`) read a config only from `--config PATH` or `KEIKO_CONFIG_FILE`. `keiko ui` requires `--config PATH` for model-backed workflow runs. Keiko does not implicitly trust `./keiko.config.json` from the target repository. Provider `baseUrl` values must use `https:` unless they target `localhost` or loopback for local development.

See the README's [Configuration and secrets](../../README.md#configuration-and-secrets) section and `.env.example` for the full set of variable names.

Which model to use for which workflow is a deliberate choice. The two Wave 1 workflows produce structured diffs and should be routed to a model with both tool-calling and reliable structured output; this is operator routing guidance, not a runtime guard in the default selector. The [model capability guide](./model-capability-guide.md) maps the pilot portfolio to roles and flags the models that are unfit (`Qwen2.5-Coder-7B-Instruct`, whose `structuredOutput` is false) or not callable in Wave 1 (the OCR and embedding models).

---

## CLI workflows

The discipline is the same for both workflows: **dry-run, review the diff, optionally apply, then verification runs automatically.**

### Generate unit tests

Dry-run (writes nothing):

```bash
keiko gen-tests --file src/add.ts
```

Expected output: a Markdown report (status `dry-run`, covered behavior, known gaps, next actions), followed by the redacted validation summary and the proposed test patch. Read the diff. If it is sound, apply it:

```bash
keiko gen-tests --file src/add.ts --apply
```

Apply writes the test file and runs verification through the safe tool and verification layers. The report status becomes `completed` and carries a verification summary. The generated patch may only create or modify test files; a patch touching a non-test path is rejected.

### Investigate a bug

Dry-run (writes nothing):

```bash
keiko investigate --description "login returns 500 on empty password"
```

You can supply richer evidence from files to keep the command line small:

```bash
keiko investigate --output-file ./fail.txt --stack-file ./trace.txt --file src/auth.ts
```

Expected output: a report that separates **verified findings** (failure frames the tool parsed, whether the patch validates) from the model's **unverified hypothesis** (root cause, regression-test strategy, confidence), followed by the proposed fix diff. Treat the hypothesis as a lead to check, not a conclusion. If the fix is sound, apply it:

```bash
keiko investigate --description "login returns 500 on empty password" --apply
```

Apply writes the fix and runs verification. A fix touching a sensitive path (`.git/`, `.github/`, `.husky/`, lockfiles) is rejected. When no fix is warranted, the workflow returns `investigation-only` with the hypothesis and no diff.

### Run the gates directly

To run the project's own gates and get a redacted summary:

```bash
keiko verify --dir .
```

Expected output: an overall status line and a per-gate table (kind, status, exit code, duration). Exit `0` only when every gate passes.

### Inspect evidence

`keiko gen-tests` and `keiko investigate` print a reviewable report to stdout and do not persist a manifest. Persisted evidence comes from `keiko run`, workflow runs launched from the local UI, and `keiko evaluate` (offline and live). Inspect persisted manifests with:

```bash
keiko evidence list
keiko evidence show <runId>
```

Expected output: `list` prints one row per run (run id, task type, outcome, start/finish). `show` prints the redacted manifest for one run. See [Evidence artifacts and retention](#evidence-artifacts-and-retention).

---

## SDK workflows

The SDK exposes the same workflows for programmatic use, with the same dry-run default. `detectWorkspace` and `loadConfigFromFile` are synchronous and take a path. Full, runnable examples are in the README's [SDK usage](../../README.md#sdk-usage) section; the shapes below show the evidence-aware pattern.

Generate tests and persist evidence:

```typescript
import {
  generateUnitTests,
  Gateway,
  GatewayModelPort,
  loadConfigFromFile,
  createNodeEvidenceStore,
  listEvidence,
} from "keiko";

const config = loadConfigFromFile("./keiko.config.json", process.env);
const model = new GatewayModelPort(new Gateway(config));

const report = await generateUnitTests(
  {
    workspaceRoot: ".",
    target: { kind: "file", filePath: "src/add.ts" },
    modelId: config.providers[0].modelId,
    // apply defaults to false (dry-run)
  },
  { model },
);
console.log(report.status, report.proposedDiff);

// Evidence written by the CLI run path is readable through the store.
const store = createNodeEvidenceStore("./.keiko/evidence");
for (const entry of listEvidence(store)) {
  console.log(entry.runId, entry.taskType, entry.outcome);
}
```

`investigateBug` follows the same shape with a `report` input (`{ description, failingOutput, stackTrace, targetFiles }`) and returns a report with the verified/hypothesis split.

---

## Local UI operation

The UI is a single-user, local-only surface that drives the same workflows with the same dry-run discipline and gated apply. Launch it with:

```bash
keiko ui
```

It binds `127.0.0.1`, prints its URL, and runs until you press Ctrl+C.

This runbook does not duplicate UI operation. For launch options, the six surfaces (workflow launch, live run view, patch review, evidence browser, config inspector), troubleshooting, and the accessibility baseline, see the [local UI runbook](../ui-runbook.md).

---

## Review expectations

These are non-negotiable for a regulated pilot.

- **Dry-run first.** Always read the proposed diff before applying. The default output is a diff for exactly this reason.
- **Human review of every diff.** A person reads and approves every change before it is applied and before it reaches a branch. For an investigation, separate the verified findings from the hypothesis and confirm the fix addresses a real cause.
- **No unattended merge.** Keiko never commits, pushes, opens a pull request, or merges. Applying a patch writes to your working tree and runs verification; integrating it is a human action.
- **Evidence for the record.** When audit evidence is required, use a manifest-producing surface (`keiko run`, a local UI workflow run, or `keiko evaluate`) and keep the resulting manifest. Standalone `keiko gen-tests` and `keiko investigate` runs produce reviewable reports and diffs, but they do not persist manifests.

---

## Evaluation criteria

The evaluation harness produces a scorecard, not a verdict. The pilot decision is made by people.

Run the deterministic offline suite (no credentials, no network):

```bash
keiko evaluate
```

Offline mode checks that the workflow machinery, safety guards, and audit pipeline work end-to-end against scripted transcripts. It does **not** measure model quality.

Run live evaluation against a candidate model (opt-in):

```bash
keiko evaluate --live --model <model-id>
```

Live mode fails closed when no credentials resolve; it never silently downgrades to offline. It records evidence manifests linked from the scorecard so a reviewer can inspect real model behavior.

The final Go/No-Go is human-reviewed. See [Go/No-Go criteria](./go-no-go.md) for the offline thresholds (all blockers) and the human live-evaluation review the decision additionally requires.

---

## Evidence artifacts and retention

- **What is written.** `keiko run`, UI workflow runs, and `keiko evaluate` (offline and live) persist an `EvidenceManifest`, redacted at construction. The standalone workflow CLIs (`keiko gen-tests`, `keiko investigate`) do not persist manifests. There is no code path that writes an unredacted manifest.
- **Where.** `$KEIKO_EVIDENCE_DIR` if set, otherwise `.keiko/evidence` under the workspace. Override per command with `--evidence-dir`.
- **How it is written.** Atomically (exclusive-create) into a directory whose real path is verified to be inside the evidence root.
- **Retention.** The newest runs are kept up to a maximum (50 by default); older runs are rotated out by recorded finish time. For a multi-day pilot that needs a longer record, copy manifests to your own retained store, or point `--evidence-dir` at a location your retention policy covers.
- **How to read it.** `keiko evidence list` and `keiko evidence show <runId>`, or the UI evidence browser.

For the storage guarantees and their limits, see [Security and audit boundaries](../security-and-audit-boundaries.md#evidence-storage).

---

## Running a multi-day pilot

A workable shape for a time-boxed pilot:

1. **Setup day.** Complete [Safe setup](#safe-setup) and [Model configuration](#model-configuration) on each operator's machine. Run `keiko evaluate` (offline) and confirm it exits `0`. Decide which model serves which workflow using the [model capability guide](./model-capability-guide.md).
2. **Baseline.** Run `keiko evaluate --live` against the candidate model(s) and review the scorecard and its linked evidence. Record the baseline.
3. **Daily use.** Operators run `gen-tests` and `investigate` in dry-run, review diffs, and apply selectively. For retained audit evidence, route the change through `keiko run`, the local UI workflow path, or `keiko evaluate`.
4. **Retention checkpoint.** Because default retention keeps only the newest 50 runs, copy or relocate evidence at least daily if the pilot generates more than that, so nothing is rotated out before review.
5. **Review checkpoint.** At a set cadence (for example daily), a reviewer reads the day's applied diffs and their evidence, and logs feedback.
6. **Decision.** At the end, run the [Go/No-Go](./go-no-go.md) assessment: confirm the offline thresholds and complete the human live-evaluation review.

Keep the pilot bounded: Wave 1 is two workflows. Resist scope creep into work the workflows do not cover.

---

## Feedback and escalation

- **Collect feedback against evidence.** Tie each piece of feedback to a run id so it is reproducible. A redacted manifest plus the proposed diff is enough for a reviewer to reconstruct what happened.
- **Escalate security-relevant findings immediately.** If a proposed patch tries to touch a sensitive path, if a guard behaves unexpectedly, or if any credential appears in output, stop and report it through the customer's security channel before continuing. These are the boundaries in [Security and audit boundaries](../security-and-audit-boundaries.md); a breach of one is a security event, not a usability note.
- **Separate model-quality feedback from tooling feedback.** "The model's fix was wrong" is model-quality feedback for the Go/No-Go review. "The CLI rejected a valid path" is tooling feedback. Routing them separately keeps the Go/No-Go signal clean.
- **Record what the pilot did not cover.** Edge cases outside the two workflows and the offline fixture set are known gaps, not defects. Note them for a later wave.

---

## Limitations

State these plainly to stakeholders. The full security limits are in [Security and audit boundaries](../security-and-audit-boundaries.md#wave-1-security-limitations).

- **Two workflows.** Wave 1 ships unit-test generation and bug investigation. Nothing else is a workflow yet.
- **Not OS-level isolation.** The sandbox bounds the process environment, not the semantics of allowlisted commands. `npm test` runs repository-authored code with the host's privileges and network access. Run Keiko inside whatever isolation your environment already provides.
- **Offline evaluation is not a quality measure.** A green offline score means the machinery works, not that the model is ready. Only live evaluation, human-reviewed, speaks to model quality.
- **Single-user and local.** No authentication, no cross-user audit, no remote UI. Operating-system file permissions are the access control.
- **OCR and embedding models are Wave 2.** The portfolio registers them, but their methods are not callable by Wave 1 workflows.

---

## Related documents

- [README](../../README.md) — install, full CLI and SDK reference, configuration
- [Security and audit boundaries](../security-and-audit-boundaries.md) — the boundaries behind every control here
- [Go/No-Go criteria](./go-no-go.md) — the pilot decision
- [Model capability guide](./model-capability-guide.md) — model-to-workflow mapping
- [Local UI runbook](../ui-runbook.md) — UI launch, surfaces, and troubleshooting
