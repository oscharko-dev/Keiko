import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  CodingWorkbenchAgent,
  CodingWorkbenchMode,
  CodingWorkbenchPromptDelivery,
  CodingWorkbenchPromptReference,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimePromptInputs,
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { CODING_WORKBENCH_TASK_INTENT_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { reportTaskSubmission } from "./codingWorkbenchTaskSubmission";
import { CodingWorkbenchAgentToggle } from "./CodingWorkbenchAgentToggle";
import { FileReferenceChips, FileReferencePopover } from "./CodingWorkbenchFileReferences";
import promptStyles from "./CodingWorkbenchPromptInputs.module.css";
import type { PromptDeliveryNotice } from "./usePromptDeliveryNotice";
import {
  useFileReferencePicker,
  type FileReferencePicker,
} from "./useCodingWorkbenchFileReferences";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
export { PanelTitle } from "./CodingWorkbenchPanelTitle";
export { Timeline } from "./CodingWorkbenchTimeline";
import { Icons } from "../../Icons";
import {
  ComposerShell,
  composerEnterSubmits,
  useComposerAutoGrow,
} from "../../composer/ComposerShell";
import KeikoSelect from "../../KeikoSelect";
import { VoiceDictationButton, VoiceDictationPreviewFromController } from "../../VoiceDictation";
import { OrganicWorkspaceBubble } from "../../EmptyWorkspaceBlob";
// KeikoSelect serves the composer controls; repository and branch selection live directly above
// the composer in the Coding Workbench window.
import { useDictation } from "../../hooks/useDictation";
import { supportsDictation, useVoiceCapability } from "../../hooks/useVoiceCapability";
import { dictationCaptureSupported } from "../../hooks/dictation-recorder";
import { requestGatewayModelCatalogRefresh } from "../shared/gatewaySetupBus";
import styles from "./CodingWorkbenchWindow.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CodingWorkbenchIcon = Icons.codingWorkbench;
const MinimizeIcon = Icons.minimize;
const FwdIcon = Icons.fwd;
const ArrowUpIcon = Icons.arrowUp;
const CubeIcon = Icons.cube;
const BrainIcon = Icons.brain;
const LayersIcon = Icons.layers;

// Only the workbench uses this glyph; retain it behind the workbench's lazy boundary.
function StopIcon({ size }: { readonly size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function WorkbenchWelcome(): ReactNode {
  return (
    <div className={styles.welcome}>
      <OrganicWorkspaceBubble
        accessibleDescription="Keiko"
        centeredLogo
        className={styles.welcomeBubble}
      />
    </div>
  );
}

export interface TaskComposerActions {
  readonly onStart: (draft: string) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  /** A follow-up to a paused run; `references` only when the draft carries `@` files. */
  readonly onSend: (draft: string, references?: readonly CodingWorkbenchPromptReference[]) => void;
  /**
   * A message for the turn that is running: sent into it (`steer`) or behind it (`queue`)
   * (ADR-0137 D10). Absent where the window offers no delivery.
   */
  readonly onDeliver?:
    | ((
        draft: string,
        delivery: CodingWorkbenchPromptDelivery,
        references: readonly CodingWorkbenchPromptReference[],
      ) => void)
    | undefined;
  readonly onStop: () => void;
}

function runtimePreferenceOptions(
  t: CodingWorkbenchTranslate,
): readonly { readonly value: CodingWorkbenchRuntimePreference; readonly label: string }[] {
  return [
    { value: "managed-gateway", label: t("codingWorkbench.source.gateway.label") },
    { value: "codex-subscription", label: t("codingWorkbench.source.codex.label") },
  ];
}

// Each mode names what the native OpenCode profile does in it; the menu shows the one-line summary
// and the control's tooltip carries the whole text, including what no mode ever allows.
function autonomyOptions(t: CodingWorkbenchTranslate): readonly {
  readonly value: CodingWorkbenchMode;
  readonly label: string;
  readonly description: string;
}[] {
  return [
    {
      value: "governed-assist",
      label: t("codingWorkbench.mode.governed-assist.label"),
      description: t("codingWorkbench.mode.governed-assist.short"),
    },
    {
      value: "supervised-coding",
      label: t("codingWorkbench.mode.supervised-coding.label"),
      description: t("codingWorkbench.mode.supervised-coding.short"),
    },
    {
      value: "autonomous-delivery",
      label: t("codingWorkbench.mode.autonomous-delivery.label"),
      description: t("codingWorkbench.mode.autonomous-delivery.short"),
    },
  ];
}

interface TaskStartSectionProps {
  readonly taskIntent: string;
  readonly onTaskIntentChange: (value: string) => void;
  readonly actions: TaskComposerActions;
  readonly canStart: boolean;
  readonly canResume: boolean;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly mutationPending: boolean;
  readonly startBusy: boolean;
  readonly startBlockedReason: string | null;
  /** Retained so `ProjectMemoryToggle` can be re-mounted (currently hidden per owner directive)
   * without a signature change; the composer's context row is not rendered at all right now. */
  readonly projectMemoryEnabled: boolean;
  readonly onProjectMemoryEnabledChange: (enabled: boolean) => void;
  readonly autonomyMode: CodingWorkbenchMode | null;
  readonly autonomyLabel: string;
  readonly requestedMode: CodingWorkbenchMode;
  readonly runtimePreference: CodingWorkbenchRuntimePreference;
  readonly configurationLocked: boolean;
  readonly onRequestedModeChange: (mode: CodingWorkbenchMode) => void;
  readonly onRuntimePreferenceChange: (preference: CodingWorkbenchRuntimePreference) => void;
  readonly models: readonly ModelCapability[];
  readonly selectedModelId: string | null;
  readonly reasoningEffort: ModelReasoningEffort | null;
  readonly onSelectedModelChange: (modelId: string | null) => void;
  readonly onReasoningEffortChange: (effort: ModelReasoningEffort | null) => void;
  /** The primary agents the server offers; the Build | Plan switch shows only for more than one. */
  readonly offeredAgents: readonly CodingWorkbenchAgent[];
  readonly agent: CodingWorkbenchAgent;
  /** True while a turn runs: the agent is fixed for the turn and changes only between turns. */
  readonly agentLocked: boolean;
  readonly onAgentChange: (agent: CodingWorkbenchAgent) => void;
  /**
   * What the server says the run's runtime can do with a prompt's inputs (ADR-0137 D10). Absent
   * offers neither Send now / Queue while a turn runs nor the `@` file picker.
   */
  readonly promptInputs?: CodingWorkbenchRuntimePromptInputs | undefined;
  /** The run's workspace root the `@` picker searches; no root, no picker. */
  readonly referenceRoot?: string | null | undefined;
  /** What the last message sent to the running turn came to; announced beside the composer. */
  readonly deliveryNotice?: PromptDeliveryNotice | undefined;
}

interface TaskComposerController {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly micButtonRef: RefObject<HTMLButtonElement | null>;
  readonly dictation: ReturnType<typeof useDictation>;
  readonly dictationVisible: boolean;
  readonly submitBlocked: boolean;
  readonly submitFeedback: string | null;
  readonly submitFeedbackId: string;
  /** `mode` is set by Send now and Queue; a plain submit lets the run state decide. */
  readonly submit: (mode?: CodingWorkbenchPromptDelivery) => void;
  /** The `@` file picker; inert unless the run offers references and has a workspace root. */
  readonly picker: FileReferencePicker;
  /** Whether Send now and Queue are offered: a turn is running and the runtime takes messages. */
  readonly deliveryEnabled: boolean;
  /** True while a message cannot be sent now: an action is pending or the draft is empty. */
  readonly deliveryBlocked: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onTextChange: (value: string, cursor: number | null) => void;
}

function submitBlockedReason(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
  mode?: CodingWorkbenchPromptDelivery,
): string | null {
  if (input.mutationPending) return t("codingWorkbench.composer.blocked.busy");
  if (input.runState === "running") {
    // Send now and Queue need a message; a plain submit while running still means "pause".
    return mode !== undefined && input.taskIntent.trim().length === 0
      ? t("codingWorkbench.composer.blocked.emptyMessage")
      : null;
  }
  return emptySubmitReason(input, t) ?? unavailableSubmitReason(input, t);
}

function emptySubmitReason(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): string | null {
  if (input.taskIntent.trim().length > 0) return null;
  return input.runState === "paused"
    ? t("codingWorkbench.composer.blocked.emptyFollowUp")
    : t("codingWorkbench.composer.blocked.emptyStart");
}

function unavailableSubmitReason(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): string | null {
  if (input.runState === "paused") {
    return input.canResume ? null : t("codingWorkbench.composer.blocked.pauseDecision");
  }
  if (!input.startBusy && input.canStart) return null;
  return input.startBlockedReason ?? t("codingWorkbench.composer.blocked.notReady");
}

function canDeliver(input: TaskStartSectionProps): boolean {
  return (
    input.runState === "running" &&
    input.promptInputs?.delivery === true &&
    input.actions.onDeliver !== undefined
  );
}

function sendFollowUp(
  input: TaskStartSectionProps,
  draft: string,
  references: readonly CodingWorkbenchPromptReference[],
): void {
  // The historical call stays exactly as it was when the draft references no file.
  if (references.length === 0) input.actions.onSend(draft);
  else input.actions.onSend(draft, references);
}

// A running turn takes a message when the runtime offers it and there is one; Enter on an empty
// draft keeps its older meaning, pausing the run.
function submitRunning(
  input: TaskStartSectionProps,
  draft: string,
  mode: CodingWorkbenchPromptDelivery | undefined,
  references: readonly CodingWorkbenchPromptReference[],
): void {
  if (!canDeliver(input) || draft.trim().length === 0) {
    input.actions.onPause();
    return;
  }
  // A delivered message is a follow-up to the person typing it; the diagnostic kind is the same.
  reportTaskSubmission(draft, input.taskIntent, "follow-up");
  input.actions.onDeliver?.(draft, mode ?? "steer", references);
}

function submitTask(
  input: TaskStartSectionProps,
  displayedDraft: string,
  mode: CodingWorkbenchPromptDelivery | undefined,
  references: readonly CodingWorkbenchPromptReference[],
): void {
  if (input.runState === "running") {
    submitRunning(input, displayedDraft, mode, references);
    return;
  }
  const kind = input.runState === "paused" ? "follow-up" : "start";
  reportTaskSubmission(displayedDraft, input.taskIntent, kind);
  if (kind === "follow-up") sendFollowUp(input, displayedDraft, references);
  else input.actions.onStart(displayedDraft);
}

interface ComposerSubmit {
  readonly submit: (mode?: CodingWorkbenchPromptDelivery) => void;
  readonly submitBlocked: boolean;
  readonly submitFeedback: string | null;
}

function useComposerSubmit(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  picker: FileReferencePicker,
): ComposerSubmit {
  const { onTaskIntentChange, taskIntent } = input;
  const [blockedSubmitAttempted, setBlockedSubmitAttempted] = useState(false);
  const blockedReason = submitBlockedReason(input, t);
  // Send now and Queue are blocked by an empty draft, which a plain submit while running is not.
  const feedbackReason =
    blockedReason ?? (canDeliver(input) ? submitBlockedReason(input, t, "steer") : null);
  const submit = (mode?: CodingWorkbenchPromptDelivery): void => {
    const displayedDraft = textareaRef.current?.value ?? taskIntent;
    if (displayedDraft !== taskIntent) onTaskIntentChange(displayedDraft);
    if (submitBlockedReason({ ...input, taskIntent: displayedDraft }, t, mode) !== null) {
      setBlockedSubmitAttempted(true);
      return;
    }
    setBlockedSubmitAttempted(false);
    submitTask(input, displayedDraft, mode, picker.referencesFor(displayedDraft));
  };
  const feedbackShown = feedbackReason !== null;
  useEffect(() => {
    if (!feedbackShown) setBlockedSubmitAttempted(false);
  }, [feedbackShown]);
  return {
    submit,
    submitBlocked: blockedReason !== null,
    submitFeedback: blockedSubmitAttempted ? feedbackReason : null,
  };
}

function isQueueChord(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing
  );
}

function useComposerPicker(
  input: TaskStartSectionProps,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): FileReferencePicker {
  return useFileReferencePicker({
    enabled:
      input.promptInputs?.references === true &&
      typeof input.referenceRoot === "string" &&
      (input.runState === "running" || input.runState === "paused"),
    root: input.referenceRoot ?? null,
    draft: input.taskIntent,
    onDraftChange: input.onTaskIntentChange,
    textareaRef,
  });
}

// The picker gets a key first (an open list owns the arrows, Enter, Tab and Escape); then
// Ctrl/Cmd+Enter queues while a turn runs; then Enter submits as it always has.
function useComposerKeys(
  picker: FileReferencePicker,
  deliveryEnabled: boolean,
  submit: (mode?: CodingWorkbenchPromptDelivery) => void,
): (event: KeyboardEvent<HTMLTextAreaElement>) => void {
  return (event): void => {
    if (picker.handleKey(event)) return;
    if (deliveryEnabled && isQueueChord(event)) {
      event.preventDefault();
      submit("queue");
      return;
    }
    if (composerEnterSubmits(event)) submit();
  };
}

function useTaskComposerController(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): TaskComposerController {
  const { onTaskIntentChange, taskIntent } = input;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const submitFeedbackId = useId();
  const voiceCapability = useVoiceCapability();
  const dictationVisible = supportsDictation(voiceCapability) && dictationCaptureSupported();
  const insertTranscript = useCallback(
    (text: string): void => {
      onTaskIntentChange(taskIntent.trim().length === 0 ? text : `${taskIntent.trimEnd()} ${text}`);
      textareaRef.current?.focus();
    },
    [onTaskIntentChange, taskIntent],
  );
  const dictation = useDictation({
    onInsert: insertTranscript,
  });
  const picker = useComposerPicker(input, textareaRef);
  const { submit, submitBlocked, submitFeedback } = useComposerSubmit(
    input,
    t,
    textareaRef,
    picker,
  );
  const deliveryEnabled = canDeliver(input);
  const onKeyDown = useComposerKeys(picker, deliveryEnabled, submit);
  useComposerAutoGrow(textareaRef, taskIntent);
  return {
    textareaRef,
    micButtonRef,
    dictation,
    dictationVisible,
    submitBlocked,
    submitFeedback,
    submitFeedbackId,
    submit,
    picker,
    deliveryEnabled,
    deliveryBlocked: input.mutationPending || taskIntent.trim().length === 0,
    onKeyDown,
    onTextChange: picker.track,
  };
}

export function TaskStartSection(input: TaskStartSectionProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const controller = useTaskComposerController(input, t);
  return (
    <form
      className="composer"
      aria-labelledby="coding-workbench-task-title"
      onSubmit={(event): void => {
        event.preventDefault();
        controller.submit();
      }}
    >
      <h3 className="sr-only" id="coding-workbench-task-title">
        {t("codingWorkbench.task.title")}
      </h3>
      <label className="sr-only" htmlFor="coding-workbench-task-intent">
        {t("codingWorkbench.task.instructions")}
      </label>
      <TaskComposerBox input={input} controller={controller} t={t} />
    </form>
  );
}

// The composer keeps its input controls separate from the window's repository and branch selectors.
// The MemoriaViva toggle remains hidden.
// `ProjectMemoryToggle` is kept below (unused) so re-enabling MemoriaViva is a one-line change: add
// a wrapper that renders `<ProjectMemoryToggle input={input} t={t} />` above `TaskComposerBox`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for MemoriaViva re-enable
function ProjectMemoryToggle({ input, t }: ControlProps): ReactNode {
  const enabled = input.projectMemoryEnabled;
  return (
    <button
      className={`${styles.composerContextChip} ${styles.composerMemoryChip}`}
      type="button"
      data-enabled={enabled ? "true" : "false"}
      aria-pressed={enabled}
      aria-label={t(
        enabled
          ? "codingWorkbench.composer.projectMemory.disable"
          : "codingWorkbench.composer.projectMemory.enable",
      )}
      title={t(
        enabled
          ? "codingWorkbench.composer.projectMemory.help.enabled"
          : "codingWorkbench.composer.projectMemory.help.disabled",
      )}
      disabled={input.configurationLocked}
      onClick={(): void => input.onProjectMemoryEnabledChange(!enabled)}
    >
      <BrainIcon size={14} />
      <span>{t("codingWorkbench.composer.projectMemory.label")}</span>
    </button>
  );
}

function TaskComposerBox({ input, controller, t }: ComposerViewProps): ReactNode {
  return (
    <div className="cmp-box">
      <ComposerShell
        id="coding-workbench-task-intent"
        value={input.taskIntent}
        placeholder={t("codingWorkbench.task.placeholder")}
        textareaRef={controller.textareaRef}
        maxLength={CODING_WORKBENCH_TASK_INTENT_MAX_CHARS}
        disabled={input.mutationPending}
        ariaControls={controller.picker.controls}
        onChange={(event): void => {
          input.onTaskIntentChange(event.target.value);
          controller.onTextChange(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event): void =>
          controller.onTextChange(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onKeyDown={controller.onKeyDown}
        aboveInput={<FileReferences controller={controller} t={t} />}
        belowInput={<DictationPreview controller={controller} input={input} t={t} />}
        footer={<ComposerFooter input={input} controller={controller} t={t} />}
      />
    </div>
  );
}

interface ControlProps {
  readonly input: TaskStartSectionProps;
  readonly t: CodingWorkbenchTranslate;
}

interface ComposerViewProps extends ControlProps {
  readonly controller: TaskComposerController;
}

function FileReferences({ controller, t }: Pick<ComposerViewProps, "controller" | "t">): ReactNode {
  return (
    <>
      <FileReferencePopover picker={controller.picker} t={t} />
      <FileReferenceChips picker={controller.picker} t={t} />
    </>
  );
}

// What the last message sent to the running turn came to. A sent or queued message is only news
// while that turn runs; a refused one stays until the next action, because the draft it was
// written in is still there.
function DeliveryNotice({ input, t }: ControlProps): ReactNode {
  const notice = input.deliveryNotice;
  if (notice === undefined || notice === null) return null;
  if (notice !== "failed" && input.runState !== "running") return null;
  return (
    <p
      className={promptStyles.notice}
      role="status"
      data-state={notice === "failed" ? "failed" : "info"}
    >
      {t(`codingWorkbench.composer.delivery.${notice}`)}
    </p>
  );
}

function DictationPreview({ controller, input, t }: ComposerViewProps): ReactNode {
  return (
    <>
      {controller.dictationVisible ? (
        <VoiceDictationPreviewFromController
          controller={controller.dictation}
          onAfterDiscard={() => controller.micButtonRef.current?.focus()}
        />
      ) : null}
      <SubmitBlockedFeedback controller={controller} />
      <DeliveryNotice input={input} t={t} />
    </>
  );
}

function SubmitBlockedFeedback({
  controller,
}: {
  readonly controller: TaskComposerController;
}): ReactNode {
  if (controller.submitFeedback === null) return null;
  return (
    <p className={styles.composerSubmitNotice} id={controller.submitFeedbackId} role="alert">
      {controller.submitFeedback}
    </p>
  );
}

function ComposerFooter({ input, controller, t }: ComposerViewProps): ReactNode {
  return (
    <div className="cmp-bar cmp-bar-compact">
      <ComposerConfigurationControls input={input} t={t} />
      <div className="cmp-bar-main">
        <DictationControl controller={controller} />
        <ComposerControls input={input} controller={controller} t={t} />
      </div>
    </div>
  );
}

function DictationControl({
  controller,
}: {
  readonly controller: TaskComposerController;
}): ReactNode {
  return controller.dictationVisible ? (
    <VoiceDictationButton
      phase={controller.dictation.phase}
      onStart={controller.dictation.start}
      onStop={controller.dictation.stop}
      buttonRef={controller.micButtonRef}
      compact
    />
  ) : null;
}

function ComposerConfigurationControls({ input, t }: ControlProps): ReactNode {
  const selected = input.models.find((model) => model.id === input.selectedModelId);
  const efforts = selected?.reasoningEfforts ?? [];
  // #3563 owner directive: only Keiko Gateway ships today; a Codex-subscription source is not
  // decided yet. Hiding the source dropdown avoids offering a choice that does not exist. The
  // `SourceControl` component below stays defined so re-enabling it is a one-line change once
  // that decision lands (add `<SourceControl input={input} t={t} />` back into this row).
  return (
    <div className={`cmp-bar-model ${styles.composerConfiguration}`}>
      <CodingModelControl input={input} t={t} />
      <ReasoningControl input={input} efforts={efforts} t={t} />
      <AuthorityControl input={input} t={t} />
      <CodingWorkbenchAgentToggle
        agents={input.offeredAgents}
        value={input.agent}
        disabled={input.agentLocked}
        onChange={input.onAgentChange}
      />
    </div>
  );
}

// #3873 live review: the chip ellipsized "gemma-4-31b-it" to "gemma-4-…" and named itself only
// "Coding model". It now grows with the identifier up to a bound (CodingWorkbenchWindow.module.css),
// and its accessible name and tooltip always carry the full identifier of the selected model.
function modelChipNaming(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): { readonly name: string; readonly title: string | undefined } {
  const selected = input.models.find((model) => model.id === input.selectedModelId);
  if (selected === undefined) {
    return { name: t("codingWorkbench.composer.model.label"), title: undefined };
  }
  const name = t("codingWorkbench.composer.model.selected", { model: selected.id });
  return { name, title: name };
}

function CodingModelControl({ input, t }: ControlProps): ReactNode {
  if (input.runtimePreference !== "managed-gateway") return null;
  const options = input.models.map((model) => ({ value: model.id, label: model.id }));
  const naming = modelChipNaming(input, t);
  return (
    <div className={`cmp-model mono ${styles.modelControl}`}>
      <KeikoSelect
        triggerClassName="cmp-model-select"
        triggerTitle={naming.title}
        value={input.selectedModelId ?? ""}
        placeholder={t("codingWorkbench.composer.model.none")}
        ariaLabel={naming.name}
        menuTitle={t("codingWorkbench.composer.model.menu")}
        menuMinWidth={280}
        menuPopoverMinWidth={280}
        menuPlacement="up"
        attached={false}
        disabled={input.configurationLocked}
        mono
        leadingVisual={<CubeIcon size={14} />}
        onOpen={requestGatewayModelCatalogRefresh}
        sections={[{ options }]}
        onValueChange={(value): void => {
          if (input.models.some((model) => model.id === value)) input.onSelectedModelChange(value);
        }}
      />
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for the restore-path
function SourceControl({ input, t }: ControlProps): ReactNode {
  const options = runtimePreferenceOptions(t);
  return (
    <div className={`cmp-model mono ${styles.sourceControl}`}>
      <KeikoSelect
        value={input.runtimePreference}
        ariaLabel={t("codingWorkbench.composer.source.label")}
        menuTitle={t("codingWorkbench.composer.source.menu")}
        menuMinWidth={220}
        menuPopoverMinWidth={220}
        menuPlacement="up"
        attached={false}
        disabled={input.configurationLocked}
        mono
        sections={[{ options }]}
        onValueChange={(value): void => {
          const option = options.find((item) => item.value === value);
          if (option !== undefined) input.onRuntimePreferenceChange(option.value);
        }}
      />
    </div>
  );
}

interface ReasoningControlProps extends ControlProps {
  readonly efforts: readonly ModelReasoningEffort[];
}

function ReasoningControl({ input, efforts, t }: ReasoningControlProps): ReactNode {
  if (efforts.length < 2) return null;
  const options = efforts.map((effort) => ({
    value: effort,
    label: t(`codingWorkbench.composer.effort.${effort}`),
  }));
  return (
    <div className={`cmp-model mono ${styles.reasoningControl}`}>
      <KeikoSelect
        value={input.reasoningEffort ?? ""}
        ariaLabel={t("codingWorkbench.composer.effort.label")}
        menuTitle={t("codingWorkbench.composer.effort.menu")}
        menuMinWidth={180}
        menuPopoverMinWidth={180}
        menuPlacement="up"
        attached={false}
        disabled={input.configurationLocked}
        mono
        leadingVisual={<BrainIcon size={14} />}
        sections={[{ options }]}
        onValueChange={(value): void => {
          const effort = efforts.find((item) => item === value);
          if (effort !== undefined) input.onReasoningEffortChange(effort);
        }}
      />
    </div>
  );
}

function AuthorityControl({ input, t }: ControlProps): ReactNode {
  const confirmed = input.autonomyMode !== null;
  const confirmedModeId = useId();
  return (
    <div
      className={`cmp-model ${styles.authorityControl}`}
      {...(confirmed && input.autonomyMode === "autonomous-delivery"
        ? { "data-full-access": "true" }
        : {})}
    >
      <KeikoSelect
        value={input.requestedMode}
        ariaLabel={t("codingWorkbench.composer.authority.label")}
        ariaDescribedBy={confirmed ? confirmedModeId : undefined}
        triggerTitle={t(`codingWorkbench.mode.${input.requestedMode}.description`)}
        menuTitle={t("codingWorkbench.composer.authority.menu")}
        menuMinWidth={180}
        menuPopoverMinWidth={296}
        menuPlacement="up"
        attached={false}
        showMenuHeader={false}
        showTriggerDescription={false}
        disabled={input.configurationLocked}
        leadingVisual={<CodingWorkbenchIcon size={14} />}
        sections={[{ options: autonomyOptions(t) }]}
        onValueChange={(value): void => {
          if (isCodingWorkbenchMode(value)) input.onRequestedModeChange(value);
        }}
      />
      {confirmed ? (
        <span className="sr-only" id={confirmedModeId}>
          {input.autonomyLabel}
        </span>
      ) : null}
    </div>
  );
}

function ComposerControls({ input, controller, t }: ComposerViewProps): ReactNode {
  if (input.runState === "running") {
    return <RunningControl input={input} controller={controller} t={t} />;
  }
  if (input.runState === "paused") {
    return <PausedControls input={input} controller={controller} t={t} />;
  }
  if (
    input.runState === "starting" ||
    input.runState === "ready" ||
    input.runState === "awaiting-approval" ||
    input.runState === "stopping"
  ) {
    return (
      <div className="cmp-bar-main">
        <StopControl input={input} t={t} />
      </div>
    );
  }
  return <StartControl input={input} controller={controller} t={t} />;
}

function StopControl({ input, t }: Pick<ComposerViewProps, "input" | "t">): ReactNode {
  return (
    <button
      className={`cmp-icon ui-tip ${styles.cmpRunStop}`}
      type="button"
      data-tip={t("codingWorkbench.controls.stop")}
      aria-label={t("codingWorkbench.controls.stop")}
      disabled={input.mutationPending || input.runState === "stopping"}
      onClick={input.actions.onStop}
    >
      <StopIcon size={14} />
    </button>
  );
}

// Send now and Queue are the two ways to talk to a running turn (ADR-0137 D10). Both are plain
// buttons that submit with their mode; Enter sends now and Ctrl/Cmd+Enter queues from the draft.
function DeliveryControls({ input, controller, t }: ComposerViewProps): ReactNode {
  const blocked = controller.deliveryBlocked;
  return (
    <>
      <button
        className="cmp-icon ui-tip"
        type="button"
        data-tip={t("codingWorkbench.composer.queue.help")}
        aria-label={t("codingWorkbench.composer.queue")}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        aria-disabled={blocked}
        disabled={input.mutationPending}
        onClick={(): void => controller.submit("queue")}
      >
        <LayersIcon size={16} />
      </button>
      <button
        className="cmp-send cmp-tip-end"
        type="button"
        data-on={!blocked}
        data-tip={t("codingWorkbench.composer.sendNow.help")}
        aria-label={t("codingWorkbench.composer.sendNow")}
        aria-keyshortcuts="Enter"
        aria-disabled={blocked}
        disabled={input.mutationPending}
        aria-describedby={
          controller.submitFeedback === null ? undefined : controller.submitFeedbackId
        }
        onClick={(): void => controller.submit("steer")}
      >
        <ArrowUpIcon size={16} />
      </button>
    </>
  );
}

function RunningControl({ input, controller, t }: ComposerViewProps): ReactNode {
  return (
    <div className="cmp-bar-main">
      <button
        className="cmp-icon ui-tip"
        type="button"
        data-tip={t("codingWorkbench.composer.pause")}
        aria-label={t("codingWorkbench.composer.pause")}
        disabled={input.mutationPending}
        onClick={input.actions.onPause}
      >
        <MinimizeIcon size={16} />
      </button>
      {controller.deliveryEnabled ? (
        <DeliveryControls input={input} controller={controller} t={t} />
      ) : null}
      <button
        className="cmp-send cmp-send-cancel cmp-tip-end"
        type="button"
        data-on="true"
        data-tip={t("codingWorkbench.controls.stop")}
        aria-label={t("codingWorkbench.controls.stop")}
        disabled={input.mutationPending}
        onClick={input.actions.onStop}
      >
        <StopIcon size={16} />
      </button>
    </div>
  );
}

function PausedControls({ input, controller, t }: ComposerViewProps): ReactNode {
  // A follow-up resumes the paused run on the server before it replaces the task, so it is offered
  // exactly where Resume is: a run paused for an operator decision keeps that decision as its one
  // exit (run 16, 2026-09-10: a follow-up sent into such a pause was refused by the runtime).
  const sendBlocked = controller.submitBlocked || !input.canResume;
  return (
    <div className="cmp-bar-main">
      <StopControl input={input} t={t} />
      <button
        className="cmp-icon ui-tip"
        type="button"
        data-tip={t("codingWorkbench.composer.resume")}
        aria-label={t("codingWorkbench.composer.resume")}
        disabled={input.mutationPending || !input.canResume}
        onClick={input.actions.onResume}
      >
        <FwdIcon size={16} />
      </button>
      <button
        className="cmp-send cmp-tip-end"
        type={sendBlocked ? "button" : "submit"}
        data-on={!sendBlocked}
        data-tip={t("codingWorkbench.composer.send")}
        aria-label={t("codingWorkbench.composer.send")}
        aria-disabled={sendBlocked}
        aria-describedby={
          controller.submitFeedback === null ? undefined : controller.submitFeedbackId
        }
        onClick={sendBlocked ? (): void => controller.submit() : undefined}
      >
        <ArrowUpIcon size={16} />
      </button>
    </div>
  );
}

function StartControl({ input, controller, t }: ComposerViewProps): ReactNode {
  const label = input.startBusy
    ? t("codingWorkbench.task.starting")
    : t("codingWorkbench.task.start");
  return (
    <button
      className="cmp-send cmp-tip-end"
      type={controller.submitBlocked ? "button" : "submit"}
      data-on={!controller.submitBlocked}
      data-tip={label}
      aria-label={label}
      aria-disabled={controller.submitBlocked}
      aria-describedby={
        controller.submitFeedback === null ? undefined : controller.submitFeedbackId
      }
      onClick={controller.submitBlocked ? (): void => controller.submit() : undefined}
    >
      <ArrowUpIcon size={16} />
    </button>
  );
}
