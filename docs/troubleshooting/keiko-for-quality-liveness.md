# Recover Keiko for Quality liveness

This runbook is for repository owners and operators diagnosing a stalled `Keiko for Quality`
(KFQ) pull-request verdict. It applies only when the live `dev` branch protection lists KFQ as a
required check and `enforce_admins` is `false`; it does not change branch protection or authorize
an agent to bypass it.

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| Severity          | High                                               |
| Surface           | Workflows                                          |
| Stable identifier | `Current-head evidence age: unavailable (missing)` |

## Symptom

The KFQ check is pending, its dashboard comment is older than the pull request's current head, or
the comment reports `Current-head evidence age` as `unavailable (missing)`. A pull request that is
otherwise healthy cannot merge because live branch protection requires KFQ.

## Root Cause

KFQ fails closed: absent, stale, malformed, or still-settling Qodo evidence remains pending rather
than being reported as successful. The dashboard binds an evaluation to a head SHA and exposes only
redacted timing metadata. A delayed or lost webhook, an unavailable evaluator, or missing
current-head review evidence can therefore leave the check pending.

The Worker recovers delivery liveness without treating stale evidence as current. Its two-minute
sweep re-evaluates never-evaluated, pending, and head-changed pull requests. It also re-evaluates a
settled, unchanged pull request when its last evaluation reaches `RECONCILE_BACKSTOP_MS` (15
minutes by default). A webhook normally carries same-head evidence changes; the sweep is the
backstop for lost or rejected events. The Action proof of concept is diagnostic only until its
documented cutover: it is not the canonical recovery path before then.

## Diagnostic Steps

1. Verify the mutable live protection state before relying on the conditional escape:

   ```bash
   gh api "repos/<owner>/<repository>/branches/<protected-branch>/protection" \
     --jq '{enforce_admins: .enforce_admins.enabled, required_checks: [.required_status_checks.checks[] | {context, app_id}]}'
   ```

   Replace every angle-bracketed value with the incident repository's identifiers. Continue only
   when `enforce_admins` is `false` and exactly one `Keiko for Quality` entry is pinned to the
   installed KFQ GitHub App for that repository. Otherwise, the admin escape described here is not
   verified; stop and use the current protection policy. Protection is mutable, so this live
   preflight is required at incident time.

2. Open the pull request and compare the short SHA in the dashboard's `Last evaluated head` row
   with the current head shown by GitHub for the pull request. If they differ, the verdict is stale
   and must not be accepted.
3. Read `Last evaluated` and `Current-head evidence age` in the same dashboard. A timestamp that
   does not advance after the recovery windows below, or an age marked unavailable, identifies an
   evaluator or evidence-lane problem rather than a successful verdict.
4. Confirm that the 13 direct checks remain present and inspect their own checks UI separately.
   KFQ bridges Qodo evidence; it is not evidence that those direct checks passed.
5. Wait for one two-minute reconciliation sweep after a pending or changed-head state. For a
   settled unchanged head, allow the 15-minute default backstop. A Qodo comment or an eligible
   check event should re-evaluate sooner; its absence after the sweep indicates webhook/event
   recovery is not completing.
6. If the Action proof of concept is enabled for diagnosis, an owner can request an explicit
   evaluation of the pull request:

   ```bash
   gh workflow run <kfq-diagnostic-workflow> \
     --ref <protected-branch> \
     -f pr=<pull-request-number>
   ```

   Inspect the resulting run and compare its redacted dashboard/check output with the canonical
   producer. Before cutover, this dispatch neither repairs nor replaces the canonical Worker check.
   It must not be used to claim that the required check is healthy.

Do not copy review bodies, source URLs, tokens, webhook payloads, or private run logs into an
incident record. Record pull-request number, head SHA, normalized timestamps, check state, event
type, and redacted error category only.

## Resolution

1. Preserve the failed state while the automatic path recovers. Trigger or await the relevant
   Qodo/comment or check event, then allow the two-minute sweep and, where applicable, the
   15-minute settled-head backstop. Repair webhook delivery or evaluator configuration at the
   owning runtime, then verify that the dashboard's evaluated head matches the pull request's
   current head and that its timestamp advances.
2. If recovery does not occur and an owner determines that KFQ is unavailable, unbounded, or
   self-deadlocked, the owner may explicitly authorize the narrow ADR-0135 D7 escape. Before use,
   re-check repository administrators and custom roles with `bypass branch protections`; GitHub's
   `enforce_admins=false` exemption is role-based, not intrinsically limited to one owner or KFQ.
   Stop if the authorized actor or bypass scope is ambiguous. The owner may use GitHub's
   administrator override for that pull request only after confirming all 13 direct, app-bound
   checks are green on the exact current head.
3. Before the override, create a redacted incident record naming the pull request, current head,
   KFQ state, last-evaluated timestamp or missing value, attempted recovery, the owner granting the
   exception, and the exact temporary protection effect. Keep all 13 direct checks required. Do
   not direct-push to `dev`, force-push, dismiss a finding, waive a failed direct check, or broaden
   the override to other pull requests or actors.
4. Land the durable evaluator, webhook, workflow, or policy repair through a normal pull request.
   Restore the normal KFQ protection behaviour once the canonical producer emits a current-head
   verdict and the documented negative and positive probes pass. Close the incident with the
   restoration evidence; the override is not a permanent operating mode.

This conditional procedure applies the control-plane recovery constraints from
[ADR-0135 D7](../adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) to the live state
verified in the preflight; it does not change branch-protection policy. It also preserves the Action
cutover boundary in [ADR-0142](../adr/ADR-0142-keiko-for-quality-github-action-execution-shell.md),
the Qodo-only scope in [ADR-0143](../adr/ADR-0143-keiko-for-quality-narrowed-to-the-qodo-bridge.md),
the [KFQ quality-gate policy](../qa/keiko-for-quality.md), and the
[KFQ runtime README](../../infrastructure/keiko-for-quality/README.md).
