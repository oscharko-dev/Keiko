# Gitar review policy

## Purpose

Gitar is an independent advisory review and repair product for pull requests targeting `dev`. It is
not a branch-protection requirement while its plan can pause automatic processing or omit a
current-head check. Direct deterministic required checks, not a raw Gitar approval or aggregate
comment, grant native auto-merge authority.

Every pull request targeting `dev` is assumed to be a large, completed-epic integration PR,
regardless of its observed file count. Review scope and acceptance must therefore be safe for
hundreds of changed files by default; a smaller diff may reduce work only after its complete changed
file inventory has been established.

The GitHub App check named `Gitar` must come from App ID `827041`. The review comment and review
state must come from bot user ID `159877585`. Those identities make advisory evidence attributable;
they do not turn missing vendor output into a merge-blocking product failure.

## Effective organization and repository settings

| Capability             | Core setting               | Rationale                                                                                                      |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Draft processing       | `Skip draft PRs` enabled   | Avoids spending paced automatic processing on intermediate agent heads.                                        |
| Ready-PR processing    | Automatic                  | Every ready `dev` PR receives the Core code review and summary when service pacing permits.                    |
| PR summaries           | Enabled                    | Gives the delivery agent an independent change inventory.                                                      |
| CI failure analysis    | Enabled for GitHub Actions | Uses the Core analysis while deterministic repository checks retain merge authority.                           |
| Unrelated CI retry     | Disabled                   | Avoids relying on a Pro automation or creating repeated CI runs.                                               |
| Merge blocking         | Disabled                   | Gitar availability is unbounded and must not deadlock repository delivery.                                     |
| Auto-approve           | Disabled                   | Core does not include it, and approval is not required by branch protection.                                   |
| `gitar-approved` label | Disabled                   | Avoids presenting advisory orchestration state as merge authority.                                             |
| Gitar auto-merge       | Disabled                   | GitHub native auto-merge is governed by direct required checks.                                                |
| Auto-apply             | Disabled or unavailable    | Core fixes are comment-directed; repository agents normally repair findings through the local-first loop.      |
| `gitar unblock`        | Disabled or unavailable    | A PR author must not bypass an unresolved review finding.                                                      |
| Human authors          | All                        | Every human-authored Keiko PR is in scope.                                                                     |
| Bot authors            | `dependabot`               | Dependency PRs receive Gitar review in addition to Socket and dependency review.                               |
| External integrations  | None                       | Keiko uses GitHub Issues and Projects; Jira, Linear, and Slack would add unneeded external authority and cost. |

The organization custom instructions mirror the binding rules in `AGENTS.md`, the ADRs, and
`.gitar/review/`. Repository files are the durable, reviewable source. Dashboard text is an
immediate bootstrap for open PRs and must not diverge from the checked-in policy.

## Version-controlled Core configuration

- `.gitar/review/*.md` defines Keiko-specific review lenses and includes binding repository
  instructions. The review files carry the former architecture, governance, security, UI, release,
  verification, and coverage checks without requiring Pro user-defined automations.
- `.gitar/config/approve.md` and `.gitar/rules/*.md` are absent because Auto-Approve and
  user-defined checks are Pro features.
- `npm run check:gitar-config` validates the exact Core review file set, rejects Pro-only repository
  surfaces, and requires complete-epic scope, current-head evidence, hard denials, and all former
  review lenses.
- `npm run agent:pre-pr` and the required `Core quality` CI job execute that validator.

## Review lifecycle

1. Review the complete live issue, `AGENTS.md`, applicable ADRs, and current PR head.
2. Keep the PR draft while intermediate heads are pushed. Mark it ready only after the local
   pre-PR gate passes.
3. Request one `gitar review` on the exact final candidate head when automatic processing is paused.
   The accepted delivery agent performs this action; no human handoff is required. A new commit
   invalidates the previous run and requires one fresh request after the local repair loop.
4. Inspect the check, dashboard comment, submitted reviews, and inline threads together. Processing
   success alone is insufficient.
5. Require the dashboard comment to be updated after the current-head check starts and to report
   zero unresolved findings. A dismissed review does not settle a stale or non-zero comment.
6. Review all changed production files that implement critical behavior and every trust boundary.
   A clean summary is not proof that every high-value file was inspected.
7. The delivery agent fixes confirmed findings at the owning layer, adds a failure-first regression
   or boundary test, reruns local gates, and requests one current-head review after the repair push.
8. Direct required checks must pass before native auto-merge; no human review or merge click
   follows.

## `dev` integration pull-request acceptance

Treat every PR targeting `dev` as a large, completed-epic integration PR. Review all changed
production source, migrations, workflows, manifests, public contracts, and tests for critical
behavior before binary evidence, snapshots, lockfiles, or generated artifacts. The review is not
accepted merely because Gitar posts a summary or approval. If service limits prevent complete
inspection of this executable and trust-boundary surface, fail closed and report the unreviewed
files instead of issuing an approval.

Escalate the Gitar integration when any of these conditions occurs:

- no `Gitar` check run is created within a bounded 60-minute observation window after processing
  starts;
- the check is not emitted by App ID `827041` or is missing from the current head;
- the comment is stale, unparseable, or reports unresolved findings;
- Gitar issues a clean verdict despite an unreviewed executable or trust-boundary file;
- Gitar reports success while its current-head dashboard comment still has unresolved findings;
- a risk-based independent review finds a material defect class that Gitar did not inspect;
- automatic processing is paused by plan pacing or a seat/configuration problem.

Do not poll unchanged state indefinitely. Capture the head SHA, check-suite state, check-run count,
comment timestamp, finding count, and review state once per decision point. If the same integration
failure persists after one explicit rerun, report it as a vendor/configuration incident rather than
using the remote PR as an open-ended test loop.

## Safe interaction commands

The following commands are safe when their stated purpose is authorized:

```text
gitar display:verbose
gitar review
gitar fix <bounded finding>
```

`gitar fix` is limited to a concrete finding inside the accepted task and must not widen authority.
The repository agent still owns local reproduction and verification of any resulting commit.
`gitar unblock` remains prohibited. Auto-Apply, Auto-Approve, Merge Blocking, the approval label,
Gitar Auto-Merge, and Pro rules remain disabled.

## Plan boundaries

Core capabilities in use are unlimited code review with version-controlled review instructions, PR
summaries, GitHub Actions failure analysis, comment-directed fixes, the interactive PR agent, and
developer insights. The repository intentionally does not depend on Pro capabilities: Auto-Apply,
Auto-Approve, Merge Blocking, the approval label, Gitar Auto-Merge, unrelated-CI retry,
user-defined checks and automations, third-party integrations, or advanced insights.

Enterprise-only API access, self-hosting, BYOM, SSO/SAML, audit logs, custom integrations, and
unpaced service availability are not assumed. Dashboard state is not an immutable audit log, so
durable configuration requirements also land as reviewed repository changes.
