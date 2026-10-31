# Review Model Policy Troubleshooting

Operator entries for the Keiko for Quality model policy
([operator guide](../git-delivery/pull-request-review-model-policy.md),
[ADR-0182](../adr/ADR-0182-keiko-for-quality-governed-pull-request-review-agent.md) D8).

---

## A review model selection or review start is refused

| Field             | Value                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                         |
| Surface           | Local UI / Model gateway                                                                       |
| Stable identifier | `REVIEW_POLICY_INVALID`, `REVIEW_MODEL_NOT_ALLOWED`, `REVIEW_POLICY_LOCKED`, `REVIEW_DISABLED` |

**Symptom**

Saving a Reviewer or Counter-checker model, a dry run, a review start or a pair qualification is
refused. The JSON body names the code and a closed reason, for example
`{ "error": { "code": "REVIEW_POLICY_INVALID", ... }, "reason": "window-too-small", "role": "reviewer" }`,
or a started review settles `skipped` with reason `policy-invalid`. Every `/api/git-review/*` route
except `model-policy` may also answer 404 `REVIEW_DISABLED`.

**Root Cause**

The review model policy checks the operator configuration first, then the user's selection, then
the model's eligibility, and refuses with the first reason that applies:

- `REVIEW_DISABLED`: the operator's `review.enabled` switch is off (the default until the area is
  released), or its value is invalid.
- `invalid-operator-value`: a key of the operator's `review` section in `keiko.config.json`, or one
  of its `KEIKO_REVIEW_*` overrides, is invalid. Keiko does not fall back to another model.
- `outside-allowlist` (`REVIEW_MODEL_NOT_ALLOWED`) or `policy-locked` (`REVIEW_POLICY_LOCKED`): the
  operator restricts or locks the review models.
- `not-configured`, `not-tool-capable`, `tool-verification-stale`, `window-unknown`,
  `window-too-small`, `not-coding-safe`: the model is not eligible for the role. Tool calling must be
  verified within the last 24 hours, and the context window must be known and large enough.

**Diagnostic Steps**

Read the policy as the server resolves it and the recorded refusals:

```bash
keiko support query --correlation-id <correlation-id> --json
```

Look for `review.model-policy.refused`. Its `reason`, `role` and `stage` name the decision; at stage
`startup`, `operatorKey` and `operatorKeySource` (`file` or `environment`) name the invalid
operator value. `GET /api/git-review/model-policy?repositoryId=<repository-id>` shows each role's
source, state and the options with their tool-calling and context-window facts. If no refusal line
exists, the request did not reach the policy; consult the general entries in this guide instead.

**Resolution**

1. For `invalid-operator-value`, correct the named key in the `review` section of
   `keiko.config.json` or unset the named `KEIKO_REVIEW_*` variable, then restart Keiko.
2. For `REVIEW_DISABLED`, set `review.enabled` to `true` (or `KEIKO_REVIEW_ENABLED=true`) only when
   the area is meant to be available.
3. For `outside-allowlist` or `policy-locked`, choose an allowed model, or ask the operator to
   change `allowedReviewModelIds` or `lockModelPolicy`. Do not remove the restriction merely to
   make a selection pass.
4. For `tool-verification-stale` or `window-unknown`, run the gateway readiness check for the model
   so Keiko verifies tool calling and learns the window again. For `not-tool-capable` or
   `window-too-small`, choose a different model; the review budgets are not lowered.
