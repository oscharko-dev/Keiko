# Git delivery one-use approval state matrix

The surface composes registered Button, Input / field, Card / window, and status-feedback families;
it introduces no new Design System state vocabulary.

| Family | Applicable states | Evidence target |
| --- | --- | --- |
| Button | Default, Hover, Focus, Active, Disabled | Commit, Sync/Push, and Create/Update Pull Request controls; disabled while an approval request or execution is pending. |
| Input / field | Default, Hover, Focus, Active, Selected, Disabled, Loading | Commit subject/body and Pull Request metadata remain editable until the action starts. |
| Card / window | Default, Focus, Loading, Syncing, Conflict | Git window and Pull Request panel; approval expiry/replay/drift is a visible conflict with retry guidance. |
| Feedback / status | Loading, Error, Syncing, Conflict | Issuance failure, consumed-claim failure, policy denial, offline error, and successful terminal outcome. |

## Coding Workbench global-engine coverage

The Workbench preserves its existing class and state contract through collision-safe
`coding-workbench-*` global classes. The relocation reuses the registered families rather than
creating a parallel component or theme layer.

| Workbench family | Preserved states / modes | Governed reuse |
| --- | --- | --- |
| Shell / Card | Default, narrow-container reflow at 820/768/560/390/320 px | Surface, border, radius, shadow, spacing, and text semantic/component tokens. |
| Mode / source options | Default, Focus, Selected, Capped, Disabled | Radio selection, focus ring, inset surface, and feedback tokens. |
| Task input / controls | Default, Hover, Focus, Disabled | Input and Button component tokens with native keyboard behavior. |
| Status / feedback | Loading, Ready, Warning, Error, Unavailable, Awaiting approval, Recovery required | Badge and Feedback tokens; icon/text/shape semantics remain unchanged. |
| Timeline | Default, Focus, Empty, Virtual spacer | Semantic text/border tokens; reduced-motion scrolling remains explicit. |
| Global modes | Light, Dark, High Contrast, reduced motion, forced colors | Existing global token overrides and the preserved forced-colors media rules; no Workbench-specific theme override. |

## Managed OpenCode pending-question matrix

Runtime-provided headers, prompts, option labels/descriptions, and custom answers are transient,
untrusted plain text. They are never emitted into evidence, diagnostics, HTML injection sinks, or
durable Workbench state.

| Surface | Required states / interactions | Deterministic evidence target |
| --- | --- | --- |
| Question card | Loading, Empty, Ready, Error, Offline, Submitting, Stale, Terminal | `data-testid="coding-workbench-questions"` plus `data-question-state`; fixed localized live feedback for every state. |
| Single choice | Default, Hover, Focus, Checked, Disabled | Native radio group in a labelled fieldset; one ordered answer per question. |
| Multiple choice | Default, Hover, Focus, Checked, Disabled | Native checkbox group with visible multiple-selection guidance and deduplicated ordered selections. |
| Custom answer | Default, Hover, Focus, Filled, Disabled | Explicit label associated to a bounded text input; plain-text value only. |
| Answer / reject | Default, Focus, Submitting, Accepted, Rejected / stale | Native buttons; one in-flight mutation; accepted request removed locally; 409/replay state fails closed until refresh. |
| Poll lifecycle | Active, Error retry, Offline retry, Terminal cleanup | Serialized 2-second cadence only while `state=running`; abort signal and timer cleanup on run/terminal/unmount transition. |
| Responsive / modes | 1280px, 768px, 320px; Dark, Light, High Contrast, forced colors, reduced motion | Existing Workbench container queries and global modes; question controls stack below 560px and use system colors under forced colors. Six reviewed browser captures are retained under `browser/`. |

Playwright-ready selectors are content-free: `data-question-state`, `data-question-request-id`,
`data-question-index`, and `data-question-option`. No selector contains prompt or answer text.

Non-applicable by design: a delivery approval claim is never selected, persisted, shown as a reusable
receipt, or inferred from a background/agent action. The existing Coding Workbench runtime approval
control is a separate surface and is not evidence for this matrix.
