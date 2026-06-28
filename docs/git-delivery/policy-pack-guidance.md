# Governed Git Delivery Policy-Pack Guidance

Policy packs are trusted server-side data consumed by the pure `evaluateGitPolicy` evaluator. The client
may request an action, but it does not author the policy result. A pack should be explicit, deny by
default where possible, and use typed constraints instead of prose rules.

The examples below use the contract shape from `packages/keiko-contracts/src/git-delivery-policy.ts`.
They are illustrative configuration guidance, not a committed runtime config file.

## Authoring rules

- Use `defaultRule: { "decision": "blocked" }` when a deployment should fail closed for unlisted
  actions.
- Prefer branch-pattern constraints over operator instructions for protected/shared targets.
- Use `approval-gated` for actions a human may permit case by case.
- Use `constrained` when the action can proceed automatically only inside explicit typed bounds.
- Keep force push blocked unless a future governed force-push feature adds separate controls.

## Example 1: strict protected-branch governance

Use this mode for regulated repositories where all shared branch movement should be review-visible and
merge is a release decision.

```json
{
  "schemaVersion": "1",
  "repoId": "regulated-repo",
  "rules": [
    {
      "actionKind": "branch-create",
      "decision": "allowed"
    },
    {
      "actionKind": "stage",
      "decision": "allowed"
    },
    {
      "actionKind": "unstage",
      "decision": "allowed"
    },
    {
      "actionKind": "commit",
      "decision": "allowed"
    },
    {
      "actionKind": "push",
      "decision": "constrained",
      "constraints": [
        {
          "kind": "risk-class-ceiling",
          "maxRiskClass": "publish"
        },
        {
          "kind": "branch-pattern",
          "patterns": [
            {
              "matchKind": "prefix",
              "value": "feat/"
            },
            {
              "matchKind": "prefix",
              "value": "fix/"
            },
            {
              "matchKind": "prefix",
              "value": "chore/"
            },
            {
              "matchKind": "prefix",
              "value": "docs/"
            }
          ]
        }
      ]
    },
    {
      "actionKind": "pr-create",
      "decision": "constrained",
      "constraints": [
        {
          "kind": "branch-pattern",
          "patterns": [
            {
              "matchKind": "exact",
              "value": "dev"
            },
            {
              "matchKind": "prefix",
              "value": "release/"
            },
            {
              "matchKind": "prefix",
              "value": "feat/"
            }
          ]
        }
      ]
    },
    {
      "actionKind": "pr-update",
      "decision": "approval-gated",
      "requiredApprovers": ["release-owner"]
    },
    {
      "actionKind": "merge",
      "decision": "approval-gated",
      "requiredApprovers": ["release-owner"]
    }
  ],
  "defaultRule": {
    "decision": "blocked"
  }
}
```

Operational effect:

- local branch, stage, unstage, and commit are self-service;
- push is limited to safe namespaces and the publish risk class;
- PR base targets are constrained;
- merge requires explicit approval and provider readiness.

## Example 2: developer self-service publish

Use this mode for teams that permit feature-branch publishing without review, while still preventing
direct shared-branch pushes and force push.

```json
{
  "schemaVersion": "1",
  "repoId": "self-service-repo",
  "rules": [
    {
      "actionKind": "branch-create",
      "decision": "allowed"
    },
    {
      "actionKind": "stage",
      "decision": "allowed"
    },
    {
      "actionKind": "unstage",
      "decision": "allowed"
    },
    {
      "actionKind": "commit",
      "decision": "allowed"
    },
    {
      "actionKind": "push",
      "decision": "constrained",
      "constraints": [
        {
          "kind": "risk-class-ceiling",
          "maxRiskClass": "publish"
        },
        {
          "kind": "branch-pattern",
          "patterns": [
            {
              "matchKind": "prefix",
              "value": "feat/"
            },
            {
              "matchKind": "prefix",
              "value": "fix/"
            },
            {
              "matchKind": "prefix",
              "value": "codex/"
            }
          ]
        }
      ]
    },
    {
      "actionKind": "pr-create",
      "decision": "allowed"
    },
    {
      "actionKind": "pr-update",
      "decision": "allowed"
    },
    {
      "actionKind": "merge",
      "decision": "approval-gated",
      "requiredApprovers": []
    }
  ],
  "defaultRule": {
    "decision": "blocked"
  }
}
```

Operational effect:

- normal branch publish is low-friction;
- protected/shared branch push still blocks through branch-pattern and force-push risk ceiling;
- merge still requires a final approval, even if PR metadata is self-service.

## Example 3: audit-heavy review workflow

Use this mode when every remote-facing action requires a review checkpoint.

```json
{
  "schemaVersion": "1",
  "repoId": "audit-heavy-repo",
  "rules": [
    {
      "actionKind": "branch-create",
      "decision": "allowed"
    },
    {
      "actionKind": "stage",
      "decision": "allowed"
    },
    {
      "actionKind": "unstage",
      "decision": "allowed"
    },
    {
      "actionKind": "commit",
      "decision": "allowed"
    },
    {
      "actionKind": "push",
      "decision": "approval-gated",
      "requiredApprovers": ["delivery-reviewer"]
    },
    {
      "actionKind": "pr-create",
      "decision": "approval-gated",
      "requiredApprovers": ["delivery-reviewer"]
    },
    {
      "actionKind": "pr-update",
      "decision": "approval-gated",
      "requiredApprovers": ["delivery-reviewer"]
    },
    {
      "actionKind": "merge",
      "decision": "approval-gated",
      "requiredApprovers": ["release-owner", "delivery-reviewer"]
    }
  ],
  "defaultRule": {
    "decision": "blocked"
  }
}
```

Operational effect:

- local preparation remains productive;
- every remote-facing state change is approval-held until the named reviewer role approves;
- merge requires release and delivery review.

## Diagnosis checklist

- If an action returns `no-applicable-rule`, add an explicit rule or default rule for the intended mode.
- If an action returns `policy-pack-blocked`, inspect org and repo packs. Either level can tighten.
- If a constrained action blocks, inspect the typed constraint: branch pattern, provider capability, or
  risk-class ceiling.
- If an approval-gated action returns `approval-required`, approval is missing or expired; no mutation
  has run.
- If a merge blocks after policy approval, inspect readiness rather than policy. Checks, approvals,
  conflicts, merge queue, and provider policy are readiness facts.
