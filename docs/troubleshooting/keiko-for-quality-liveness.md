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

KFQ fails closed: absent, stale, malformed, unchanged, or still-settling Qodo evidence remains
pending rather than being reported as successful. The dashboard binds an evaluation to a head SHA
and exposes only redacted timing metadata. The app-bound check output also carries a body-free
SHA-256 digest of the Qodo body after all 40-hex commit IDs are normalized. A delayed event, an
unavailable evaluator, missing predecessor evidence, or a vendor edit that rewrites only commit SHAs
can therefore leave the check pending.

Since the ADR-0142 cutover (2026-07-19) the canonical producer is the GitHub Action: recovery is
event-driven. Every completion of a direct required check (`check_run`) and every pull-request
comment (`issue_comment`) re-evaluates the affected pull on the exact current head; per-pull
concurrency serialises overlapping evaluations. There is no cron and no webhook — the canonical
explicit recovery for a stuck check is an owner- or agent-run dispatch:

```bash
gh workflow run keiko-for-quality-action.yml --ref dev -f pr=<number>
```

(The retired Worker's two-minute sweep and `RECONCILE_BACKSTOP_MS` backstop applied to the
Worker era only; the rollback template in `infrastructure/keiko-for-quality/` retains them.)

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
5. Evaluation is event-driven with no scheduled sweep: a new head, a completed direct required
   check, or a pull-request comment should each produce a fresh evaluation within minutes (a
   just-updated Qodo review additionally waits out a short stability window before the verdict
   turns green). If none of those events yields an advancing evaluation, event delivery or the
   workflow itself is failing — inspect the `keiko-for-quality-action.yml` run list for the pull
   request's events before assuming an evaluator defect.
6. Request an explicit evaluation with the canonical recovery dispatch shown above
   (`gh workflow run keiko-for-quality-action.yml --ref dev -f pr=<number>`; safe to repeat,
   serialised per pull request). Inspect the resulting run: it must publish the
   `Keiko for Quality` check on the pull request's exact current head under the KFQ GitHub App
   identity.
   A run that publishes under the GitHub Actions fallback identity indicates the App credentials
   (`KFQ_APP_ID` / `KFQ_PRIVATE_KEY_PKCS8` repository secrets) are missing or invalid — the
   pinned protection context will not accept that check, so repair the secrets rather than
   re-dispatching.
7. Classify digest-chain failures without copying the review body:
   - `prior ... has not been established` means KFQ recorded a pending baseline. Await a genuine
     Qodo production on that head or request `/review`; the normalized digest must change before the
     baseline becomes accepted.
   - `prior ... is missing or unparseable` means the app-bound dashboard points to an evidence head
     whose matching app-bound KFQ check or digest marker cannot be verified. Re-dispatch once to
     exclude transient publication failure; repeated failure is an evaluator/evidence incident.
   - `unchanged from the previously evaluated head` means Qodo changed only normalized-away commit
     references. Request `/review` once. If the digest stays unchanged, treat it as a vendor incident
     rather than advancing or deleting the baseline.

Do not copy review bodies, source URLs, tokens, webhook payloads, or private run logs into an
incident record. Record pull-request number, head SHA, normalized timestamps, check state, event
type, and redacted error category only.

## Resolution

1. Preserve the failed state while the event-driven path recovers. Trigger or await an eligible
   event (a new head, a completed direct required check, a pull-request comment) or run the
   explicit dispatch, then verify that the dashboard's evaluated head matches the pull request's
   current head and that its timestamp advances. Repair event delivery, workflow, or
   App-credential configuration at the owning surface. Never edit the hidden baseline marker or
   synthesize a digest: both are body-free evidence owned by the KFQ App.
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
