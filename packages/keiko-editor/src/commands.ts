/**
 * Editor command catalogue and the pure availability reducer (Issue #1192).
 *
 * Each command declares the host capabilities it needs (a capability maps 1:1 to an optional method
 * on the host port). {@link isCommandAvailable} gates a command on both those capabilities being
 * injected and the command-specific editor state, so the UI can derive an enabled command set
 * deterministically without invoking the host.
 */
import type { EditorCommand, EditorCommandContext, EditorCommandId } from "./command-types.js";

// The identity types live in `command-types.ts` so `host-port.ts` can `import type` them without
// pulling in this runtime catalogue; they are re-exported here so consumers (and the package barrel)
// have a single command-surface entry point.
export type {
  EditorCommand,
  EditorCommandContext,
  EditorCommandId,
  EditorHostCapability,
} from "./command-types.js";

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  { id: "editor.save", title: "Save Document", requiredCapabilities: ["saveDocument"] },
  {
    id: "editor.triggerCompletion",
    title: "Trigger Completion",
    requiredCapabilities: ["provideCompletions"],
  },
  {
    id: "editor.triggerInlineCompletion",
    title: "Trigger Inline Completion",
    requiredCapabilities: ["provideInlineCompletions"],
  },
  {
    id: "editor.acceptInlineCompletion",
    title: "Accept Inline Completion",
    requiredCapabilities: [],
  },
  {
    id: "editor.rejectInlineCompletion",
    title: "Reject Suggestion",
    requiredCapabilities: [],
  },
  { id: "editor.generateTests", title: "Generate Tests", requiredCapabilities: ["generateTests"] },
  {
    id: "editor.runVerification",
    title: "Run Verification",
    requiredCapabilities: ["runVerification"],
  },
  { id: "editor.previewPatch", title: "Preview Patch", requiredCapabilities: ["previewPatch"] },
  { id: "editor.openDiff", title: "Open Diff", requiredCapabilities: ["previewPatch"] },
  { id: "editor.applyPatch", title: "Apply Patch", requiredCapabilities: ["applyPatchReview"] },
  { id: "editor.rejectPatch", title: "Reject Patch", requiredCapabilities: ["applyPatchReview"] },
  { id: "editor.format", title: "Format Document", requiredCapabilities: ["formatDocument"] },
  { id: "editor.find", title: "Find", requiredCapabilities: [] },
  {
    id: "editor.requestContext",
    title: "Request Context",
    requiredCapabilities: ["provideContext"],
  },
] as const;

/**
 * The command-specific editor-state precondition, beyond required capabilities. Commands with no
 * extra precondition map to `true`. Keyed by every {@link EditorCommandId} so the gate stays
 * exhaustive as commands are added.
 */
const STATE_GATES: Readonly<Record<EditorCommandId, (ctx: EditorCommandContext) => boolean>> = {
  "editor.save": (ctx) => !ctx.readOnly && ctx.dirty,
  "editor.triggerCompletion": (ctx) => !ctx.readOnly,
  "editor.triggerInlineCompletion": (ctx) => !ctx.readOnly,
  "editor.acceptInlineCompletion": (ctx) => !ctx.readOnly && ctx.inlineCompletionVisible,
  "editor.rejectInlineCompletion": (ctx) => ctx.inlineCompletionVisible,
  "editor.applyPatch": (ctx) => !ctx.readOnly && ctx.pendingPatchId !== null,
  "editor.rejectPatch": (ctx) => ctx.pendingPatchId !== null,
  "editor.runVerification": (ctx) => ctx.pendingPatchId !== null,
  "editor.generateTests": () => true,
  "editor.previewPatch": () => true,
  "editor.openDiff": () => true,
  // Formatting rewrites the buffer, so it is offered only on an editable document.
  "editor.format": (ctx) => !ctx.readOnly,
  // Find is read-only and always available once the editor is mounted.
  "editor.find": () => true,
  "editor.requestContext": () => true,
};

function hasRequiredCapabilities(command: EditorCommand, ctx: EditorCommandContext): boolean {
  return command.requiredCapabilities.every((capability) =>
    ctx.availableCapabilities.includes(capability),
  );
}

export function isCommandAvailable(command: EditorCommand, ctx: EditorCommandContext): boolean {
  return hasRequiredCapabilities(command, ctx) && STATE_GATES[command.id](ctx);
}

export function availableCommands(ctx: EditorCommandContext): readonly EditorCommand[] {
  return EDITOR_COMMANDS.filter((command) => isCommandAvailable(command, ctx));
}
