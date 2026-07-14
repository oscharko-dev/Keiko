# Gitar review policy

## Purpose

Gitar is an independent review product and a required, app-bound check for pull requests targeting
`dev`. It reviews and repairs autonomously; the independent `Keiko for Quality` aggregate, not a
human review or raw Gitar approval, grants native auto-merge authority.

Every pull request targeting `dev` is assumed to be a large, completed-epic integration PR,
regardless of its observed file count. Review scope and acceptance must therefore be safe for
hundreds of changed files by default; a smaller diff may reduce work only after its complete changed
file inventory has been established.

The GitHub App check named `Gitar` must come from App ID `827041`. The review comment and review
state must come from bot user ID `159877585`. The Keiko for Quality remains the machine-readable
authority for current-head evidence settlement.

## Effective organization and repository settings

| Capability             | Setting                                                         | Rationale                                                                                                           |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Draft processing       | Enabled; `Skip draft PRs` is off                                | Keiko keeps implementation PRs draft while technical gates settle. Required review must not wait for human handoff. |
| PR summaries           | Enabled                                                         | Gives reviewers an independent change summary.                                                                      |
| Unrelated CI retry     | Enabled; once per commit                                        | Uses Pro CI analysis without widening code authority.                                                               |
| Merge blocking         | `Suggestions or higher`                                         | Every unresolved finding remains visible and blocking under the Keiko for Quality contract.                         |
| Auto-approve           | Staged; enabled only after `Keiko for Quality` becomes required | Approval may arm native auto-merge but is never the final gate.                                                     |
| `gitar-approved` label | Enabled with Auto-Approve                                       | Makes orchestration state discoverable; the aggregate remains authoritative.                                        |
| Auto-merge             | Staged; enabled only after `Keiko for Quality` becomes required | GitHub waits for all branch-protection conditions, including the aggregate.                                         |
| `gitar unblock`        | Disabled or unavailable                                         | A PR author must not bypass an unresolved required review finding.                                                  |
| Auto-apply             | Enabled for every `dev` integration PR                          | Gitar repairs findings and attributable CI failures on the PR branch.                                               |
| Human authors          | All                                                             | Every human-authored Keiko PR is in scope.                                                                          |
| Bot authors            | `dependabot`                                                    | Dependency PRs receive Gitar review in addition to Socket and dependency review.                                    |
| External integrations  | None                                                            | Keiko uses GitHub Issues and Projects; Jira, Linear, and Slack automations would add unneeded external authority.   |

The organization custom instructions mirror the binding rules in `AGENTS.md`, the ADRs, and
`.gitar/review/`. Repository files are the durable, reviewable source. Dashboard text is an
immediate bootstrap for open PRs and must not diverge from the checked-in policy.

## Version-controlled Pro configuration

- `.gitar/review/*.md` defines Keiko-specific review lenses and includes binding repository
  instructions.
- `.gitar/config/approve.md` requires a complete current-head review, zero unresolved findings at
  every severity, and no unreviewed executable or trust-boundary file.
- `.gitar/rules/*.md` contains exactly five focused Pro custom checks. The governance rule enables
  autonomous repair on `dev` PR branches; no rule may unblock, force-push, push to `dev`, bypass
  `Keiko for Quality`, or assign an external integration.
- `npm run check:gitar-config` validates the file set, Pro rule ceiling, frontmatter, bounded
  autonomous actions, delivery hard denials, required governance context, and auto-approve safety
  language.
- `npm run codex:pre-pr` and the required `Core quality` CI job execute that validator.

## Review lifecycle

1. Review the complete live issue, `AGENTS.md`, applicable ADRs, and current PR head.
2. Keep Auto-Apply on. Use `gitar display:verbose` when rule evaluation or coverage is uncertain.
3. Require a Gitar run on the exact current head. A new commit invalidates the previous run.
4. Inspect the check, dashboard comment, submitted reviews, and inline threads together. Processing
   success alone is insufficient.
5. Require the dashboard comment to be updated after the current-head check starts and to report
   zero unresolved findings. A dismissed review does not settle a stale or non-zero comment.
6. Review all changed production files that implement critical behavior and every trust boundary.
   A clean summary is not proof that every high-value file was inspected.
7. Auto-Apply fixes confirmed findings at the owning layer, adds a failure-first regression or
   boundary test, reruns local gates, and requests a current-head review.
8. `Keiko for Quality` must pass before native auto-merge; no human review or merge click follows.

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
- Gitar approves a PR that violates `.gitar/config/approve.md`;
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
gitar auto-apply:on
gitar display:verbose
gitar review
```

`gitar auto-apply:off` is an incident stop command. `gitar unblock` remains prohibited. Auto-Merge
is enabled only after `Keiko for Quality` is an app-bound required check and has passed activation
probes.

## Plan boundaries

Core capabilities in use are code review, PR summaries, CI failure analysis, comment-directed
fixes, the interactive PR agent, and developer insights. Pro capabilities in use are Auto-Apply,
merge blocking, unrelated-CI retry, five custom checks, advanced review insights, and, after
aggregate activation, Auto-Approve plus Auto-Merge.

Audit logs, SSO/SAML, API access, self-hosting, BYOM, and unlimited custom rules are Enterprise
features. Their absence must be stated accurately; Pro dashboard state is not an immutable audit
log. Configuration changes that require durable compliance evidence must therefore also land as a
reviewed repository change.
