// Issue #153 — UI-side metadata catalog for the workflows the Conversation Center can launch
// inline. Kept here (not pulled from `@oscharko-dev/keiko-workflows`) so the UI value-import
// graph stays inside `@oscharko-dev/keiko-contracts` per ADR-0019. The workflow IDs and input
// names mirror UNIT_TEST_WORKFLOW_DESCRIPTOR / BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR; cross-
// surface drift is pinned by chat-workflow-catalog.test.ts (workflow handoff suite).
//
// Each entry carries ONLY the minimum the inline launcher needs:
//   - workflowId          — exact match of the workflows package descriptor id.
//   - label / description — short copy for the picker UI.
//   - prompt              — the textarea label for the single free-text input the user supplies.
//   - placeholder         — example text shown in the textarea.
//   - buildInput          — transforms the workspace path + user text into the workflow input
//                           shape expected by /api/chats/runs. Pure & deterministic.
//
// The launcher path is INTENTIONALLY narrow:
//   - apply is hard-coded to false (AC #4: patch application stays behind the existing gated
//     workflow surfaces in NewWindowDialog / RunWindow; the chat handoff never applies).
//   - shell execution is not exposed (AC #4).
//
// Adding a workflow here is additive; removing one is a small UI change. If keiko-workflows
// ships a new descriptor the team wants in chat, append an entry — do not value-import the
// workflows package.

export interface ChatWorkflowCatalogEntry {
  readonly workflowId: string;
  readonly label: string;
  readonly description: string;
  readonly prompt: string;
  readonly placeholder: string;
  /**
   * Pure transform of (workspaceRoot, freeText) → workflow input. The launcher feeds the
   * resulting object straight into the StartRunInput.input field. Trim is intentional so
   * accidental trailing whitespace from textarea autofill does not change the input
   * fingerprint.
   */
  readonly buildInput: (workspaceRoot: string, text: string) => Record<string, unknown>;
}

export const CHAT_WORKFLOW_CATALOG: readonly ChatWorkflowCatalogEntry[] = [
  {
    workflowId: "unit-test-generation",
    label: "Generate unit tests",
    description:
      "Drafts a reviewable unit-test patch for a target file. Dry-run only from chat — apply from the workflow view.",
    prompt: "Target file (workspace-relative)",
    placeholder: "src/example.ts",
    buildInput: (workspaceRoot, text) => ({
      workspaceRoot,
      target: { kind: "file", filePath: text.trim() },
    }),
  },
  {
    workflowId: "bug-investigation",
    label: "Investigate bug",
    description:
      "Investigates a reported issue and proposes a root-cause hypothesis. Dry-run only from chat.",
    prompt: "Describe the bug",
    placeholder: "The login button does nothing when the form is empty…",
    buildInput: (workspaceRoot, text) => ({
      workspaceRoot,
      report: { description: text.trim() },
    }),
  },
] as const;

export function findChatWorkflow(workflowId: string): ChatWorkflowCatalogEntry | undefined {
  return CHAT_WORKFLOW_CATALOG.find((entry) => entry.workflowId === workflowId);
}
