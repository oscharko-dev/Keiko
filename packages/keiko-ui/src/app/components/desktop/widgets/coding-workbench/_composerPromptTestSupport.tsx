import { screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { vi, type Mock } from "vitest";
import type {
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import type { FilesSearchResponse } from "@/lib/types";

import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";

// Shared fixtures of the composer's prompt-input suites (ADR-0137 D10): the `@` file picker, the
// `/` command menu and Send now / Queue all render the same composer with the same props.

const MODEL: ModelCapability = {
  id: "gpt-5.4",
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: true,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "standard",
  preferredUseCases: ["Coding"],
  knownLimitations: [],
  reasoningEfforts: [],
};

export const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;
export const ROOT = "/work/space";
export const ENABLED = { delivery: true, references: true } as const;
export const WITH_COMMANDS = { delivery: true, references: true, commands: true } as const;

export type ComposerProps = Parameters<typeof TaskStartSection>[0];

type Fn<K extends keyof TaskComposerActions> = NonNullable<TaskComposerActions[K]>;

export interface ActionMocks extends TaskComposerActions {
  readonly onStart: Mock<Fn<"onStart">>;
  readonly onPause: Mock<Fn<"onPause">>;
  readonly onResume: Mock<Fn<"onResume">>;
  readonly onSend: Mock<Fn<"onSend">>;
  readonly onDeliver: Mock<Fn<"onDeliver">>;
  readonly onStop: Mock<Fn<"onStop">>;
}

export function actions(): ActionMocks {
  return {
    onStart: vi.fn<Fn<"onStart">>(),
    onPause: vi.fn<Fn<"onPause">>(),
    onResume: vi.fn<Fn<"onResume">>(),
    onSend: vi.fn<Fn<"onSend">>(),
    onDeliver: vi.fn<Fn<"onDeliver">>(),
    onStop: vi.fn<Fn<"onStop">>(),
  };
}

export function props(
  runState: CodingWorkbenchRuntimeStateName,
  taskActions: TaskComposerActions,
  overrides: Partial<ComposerProps> = {},
): ComposerProps {
  return {
    taskIntent: "",
    onTaskIntentChange: vi.fn(),
    actions: taskActions,
    canStart: true,
    canResume: true,
    runState,
    mutationPending: false,
    startBusy: false,
    startBlockedReason: null,
    projectMemoryEnabled: true,
    onProjectMemoryEnabledChange: vi.fn(),
    autonomyMode: "supervised-coding",
    autonomyLabel: "Supervised workspace",
    requestedMode: "supervised-coding",
    runtimePreference: "managed-gateway",
    configurationLocked: runState !== "idle",
    onRequestedModeChange: vi.fn(),
    onRuntimePreferenceChange: vi.fn(),
    models: [MODEL],
    selectedModelId: MODEL.id,
    reasoningEffort: null,
    onSelectedModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    offeredAgents: ["build"],
    agent: "build",
    agentLocked: false,
    onAgentChange: vi.fn(),
    ...overrides,
  };
}

/** The composer with a real draft, as the window keeps it, so mentions and chips follow the text. */
export function Harness(inputProps: {
  readonly runState: CodingWorkbenchRuntimeStateName;
  readonly taskActions: TaskComposerActions;
  readonly initialDraft?: string;
  readonly overrides?: Partial<ComposerProps>;
  /** Renders a button that empties the draft from outside, as a started task does. */
  readonly clearButton?: boolean;
}): ReactNode {
  const [draft, setDraft] = useState(inputProps.initialDraft ?? "");
  return (
    <>
      <TaskStartSection
        {...props(inputProps.runState, inputProps.taskActions, {
          promptInputs: ENABLED,
          referenceRoot: ROOT,
          ...inputProps.overrides,
        })}
        taskIntent={draft}
        onTaskIntentChange={setDraft}
      />
      {inputProps.clearButton === true ? (
        <button type="button" onClick={(): void => setDraft("")}>
          Clear draft from outside {/* i18n-exempt: test-only control that clears the draft */}
        </button>
      ) : null}
    </>
  );
}

export function searchResult(path: string, root = ROOT): FilesSearchResponse["results"][number] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const slash = path.lastIndexOf("/");
  return {
    root,
    path,
    name,
    directory: slash < 0 ? "" : path.slice(0, slash),
    extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : null,
    sizeBytes: 10,
    modifiedAt: 1,
  };
}

// The composer's one textbox, whatever the locale names it.
export const textbox = (): HTMLTextAreaElement =>
  screen.getByRole("textbox") as HTMLTextAreaElement;
