/**
 * The size of one governed patch: the UTF-8 bytes of one unified diff, whichever path carries it.
 * 8 MiB, so normal work such as writing a 66 KB data file is never refused. It is the runaway-model
 * safeguard of every patch path and the ONE place the number is defined; the editor changeset cap
 * (`EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES`), the tool host (`DEFAULT_PATCH_LIMITS`), the harness
 * (`DEFAULT_LIMITS.maxPatchBytes`), the bug-investigation workflow
 * (`DEFAULT_BUG_WORKFLOW_LIMITS.maxPatchBytes`) and the workflow patch scope
 * (`DEFAULT_PATCH_SCOPE_LIMITS.maxPatchBytes`) all derive from it.
 *
 * Owner decisions: 2026-10-28 (#4102) raised the Coding Workbench changeset to 8 MiB; 2026-10-29
 * (#4110, option 2) aligned every other patch path with it through this single constant. Only the
 * per-patch byte bound is shared: changed lines, file counts, context bytes and wall time keep their
 * own limits. A leaf module on purpose: it imports nothing, so any contract can derive from it.
 */
export const GOVERNED_PATCH_MAX_BYTES = 8 * 1_048_576;
