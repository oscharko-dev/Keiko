# Keiko for Quality: review models, settings and pair qualification

Operator guide for the model policy of the Pull requests area (Epic #4130, Issue #4137,
[ADR-0182](../adr/ADR-0182-keiko-for-quality-governed-pull-request-review-agent.md) D8). Keiko for
Quality uses two roles, **Reviewer** and **Counter-checker**, each bound to a chat model of your own
gateway. Keiko prescribes no model. This page explains how an operator presets and restricts the
two roles, how a user chooses within those limits, and how a pair is qualified locally.

## Operator configuration

The `review` section of `keiko.config.json` (in Keiko's state directory, beside the gateway
providers) configures the area. Every key is optional.

```json
{
  "review": {
    "enabled": true,
    "reviewerModelId": "<reviewer-model-id>",
    "counterCheckerModelId": "<counter-checker-model-id>",
    "allowedReviewModelIds": ["<reviewer-model-id>", "<counter-checker-model-id>"],
    "lockModelPolicy": false,
    "rulesFilePath": ".keiko/review-rules.md",
    "repositories": {
      "<repository-id>": { "rulesFilePath": "docs/review-rules.md" }
    }
  }
}
```

| Key                               | Default                  | Meaning                                                                                                                                       |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                         | `false`                  | Switches the whole Pull requests area on. While `false`, every `/api/git-review/*` route except `model-policy` answers 404 `REVIEW_DISABLED`. |
| `reviewerModelId`                 | none                     | The Reviewer default. Must name a model inside `allowedReviewModelIds` when an allowlist is set.                                              |
| `counterCheckerModelId`           | none                     | The Counter-checker default, under the same rule.                                                                                             |
| `allowedReviewModelIds`           | none (every model)       | 1 to 64 model ids. Users can only choose, and the recommendation only offers, models in this list.                                            |
| `lockModelPolicy`                 | `false`                  | Users cannot change either role. The operator defaults (or the recommendation) are the only pair a run or qualification may use.              |
| `rulesFilePath`                   | `.keiko/review-rules.md` | The deployment-wide preset of the repository review-rules path.                                                                               |
| `repositories.<id>.rulesFilePath` | none                     | A preset for one repository, addressed by its content-free repository id (`repo_` and 16 hexadecimal digits).                                 |

For unattended deployments, a set environment variable wins over the file value:

| Variable                                | Key                     | Value                      |
| --------------------------------------- | ----------------------- | -------------------------- |
| `KEIKO_REVIEW_ENABLED`                  | `enabled`               | `true` or `false`          |
| `KEIKO_REVIEW_REVIEWER_MODEL_ID`        | `reviewerModelId`       | a model id                 |
| `KEIKO_REVIEW_COUNTER_CHECKER_MODEL_ID` | `counterCheckerModelId` | a model id                 |
| `KEIKO_REVIEW_ALLOWED_MODEL_IDS`        | `allowedReviewModelIds` | comma-separated model ids  |
| `KEIKO_REVIEW_LOCK_MODEL_POLICY`        | `lockModelPolicy`       | `true` or `false`          |
| `KEIKO_REVIEW_RULES_FILE_PATH`          | `rulesFilePath`         | a repository-relative path |

**Invalid values fail closed.** A wrong type, an unsafe model id or path, a default outside the
allowlist, an unknown key or an unreadable switch never stops the gateway from loading and never
falls back to another model. Instead every role is refused with `invalid-operator-value`, an
invalid `enabled` reads as `false` and an invalid `lockModelPolicy` as `true`, and Keiko records one
`review.model-policy.refused` line per invalid key at startup (stage `startup`, the key and whether
it came from the file or the environment). Gateway setup keeps the section exactly as written.

## Resolution, strictest first

1. **Operator**: invalid values refuse everything; the allowlist bounds every choice; a lock fixes
   the pair.
2. **User**: the per-repository selection, stored server-side in
   `<stateDir>/review-settings/<repository-id>.json`, inside the allowlist and never while locked.
3. **Recommendation**: the eligible model with the largest verified context window for the
   Reviewer, then a different eligible model for the Counter-checker. With only one eligible model,
   both roles use it and the policy reports `singleModel: true`.

A model is eligible for a role when it is a configured chat model with verified, current tool
calling, a known (not assumed) context window that fits the role (32,768 tokens for the Reviewer,
16,384 for the Counter-checker) and the coding-safe profile. A model whose conversation readiness is
`false` is temporarily unavailable, not ineligible: it can be saved, but a run waits for it.

The same check runs before every settings write, at every run start and dry run, and before every
pair qualification. A refusal names one closed reason: `not-configured`, `not-tool-capable`,
`tool-verification-stale`, `window-unknown`, `window-too-small`, `not-coding-safe`,
`outside-allowlist`, `policy-locked`, `invalid-operator-value`, `rules-path-invalid`,
`revision-conflict` or `request-invalid`.

## Routes

| Route                                                  | Purpose                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /api/git-review/model-policy?repositoryId=…`      | The resolved roles with their sources, lock and allowlist state, options and pair status.  |
| `GET /api/git-review/settings?repositoryId=…`          | The stored settings document with its revision and the effective rules path.               |
| `PUT /api/git-review/settings?repositoryId=…`          | Saves `reviewerModelId`, `counterCheckerModelId`, `rulesFilePath` (`null` clears a value). |
| `POST /api/git-review/runs` with `"dryRun": true`      | Checks a pair against a target without saving or starting anything.                        |
| `POST /api/git-review/pair-qualifications`             | Qualifies a pair locally (below).                                                          |
| `GET /api/git-review/pair-qualifications/{id}`         | The qualification's state, per-case results and score.                                     |
| `GET /api/git-review/pair-qualifications/{id}/events`  | Body-free progress until the one `settled` frame.                                          |
| `POST /api/git-review/pair-qualifications/{id}/cancel` | Cancels a running qualification.                                                           |

`PUT` accepts `expectedRevision`; a different stored revision answers 409. A rules path must be
portable and repository-relative, without `.` or `..` segments; anything else answers 400
`REVIEW_SETTINGS_INVALID`. While the policy is locked, the operator preset wins over the user value.

## Local pair qualification

A pair that was never measured is shown as `unmeasured`. A customer can qualify an unmeasured pair
locally against Keiko's shipped synthetic seed corpus (nine planted defects and three clean
controls): no customer code is used, and nothing leaves the machine beyond the configured model
gateway calls of the review runs themselves.

```json
POST /api/git-review/pair-qualifications
{ "reviewerModelId": "<reviewer-model-id>", "counterCheckerModelId": "<counter-checker-model-id>" }
```

Each seed case becomes a small Git repository under `<stateDir>/review-qualification/<id>/`, is
reviewed by the real review orchestrator as a `local-range` target and is removed afterwards. The
pair is `seed-qualified` when every required seed is found and `seed-failed` (with the missed seed
classes) otherwise. False alarms on clean controls are reported but do not change the status. A
cancellation, the three-hour deadline or a run that could not be scored ends `cancelled` or
`incomplete` and records no status. One qualification runs at a time.

The status belongs to exactly that pair and the gateway configuration generation it was measured
under: changing either model, changing the gateway configuration or restarting Keiko shows
`unmeasured` again. Seed qualification measures known defect classes; it is not an acceptance
result on your own code.

## Evidence

Every outcome is on the Activity Log without model names, paths or model output:
`review.model-policy.resolved`, `review.model-policy.updated`, `review.model-policy.refused`,
`review.pair-qualification.started`, `review.pair-qualification.case-scored`,
`review.pair-qualification.completed` and `review.pair-qualification.failed`. A qualification's lines
and the `review.run.*` lines of its seed runs share one correlation id:

```bash
keiko support query --correlation-id <correlation-id> --json
```

For refused policies, see the
[troubleshooting entry](../troubleshooting/review-model-policy-refused.md).
