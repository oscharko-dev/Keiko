import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimePreference,
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
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
const FolderIcon = Icons.folder;
const BranchIcon = Icons.branch;
const CubeIcon = Icons.cube;
const BrainIcon = Icons.brain;

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
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onSend: () => void;
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

function autonomyOptions(
  t: CodingWorkbenchTranslate,
): readonly { readonly value: CodingWorkbenchMode; readonly label: string }[] {
  return [
    { value: "governed-assist", label: t("codingWorkbench.mode.governed-assist.label") },
    { value: "supervised-coding", label: t("codingWorkbench.mode.supervised-coding.label") },
    { value: "autonomous-delivery", label: t("codingWorkbench.mode.autonomous-delivery.label") },
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
  readonly repositoryLabel: string | null;
  readonly branchLabel: string | null;
  readonly branchContext: "repository" | "task";
  readonly onOpenGit: () => void;
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
}

interface TaskComposerController {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly micButtonRef: RefObject<HTMLButtonElement | null>;
  readonly dictation: ReturnType<typeof useDictation>;
  readonly dictationVisible: boolean;
  readonly submitBlocked: boolean;
  readonly submitFeedback: string | null;
  readonly submitFeedbackId: string;
  readonly submit: () => void;
}

function submitBlockedReason(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): string | null {
  if (input.mutationPending) return t("codingWorkbench.composer.blocked.busy");
  if (input.runState === "running") return null;
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

function submitTask(input: TaskStartSectionProps): void {
  if (input.runState === "running") input.actions.onPause();
  else if (input.runState === "paused") input.actions.onSend();
  else input.actions.onStart();
}

function useTaskComposerController(
  input: TaskStartSectionProps,
  t: CodingWorkbenchTranslate,
): TaskComposerController {
  const { onTaskIntentChange, taskIntent } = input;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const submitFeedbackId = useId();
  const [blockedSubmitAttempted, setBlockedSubmitAttempted] = useState(false);
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
  const blockedReason = submitBlockedReason(input, t);
  const submitBlocked = blockedReason !== null;
  const submit = (): void => {
    if (submitBlocked) {
      setBlockedSubmitAttempted(true);
      return;
    }
    setBlockedSubmitAttempted(false);
    submitTask(input);
  };
  useEffect(() => {
    if (!submitBlocked) setBlockedSubmitAttempted(false);
  }, [submitBlocked]);
  useComposerAutoGrow(textareaRef, taskIntent);
  return {
    textareaRef,
    micButtonRef,
    dictation,
    dictationVisible,
    submitBlocked,
    submitFeedback: blockedSubmitAttempted ? blockedReason : null,
    submitFeedbackId,
    submit,
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
      <ComposerContext input={input} t={t} />
      <TaskComposerBox input={input} controller={controller} t={t} />
    </form>
  );
}

function branchContextLabel(input: TaskStartSectionProps, t: CodingWorkbenchTranslate): string {
  return t(
    input.branchContext === "task"
      ? "codingWorkbench.info.taskBranch"
      : "codingWorkbench.info.repositoryBranch",
  );
}

function ComposerContext({ input, t }: ControlProps): ReactNode {
  if (input.repositoryLabel === null && input.branchLabel === null) return null;
  const branchLabel = branchContextLabel(input, t);
  return (
    <div
      className={styles.composerContext}
      aria-label={t("codingWorkbench.composer.context.label")}
    >
      {input.repositoryLabel === null ? null : (
        <button
          className={`${styles.composerContextChip} ${styles.composerContextButton}`}
          type="button"
          title={input.repositoryLabel}
          aria-label={t("codingWorkbench.composer.repository.open", {
            repository: input.repositoryLabel,
          })}
          onClick={input.onOpenGit}
        >
          <FolderIcon size={14} />
          <span>{input.repositoryLabel}</span>
        </button>
      )}
      {input.branchLabel === null ? null : (
        <button
          className={`${styles.composerContextChip} ${styles.composerContextButton}`}
          type="button"
          title={`${branchLabel}: ${input.branchLabel}`}
          aria-label={t("codingWorkbench.composer.branch.open", {
            branch: input.branchLabel,
          })}
          onClick={input.onOpenGit}
        >
          <BranchIcon size={14} />
          <span>{input.branchLabel}</span>
        </button>
      )}
      <ProjectMemoryToggle input={input} t={t} />
    </div>
  );
}

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
        maxLength={65_536}
        disabled={input.mutationPending}
        onChange={(event): void => input.onTaskIntentChange(event.target.value)}
        onKeyDown={(event): void => {
          if (composerEnterSubmits(event)) controller.submit();
        }}
        belowInput={<DictationPreview controller={controller} />}
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

function DictationPreview({
  controller,
}: {
  readonly controller: TaskComposerController;
}): ReactNode {
  return (
    <>
      {controller.dictationVisible ? (
        <VoiceDictationPreviewFromController
          controller={controller.dictation}
          onAfterDiscard={() => controller.micButtonRef.current?.focus()}
        />
      ) : null}
      <SubmitBlockedFeedback controller={controller} />
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
      audioLevel={controller.dictation.audioLevel}
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
  return (
    <div className={`cmp-bar-model ${styles.composerConfiguration}`}>
      <CodingModelControl input={input} t={t} />
      <SourceControl input={input} t={t} />
      <ReasoningControl input={input} efforts={efforts} t={t} />
      <AuthorityControl input={input} t={t} />
    </div>
  );
}

function CodingModelControl({ input, t }: ControlProps): ReactNode {
  if (input.runtimePreference !== "managed-gateway") return null;
  const options = input.models.map((model) => ({ value: model.id, label: model.id }));
  return (
    <div className={`cmp-model mono ${styles.modelControl}`}>
      <KeikoSelect
        triggerClassName="cmp-model-select"
        value={input.selectedModelId ?? ""}
        placeholder={t("codingWorkbench.composer.model.none")}
        ariaLabel={t("codingWorkbench.composer.model.label")}
        menuTitle={t("codingWorkbench.composer.model.menu")}
        menuMinWidth={280}
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

function SourceControl({ input, t }: ControlProps): ReactNode {
  const options = runtimePreferenceOptions(t);
  return (
    <div className={`cmp-model mono ${styles.sourceControl}`}>
      <KeikoSelect
        value={input.runtimePreference}
        ariaLabel={t("codingWorkbench.composer.source.label")}
        menuTitle={t("codingWorkbench.composer.source.menu")}
        menuMinWidth={220}
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
      className={`cmp-model mono ${styles.authorityControl}`}
      {...(confirmed && input.autonomyMode === "autonomous-delivery"
        ? { "data-full-access": "true" }
        : {})}
    >
      <KeikoSelect
        value={input.requestedMode}
        ariaLabel={t("codingWorkbench.composer.authority.label")}
        ariaDescribedBy={confirmed ? confirmedModeId : undefined}
        menuTitle={t("codingWorkbench.composer.authority.menu")}
        menuMinWidth={260}
        disabled={input.configurationLocked}
        mono
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
    return <RunningControl input={input} t={t} />;
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

function RunningControl({ input, t }: Pick<ComposerViewProps, "input" | "t">): ReactNode {
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
        onClick={sendBlocked ? controller.submit : undefined}
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
      onClick={controller.submitBlocked ? controller.submit : undefined}
    >
      <ArrowUpIcon size={16} />
    </button>
  );
}
