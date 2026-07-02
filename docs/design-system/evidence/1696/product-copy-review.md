# Issue #1696 Product-Copy Review

Scope: update chrome copy written by the UI, not release-note content. Release-note bullets remain
professional English in v1 and are supplied by release-impact metadata.

## Review Principles

- Plain language first: users see whether an update exists, what version is involved, and what action
  is safe next.
- Technical content second: patch notes and logs stay behind collapsed disclosures.
- No vague data-loss warnings: state impact is named only when release-impact/remediation metadata says
  it exists.
- No auto-update framing: every install/remediation action stays explicit and user-confirmed.
- Unsupported installs are not errors: they are a manual-update path with calm instructions.

## State Review

| State           | Copy Reviewed                                                                                                           | Decision                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Normal update   | `Update available`, `Current {current} -> target {target}`, `Review the state impact, then install when you are ready.` | Pass - states availability and action without implying automatic install.                      |
| No update       | `Keiko is up to date`, `No update is available. You can check again at any time.`                                       | Pass - clear no-action messaging.                                                              |
| Critical update | `Critical update available` with alert treatment and visible target-version body copy.                                  | Pass - warning is textual and not color-only; no forced install language.                      |
| Manual/blocked  | `Manual update path` plus install-mode instructions.                                                                    | Pass - avoids presenting unsupported local checkout/package-manager cases as runtime failures. |
| Remediation     | `Follow-up after install`, `Follow-up action`, affected feature labels, and `Run action` / `Defer`.                    | Pass - previews required follow-up before install and exposes actions only after install.      |
| Progress        | `Preparing update` / `Installing update` with a native progress label.                                                  | Pass - status is accessible and does not expose command logs by default.                       |
| Restart         | `Restart required` and `I restarted Keiko`.                                                                             | Pass - separates package install from post-restart verification.                               |
| Failure         | `Update failed`, retry when retryable, technical details collapsed.                                                     | Pass - states failure without leaking raw logs in primary copy.                                |
| Success         | `Update installed` and post-update check action.                                                                        | Pass - terminal state is clear and non-technical.                                              |

## Dispositions

- Keep `Install update` as the primary CTA for one-click-eligible updates because the surrounding copy
  states review-before-install and no automatic update occurs.
- Keep `Run action` for remediation v1 because action rows carry the specific remediation message after
  install. If future rows contain multiple action kinds in one viewport, revisit with action-specific
  button labels.
- Keep technical detail labels short (`Registry`, `Release metadata`, `Install mode`, `Remediation`) so
  logs remain secondary and scannable.
