# Editor Personalization And Resilience Troubleshooting

This page covers M7 editor settings, workspace-watch recovery, safe snippets, keyboard overrides,
model retention, and governed AI-assist activation. It is operator-facing and intentionally avoids
raw source bodies, prompts, completions, snippets, provider endpoints, credentials, and absolute
workspace roots.

## 1. Editor settings are unavailable or controls are locked

| Field             | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| Severity          | Medium                                                          |
| Surface           | Local UI, editor settings                                       |
| Stable identifier | `STATE_UNAVAILABLE`, `POLICY_LOCKED`, `OPERATOR_CEILING_DENIED` |

**Symptom**

The Editor Settings panel loads built-in defaults, shows a settings error, or marks a control as
locked. AI-assist controls may show policy-denied or explicit-opt-in guidance instead of becoming
active.

**Root Cause**

M7 settings are resolved from server-owned user/workspace records plus deployment policy ceilings.
Keiko fails closed when the private settings record is corrupt, oversized, future-versioned, or when
an operator ceiling denies the feature. User or workspace settings can narrow behavior, but they
cannot widen model, egress, sandbox, patch-apply, budget, or delivery authority.

**Diagnostic Steps**

```bash
# Confirm the local UI is healthy.
keiko status

# Check the UI log for redacted settings route failures.
tail -n 200 .keiko/ui.log
```

In the browser, refresh the Editor Settings panel. A policy-locked setting should remain visible but
disabled with a reason code. A `STATE_UNAVAILABLE` response means the server could not safely read
the private settings store and did not write new state.

**Resolution**

- If the setting is policy-locked, keep the deployment ceiling in place unless an operator explicitly
  intends to permit that feature. For AI assistance, enabling the UI setting is not enough when the
  operator ceiling denies the feature.
- If settings are unavailable after a restart, preserve `.keiko/ui.log` and report the redacted
  reason code. Do not delete private state stores unless a maintainer has identified the affected
  record and confirmed the recovery path.
- Use the Settings panel reset action for ordinary rollback. Reset is revision-guarded and does not
  remove unrelated user or workspace settings.

## 2. Workspace watcher reports rescan required

| Field             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Severity          | Medium                                                             |
| Surface           | Local UI, editor workspace watch                                   |
| Stable identifier | `editor-watch:snapshot-required`, `rescanRequired`, `sequence-gap` |

**Symptom**

The editor or file tree asks for a refresh/rescan, or the watch status reports degraded health after
file changes. The UI remains usable, but external-change state may wait for a snapshot refresh before
claiming the latest disk state.

**Root Cause**

Keiko treats native file watcher ambiguity as a recovery condition instead of guessing. Null native
filenames, event overflow, unsafe path substitutions, root replacement, unavailable native watching,
or a replay sequence gap cause the watcher to emit `rescanRequired` or a snapshot-required event.
This prevents dirty buffers from being overwritten by stale or incomplete disk events.

**Diagnostic Steps**

```bash
# Check for watcher and editor route diagnostics without exposing source content.
tail -n 200 .keiko/ui.log
```

If the status names `sequence-gap`, `event-overflow`, `native-watch-unavailable`, `root-replaced`,
or `unsafe-path`, the watcher is intentionally degraded and needs a fresh snapshot.

**Resolution**

- Use the editor/file-tree refresh action to request a fresh snapshot.
- If the workspace root was renamed, deleted, or recreated, reopen the workspace root from the UI.
- For network filesystems, container bind mounts, or case-folding edge cases, rely on the degraded
  rescan contract. Keiko does not claim strong native-watch guarantees for those mounts.
- Do not bypass dirty-buffer prompts. If a file is dirty in the editor, choose explicitly whether to
  keep the editor buffer or reload the disk version.

## 3. AI assistance is visible but not active

| Field             | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Severity          | Medium                                                                       |
| Surface           | Local UI, editor AI assistance                                               |
| Stable identifier | `EXPLICIT_OPT_IN_REQUIRED`, `MODEL_CAPABILITY_MISSING`, `BUDGET_UNAVAILABLE` |

**Symptom**

Inline completion, test generation, patch apply, or verification appears in Settings with a status
such as available, not configured, model incompatible, budget unavailable, unhealthy, or policy
denied. The feature does not register as an active provider/action or returns a disabled/degraded
response.

**Root Cause**

AI activation is consent and discoverability, not authorization widening. Effective state is the
minimum of product support, operator ceiling, explicit opt-in, model capability, health, budget, and
security prerequisites. Legacy environment flags act as operator ceilings. They do not silently
activate model or mutating behavior during upgrade.

**Diagnostic Steps**

```bash
# Confirm the UI process sees the intended operator environment.
keiko status

# Inspect redacted UI diagnostics for the activation reason code.
tail -n 200 .keiko/ui.log
```

The UI status reason code is the authoritative next step: `EXPLICIT_OPT_IN_REQUIRED` requires a user
or workspace opt-in; `OPERATOR_CEILING_DENIED` requires deployment policy review; model and budget
codes require Model Gateway or budget configuration review.

**Resolution**

- Enable the feature only from Settings after reviewing the confirmation prompt. Mutating features
  remain review-first.
- If the operator ceiling denies the feature, change deployment policy only through the normal
  operator-controlled configuration path and restart if required by that environment.
- If model capability, health, or budget is unavailable, fix the Model Gateway or budget condition.
  Do not route the browser directly to provider SDKs or endpoints.
- Disable the setting to revoke new optional calls immediately. In-flight optional completion is
  allowed to cancel; editor content and active human reviews are preserved.
