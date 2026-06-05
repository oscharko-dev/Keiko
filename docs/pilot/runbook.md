# Pilot Guide

This guide is for teams validating Keiko before broader rollout.

## Prepare

1. Install Node.js 22 or newer.
2. Install Keiko in the project:

```bash
npm install @oscharko-dev/keiko && npx keiko init && npm run keiko:start
```

(Yarn, pnpm, and npx are also supported; see the [main README](../../README.md) for all package manager options.)

3. Open `http://127.0.0.1:1983`.
4. Complete the first-run model gateway setup in Settings.
5. Confirm `.keiko/`, `.env`, and local gateway config files are ignored by version control.

## Run the Pilot

Use a small set of representative repositories and cases.

| Activity        | Expected result                                                     |
| --------------- | ------------------------------------------------------------------- |
| Chat            | Keiko answers with bounded repository context.                      |
| Generate Tests  | Keiko proposes reviewable test changes.                             |
| Investigate Bug | Keiko explains the failure and proposes a fix plus regression test. |
| Explain Plan    | Keiko produces a reviewable plan before changes.                    |
| Verify          | Keiko runs configured checks and records redacted evidence.         |

Keiko selects only configured chat models that pass the gateway smoke test. Keep local gateway configs out of version control.

`keiko gen-tests` and `keiko investigate` print a reviewable report to stdout and do not persist a manifest. Use the UI, `keiko run`, or `keiko verify` when stored evidence is required.

## Review

For each pilot case, record:

- Repository and task description.
- Model selected in the UI.
- Whether the answer or patch was useful.
- Whether the proposed diff was safe and reviewable.
- Verification result.
- Evidence run id, when evidence was produced.

Do not record API tokens, raw credentials, or private runtime logs in shared notes.

## Pass Criteria

Keiko is ready for the next pilot stage when:

- Setup works through the UI without developer assistance beyond installing Node.js and npm.
- At least one configured chat model works for chat and workflows.
- Generated diffs are reviewable and do not bypass local approval.
- Verification output is understandable.
- Evidence is redacted and usable for human review.
- No token or sensitive runtime value appears in UI responses, logs, or evidence.

## Stop Criteria

Stop the pilot and investigate before continuing if:

- Credentials appear in output, logs, or evidence.
- Keiko tries to modify blocked paths.
- The UI exposes provider credentials to the browser.
- A workflow applies changes without explicit user action.
- Verification runs commands outside the selected project boundary.
