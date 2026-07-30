"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ApiError, createProject, fetchModels, fetchProjects, startRun } from "../../../../lib/api";
import type {
  AgentWorkflowId,
  ModelCapability,
  ProjectWithAvailability,
} from "../../../../lib/types";
import {
  pickWithNativeDialog,
  type NativeDialogPickOutcome,
} from "../../../../lib/native-file-dialog";
import { Icons } from "../Icons";
import { useNativeFileDialogCapability } from "../hooks/useNativeFileDialogCapability";
import type { FilesWindowContext } from "../hooks/useWorkspace.types";
import {
  localizedWindowConfigFields,
  localizedWindowCta,
  localizedWindowDesc,
  localizedWindowTitle,
  type LocalizedConfigField,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import KeikoSelect from "../KeikoSelect";
import { PermControl, type Cfg, type CfgValue } from "./PermControl";
import { isWorkflowEligibleModel } from "../../../../lib/workflow-eligibility";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const FilesIcon = Icons.files;
const CloseIcon = Icons.close;

interface NewWindowDialogProps {
  readonly type: WindowType;
  readonly types: typeof WinTypes;
  readonly filesContext?: FilesWindowContext | null;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

function initialCfg(fields: readonly LocalizedConfigField[]): Cfg {
  const out: Cfg = {};
  for (const f of fields) {
    out[f.key] = f.def;
  }
  return out;
}

function focusableInside(root: HTMLElement): readonly HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>("button,input,select,textarea");
  const out: HTMLElement[] = [];
  nodes.forEach((n) => {
    if (n.hasAttribute("disabled")) return;
    if (n.offsetParent === null && n.tagName !== "BUTTON") return;
    out.push(n);
  });
  return out;
}

function errorMessage(error: unknown, t: I18nTranslate): string {
  return error instanceof Error ? error.message : t("newWindow.unexpectedError");
}

// Epic #1941 (ADR-0118 D4) — copy for the two calm native-dialog outcomes every Browse surface in
// this dialog shares. Manual path entry stays available either way. The copy lives in the shared
// catalog (`nativeDialog.*`) so the German shell no longer falls back to an English sentence.

// Opens the native OS folder dialog and routes the outcome: a picked path lands in `onPick`,
// cancellation is a non-event, everything else becomes calm dialog copy via `onError`.
async function browseNativeDirectory(
  seedPath: string,
  title: string,
  onPick: (path: string) => void,
  onError: (message: string) => void,
  t: I18nTranslate,
): Promise<void> {
  const trimmed = seedPath.trim();
  const outcome = await pickWithNativeDialog({
    mode: "open-directory",
    title,
    ...(trimmed.length > 0 ? { defaultPath: trimmed } : {}),
  });
  if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
    onPick(outcome.paths[0]);
    return;
  }
  if (outcome.kind === "busy") onError(t("nativeDialog.busy"));
  if (outcome.kind === "unsupported") onError(t("nativeDialog.unsupported"));
  if (outcome.kind === "error") onError(outcome.message);
}

type ProductionAgentWorkflowId = Extract<
  AgentWorkflowId,
  "unit-test-generation" | "bug-investigation"
>;

// Message keys, not display copy: the agent picker and the task-header chip both render from this
// table, so a literal here reached the user untranslated in every locale.
const AGENT_WORKFLOWS: readonly {
  readonly id: ProductionAgentWorkflowId;
  readonly labelKey: MessageKey;
  readonly scopeKey: MessageKey;
}[] = [
  {
    id: "unit-test-generation",
    labelKey: "agentLauncher.workflow.unitTest",
    scopeKey: "agentLauncher.scope.sourceFile",
  },
  {
    id: "bug-investigation",
    labelKey: "agentLauncher.workflow.bugfix",
    scopeKey: "agentLauncher.scope.bugReport",
  },
];

function availableProjectPaths(projects: readonly ProjectWithAvailability[]): readonly string[] {
  return projects.filter((project) => project.available).map((project) => project.path);
}

function splitPaths(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// AC #4: no longer prefers a placeholder id — use the first available model.
// When models is empty, returns "" (handled by the caller via `current || ...`).
export function chooseDefaultModel(models: readonly ModelCapability[]): string {
  return models[0]?.id ?? "";
}

// Issue #153 — single source of truth lives in @/lib/workflow-eligibility. The thin alias below
// preserves the historical `isAgentWorkflowModel` export name so NewWindowDialog.test imports keep
// resolving.
export const isAgentWorkflowModel = isWorkflowEligibleModel;

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function stripTrailingSlashRun(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end -= 1;
  return value.slice(0, end);
}

function normalizeAgentPathForWorkspace(workspaceRoot: string, value: string): string {
  const candidate = toPosix(value.trim());
  if (candidate.length === 0) return "";
  const workspace = stripTrailingSlashRun(toPosix(workspaceRoot.trim()));
  if (workspace.length === 0) return candidate;
  if (candidate === workspace) return ".";
  const prefix = `${workspace}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
}

function normalizePathList(workspaceRoot: string, value: string): string {
  return splitPaths(value)
    .map((entry) => normalizeAgentPathForWorkspace(workspaceRoot, entry))
    .join(", ");
}

function buildInitialAgentFields(
  workspaceRoot: string,
  currentFile: string | null,
): AgentLauncherFields {
  const file =
    currentFile === null ? "" : normalizeAgentPathForWorkspace(workspaceRoot, currentFile);
  return {
    verifyTargetFiles: file,
    explainFilePath: file,
    explainQuestion: "",
    unitFilePath: file,
    bugDescription: "",
    bugFailingOutput: "",
    bugStackTrace: "",
    bugTargetFiles: file,
  };
}

function workflowRunBody(
  workflow: AgentWorkflowId,
  workspaceRoot: string,
  modelId: string,
  fields: AgentLauncherFields,
): { workflowId?: string; taskType?: string; input: Record<string, unknown>; modelId: string } {
  if (workflow === "verify") {
    const targetFiles = splitPaths(fields.verifyTargetFiles).map((entry) =>
      normalizeAgentPathForWorkspace(workspaceRoot, entry),
    );
    return {
      taskType: "verify",
      modelId,
      input: {
        workspaceRoot,
        ...(targetFiles.length > 0 ? { targetFiles } : {}),
      },
    };
  }
  if (workflow === "explain-plan") {
    return {
      taskType: "explain-plan",
      modelId,
      input: {
        workspaceRoot,
        filePath: normalizeAgentPathForWorkspace(workspaceRoot, fields.explainFilePath),
        ...(fields.explainQuestion.trim().length > 0
          ? { question: fields.explainQuestion.trim() }
          : {}),
      },
    };
  }
  if (workflow === "unit-test-generation") {
    return {
      workflowId: "unit-test-generation",
      modelId,
      input: {
        workspaceRoot,
        target: {
          kind: "file",
          filePath: normalizeAgentPathForWorkspace(workspaceRoot, fields.unitFilePath),
        },
      },
    };
  }
  return {
    workflowId: "bug-investigation",
    modelId,
    input: {
      workspaceRoot,
      report: {
        ...(fields.bugDescription.trim().length > 0
          ? { description: fields.bugDescription.trim() }
          : {}),
        ...(fields.bugFailingOutput.trim().length > 0
          ? { failingOutput: fields.bugFailingOutput.trim() }
          : {}),
        ...(fields.bugStackTrace.trim().length > 0
          ? { stackTrace: fields.bugStackTrace.trim() }
          : {}),
        ...(splitPaths(fields.bugTargetFiles).length > 0
          ? {
              targetFiles: splitPaths(fields.bugTargetFiles).map((entry) =>
                normalizeAgentPathForWorkspace(workspaceRoot, entry),
              ),
            }
          : {}),
      },
    },
  };
}

interface AgentLauncherFields {
  readonly verifyTargetFiles: string;
  readonly explainFilePath: string;
  readonly explainQuestion: string;
  readonly unitFilePath: string;
  readonly bugDescription: string;
  readonly bugFailingOutput: string;
  readonly bugStackTrace: string;
  readonly bugTargetFiles: string;
}

function validationMessage(
  workflow: AgentWorkflowId,
  workspaceRoot: string,
  modelId: string,
  fields: AgentLauncherFields,
  t: I18nTranslate,
): string | null {
  if (workspaceRoot.length === 0) return t("agentLauncher.validation.repositoryRequired");
  if (modelId.length === 0) return t("agentLauncher.validation.noModel");
  if (workflow === "explain-plan" && fields.explainFilePath.trim().length === 0) {
    return t("agentLauncher.validation.explainFile");
  }
  if (workflow === "unit-test-generation") {
    if (fields.unitFilePath.trim().length === 0) {
      return t("agentLauncher.validation.unitSource");
    }
  }
  if (workflow === "bug-investigation") {
    if (fields.bugDescription.trim().length === 0) {
      return t("agentLauncher.validation.bugDescription");
    }
  }
  return null;
}

// Epic #1941 — how a directory field reaches the native OS folder dialog. `supported` reflects
// the BFF host platform; when false the Browse button is disabled and the text input stays the
// (manual) fallback.
interface DirectoryBrowseControl {
  readonly supported: boolean;
  readonly open: (key: string, value: string) => void;
}

export function resolveFieldValue(raw: CfgValue): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined) return "";
  return String(raw);
}

function renderField(
  f: LocalizedConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  browse: DirectoryBrowseControl,
  t: I18nTranslate,
): ReactNode {
  if (f.type === "perm") return <PermControl cfg={cfg} set={set} />;
  const raw = cfg[f.key];
  const value = resolveFieldValue(raw);
  if (f.type === "select") {
    const options = f.options ?? [];
    return (
      <span className="dlg-selwrap">
        <KeikoSelect
          triggerClassName="dlg-input mono"
          value={value}
          disabled={options.length === 0}
          /* eslint-disable-next-line jsx-a11y/no-autofocus -- dialog opens with the first configured launcher control focused. */
          autoFocus={firstRef !== null}
          menuTitle={f.label}
          mono
          sections={[
            {
              options: options.map((option) => ({
                value: option,
                label: `${f.prefix ?? ""}${option}`,
              })),
            },
          ]}
          onValueChange={(next) => set(f.key, next)}
        />
      </span>
    );
  }
  if (f.type === "textarea") {
    return (
      <textarea
        ref={firstRef ?? undefined}
        className="dlg-input dlg-textarea"
        rows={3}
        placeholder={f.placeholder ?? ""}
        value={value}
        onChange={(e) => set(f.key, e.target.value)}
      />
    );
  }
  if (f.type === "directory") {
    const nativeNoteId = `dlg-native-note-${f.key}`;
    return (
      <>
        <span className="dlg-dirwrap">
          <input
            ref={firstRef ?? undefined}
            className="dlg-input mono"
            placeholder={f.placeholder ?? f.label}
            value={value}
            onChange={(e) => set(f.key, e.target.value)}
          />
          <button
            type="button"
            className="dlg-btn dlg-dirbtn"
            disabled={!browse.supported}
            aria-describedby={browse.supported ? undefined : nativeNoteId}
            onClick={() => browse.open(f.key, value)}
          >
            {t("common.browse")}
          </button>
        </span>
        {!browse.supported ? (
          <span id={nativeNoteId} className="dlg-note">
            {t("nativeDialog.unsupported")}
          </span>
        ) : null}
      </>
    );
  }
  return (
    <input
      ref={firstRef ?? undefined}
      className="dlg-input mono"
      placeholder={f.placeholder ?? f.label}
      value={value}
      onChange={(e) => set(f.key, e.target.value)}
    />
  );
}

interface AgentLauncherProps {
  readonly filesContext: FilesWindowContext | null;
  readonly setDialogError: (message: string | null) => void;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

// Absolute-path shape shared by both native platforms (POSIX, drive-letter, UNC). Used to detect
// a picked source file that lies OUTSIDE the workspace and therefore cannot become repo-relative.
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

// Resolves the FilesWindowContext's active file to a launcher default ONLY when its root still
// matches the currently entered workspace — a stale context (workspace edited since) must not
// leak its file path into a different repository's fields.
function resolveCurrentFile(
  filesContext: FilesWindowContext | null,
  workspace: string,
): string | null {
  if (filesContext === null) return null;
  if (filesContext.root !== workspace) return null;
  if (filesContext.activeFilePath === undefined) return null;
  return filesContext.activeFilePath;
}

function findAgentWorkflow(workflow: ProductionAgentWorkflowId): (typeof AGENT_WORKFLOWS)[number] {
  return AGENT_WORKFLOWS.find((item) => item.id === workflow) ?? AGENT_WORKFLOWS[0]!;
}

function agentStartLabel(workflow: ProductionAgentWorkflowId, t: I18nTranslate): string {
  return t("agentLauncher.start", { label: t(findAgentWorkflow(workflow).labelKey) });
}

// The native repository dialog opens at the OS default location when no seed is known; the seed
// below only positions it when one is — the entered workspace first, then the connected Files
// window's root, then the first registered project.
function resolveRepositoryBrowseSeed(
  workspace: string,
  filesContext: FilesWindowContext | null,
  firstAvailableProjectRoot: string,
): string {
  if (workspace.length > 0) return workspace;
  return filesContext?.root ?? firstAvailableProjectRoot;
}

// Fills any still-empty agent-field slots with the workspace-relative current file. Only touches
// fields the user has not already populated, so a manual edit is never overwritten.
function fillEmptyAgentFields(
  current: AgentLauncherFields,
  normalizedCurrentFile: string,
): AgentLauncherFields {
  const patch: Record<string, string> = {};
  if (current.verifyTargetFiles.trim().length === 0) {
    patch.verifyTargetFiles = normalizedCurrentFile;
  }
  if (current.explainFilePath.trim().length === 0) {
    patch.explainFilePath = normalizedCurrentFile;
  }
  if (current.unitFilePath.trim().length === 0) {
    patch.unitFilePath = normalizedCurrentFile;
  }
  if (current.bugTargetFiles.trim().length === 0) {
    patch.bugTargetFiles = normalizedCurrentFile;
  }
  return Object.keys(patch).length === 0 ? current : { ...current, ...patch };
}

// Picked source files come back ABSOLUTE from the native dialog; the agent workflows expect
// repo-relative paths. This folds the raw dialog outcome into a closed set the click handler can
// react to without re-deriving the same branches.
type SourceFilePickResolution =
  | { readonly kind: "picked"; readonly relative: string }
  | { readonly kind: "outside-workspace" }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "noop" };

function resolveSourceFilePick(
  outcome: NativeDialogPickOutcome,
  workspace: string,
  t: I18nTranslate,
): SourceFilePickResolution {
  if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
    const relative = normalizeAgentPathForWorkspace(workspace, outcome.paths[0]);
    return isAbsolutePathLike(relative)
      ? { kind: "outside-workspace" }
      : { kind: "picked", relative };
  }
  if (outcome.kind === "busy") return { kind: "message", message: t("nativeDialog.busy") };
  if (outcome.kind === "unsupported") {
    return { kind: "message", message: t("nativeDialog.unsupported") };
  }
  if (outcome.kind === "error") return { kind: "message", message: outcome.message };
  return { kind: "noop" };
}

function isWorkspaceNotRegisteredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "WORKSPACE_NOT_REGISTERED";
}

interface AgentTaskFieldsProps {
  readonly workflow: ProductionAgentWorkflowId;
  readonly fields: AgentLauncherFields;
  readonly workspace: string;
  readonly canBrowseSourceFile: boolean;
  readonly nativeDialogSupported: boolean;
  readonly sourceBrowseHelperId: string;
  readonly t: I18nTranslate;
  readonly updateField: (patch: Partial<AgentLauncherFields>) => void;
  readonly onBrowseSourceFile: () => void;
}

function renderAgentSourceFileField(props: AgentTaskFieldsProps): ReactNode {
  const {
    fields,
    workspace,
    canBrowseSourceFile,
    nativeDialogSupported,
    sourceBrowseHelperId,
    t,
    updateField,
    onBrowseSourceFile,
  } = props;
  return (
    <label className="dlg-field">
      <span className="dlg-label">{t("agentLauncher.scope.sourceFile")}</span>
      <span className="dlg-dirwrap">
        <input
          className="dlg-input mono"
          placeholder={t("agentLauncher.sourceFilePlaceholder")}
          value={fields.unitFilePath}
          onChange={(event) => updateField({ unitFilePath: event.target.value })}
          onBlur={(event) =>
            updateField({
              unitFilePath: normalizeAgentPathForWorkspace(workspace, event.target.value),
            })
          }
        />
        <button
          type="button"
          className="dlg-btn dlg-dirbtn"
          aria-label={t("agentLauncher.browseSourceFile")}
          disabled={!canBrowseSourceFile}
          aria-describedby={!canBrowseSourceFile ? sourceBrowseHelperId : undefined}
          onClick={onBrowseSourceFile}
        >
          {t("common.browse")}
        </button>
      </span>
      {!canBrowseSourceFile ? (
        <span id={sourceBrowseHelperId} className="dlg-note">
          {nativeDialogSupported
            ? t("agentLauncher.selectRepositoryFirst")
            : t("nativeDialog.unsupported")}
        </span>
      ) : null}
    </label>
  );
}

function renderAgentBugFields(props: AgentTaskFieldsProps): ReactNode {
  const { fields, workspace, t, updateField } = props;
  return (
    <>
      <label className="dlg-field">
        <span className="dlg-label">{t("agentLauncher.observedBehavior")}</span>
        <textarea
          className="dlg-input dlg-textarea"
          rows={2}
          placeholder={t("agentLauncher.observedBehaviorPlaceholder")}
          value={fields.bugDescription}
          onChange={(event) => updateField({ bugDescription: event.target.value })}
        />
      </label>
      <label className="dlg-field">
        <span className="dlg-label">
          {t("agentLauncher.failingOutput")} <span className="dlg-opt">{t("common.optional")}</span>
        </span>
        <textarea
          className="dlg-input dlg-textarea mono"
          rows={2}
          value={fields.bugFailingOutput}
          onChange={(event) => updateField({ bugFailingOutput: event.target.value })}
        />
      </label>
      <label className="dlg-field">
        <span className="dlg-label">
          {t("agentLauncher.stackTrace")} <span className="dlg-opt">{t("common.optional")}</span>
        </span>
        <textarea
          className="dlg-input dlg-textarea mono"
          rows={2}
          value={fields.bugStackTrace}
          onChange={(event) => updateField({ bugStackTrace: event.target.value })}
        />
      </label>
      <label className="dlg-field">
        <span className="dlg-label">
          {t("agentLauncher.relatedFiles")} <span className="dlg-opt">{t("common.optional")}</span>
        </span>
        <textarea
          className="dlg-input dlg-textarea mono"
          rows={2}
          placeholder={t("agentLauncher.relatedFilesPlaceholder")}
          value={fields.bugTargetFiles}
          onChange={(event) => updateField({ bugTargetFiles: event.target.value })}
          onBlur={(event) =>
            updateField({ bugTargetFiles: normalizePathList(workspace, event.target.value) })
          }
        />
      </label>
    </>
  );
}

function renderAgentTaskFields(props: AgentTaskFieldsProps): ReactNode {
  return props.workflow === "unit-test-generation"
    ? renderAgentSourceFileField(props)
    : renderAgentBugFields(props);
}

function renderAgentRegistrationWarning(
  workspace: string,
  registered: boolean,
  registering: boolean,
  onRegister: () => void,
  t: I18nTranslate,
): ReactNode {
  if (workspace.length === 0 || registered) return null;
  return (
    <div className="dlg-agent-warning">
      <span>{t("agentLauncher.notRegistered")}</span>
      <button type="button" className="dlg-btn" disabled={registering} onClick={onRegister}>
        {registering ? t("agentLauncher.registering") : t("agentLauncher.register")}
      </button>
    </div>
  );
}

function renderCurrentFileButton(
  currentFile: string | null,
  onUseCurrentFile: () => void,
  t: I18nTranslate,
): ReactNode {
  if (currentFile === null) return null;
  return (
    <button
      type="button"
      className="dlg-current-file"
      onClick={onUseCurrentFile}
      title={currentFile}
    >
      <FilesIcon size={13} /> {t("agentLauncher.useCurrentFile")}{" "}
      <span className="mono">{currentFile}</span>
    </button>
  );
}

// Both agent-start notices render into `#agent-start-validation`, the target of the
// Start button's aria-describedby. <output> is the native status live region
// (S6819); it is inline like the <span> it replaces, so `.dlg-note` keeps
// rendering the same box.
function renderAgentLoadingStatus(loading: boolean, t: I18nTranslate): ReactNode {
  if (!loading) return null;
  return (
    <output id="agent-start-validation" className="dlg-note">
      {t("agentLauncher.loading")}
    </output>
  );
}

// uiux-fix F017 C189 — the disabled Start button never reached the click guard, so its
// validation copy was dead code; surface the reason inline instead.
function renderAgentValidationStatus(loading: boolean, validation: string | null): ReactNode {
  if (loading || validation === null) return null;
  return (
    <output id="agent-start-validation" className="dlg-note">
      {validation}
    </output>
  );
}

function renderRepositoryBrowseNote(
  canBrowseRepository: boolean,
  helperId: string,
  t: I18nTranslate,
): ReactNode {
  if (canBrowseRepository) return null;
  return (
    <span id={helperId} className="dlg-note">
      {t("nativeDialog.unsupported")}
    </span>
  );
}

function AgentLauncher({
  filesContext,
  setDialogError,
  onConfirm,
  onClose,
}: AgentLauncherProps): ReactNode {
  const t = useTranslate();
  const [workflow, setWorkflow] = useState<ProductionAgentWorkflowId>("unit-test-generation");
  const [workspaceRoot, setWorkspaceRoot] = useState(filesContext?.root ?? "");
  const [modelId, setModelId] = useState("");
  const [models, setModels] = useState<readonly ModelCapability[]>([]);
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [fields, setFields] = useState<AgentLauncherFields>(() =>
    buildInitialAgentFields(filesContext?.root ?? "", filesContext?.activeFilePath ?? null),
  );
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [starting, setStarting] = useState(false);

  const workspace = workspaceRoot.trim();
  const currentFile = resolveCurrentFile(filesContext, workspace);
  const registered = workspace.length > 0 && projects.includes(workspace);
  const validation = validationMessage(workflow, workspace, modelId, fields, t);
  const canStart = validation === null && registered && !starting && !loading;
  const selectedAgent = findAgentWorkflow(workflow);
  const startLabel = agentStartLabel(workflow, t);
  const nativeDialogSupported = useNativeFileDialogCapability();
  const firstAvailableProjectRoot = projects[0] ?? "";
  const repositoryBrowseSeed = resolveRepositoryBrowseSeed(
    workspace,
    filesContext,
    firstAvailableProjectRoot,
  );
  // Native dialogs need no seed root (they open at the OS default location), only platform
  // support; the seed merely positions the dialog when one is known.
  const canBrowseRepository = nativeDialogSupported;
  const repositoryBrowseHelperId = "agent-repository-browse-help";
  const canBrowseSourceFile = nativeDialogSupported && workspace.length > 0;
  const sourceBrowseHelperId = "agent-source-file-browse-help";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDialogError(null);
    void Promise.all([fetchModels(), fetchProjects()])
      .then(([modelPayload, projectPayload]) => {
        if (cancelled) return;
        const workflowModels = modelPayload.models.filter(isAgentWorkflowModel);
        setModels(workflowModels);
        setModelId((current) => current || chooseDefaultModel(workflowModels));
        setProjects(availableProjectPaths(projectPayload.projects));
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(errorMessage(error, t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setDialogError, t]);

  const updateField = (patch: Partial<AgentLauncherFields>): void => {
    setFields((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    if (currentFile === null) return;
    const normalizedCurrentFile = normalizeAgentPathForWorkspace(workspace, currentFile);
    setFields((current) => fillEmptyAgentFields(current, normalizedCurrentFile));
  }, [currentFile, workspace]);

  const useCurrentFile = (): void => {
    if (currentFile === null) return;
    const normalizedCurrentFile = normalizeAgentPathForWorkspace(workspace, currentFile);
    if (workflow === "unit-test-generation") {
      updateField({ unitFilePath: normalizedCurrentFile });
    } else {
      updateField({ bugTargetFiles: normalizedCurrentFile });
    }
  };

  const refreshProjects = async (): Promise<void> => {
    const projectPayload = await fetchProjects();
    setProjects(availableProjectPaths(projectPayload.projects));
  };

  const registerWorkspace = async (): Promise<void> => {
    if (workspace.length === 0) return;
    setRegistering(true);
    setDialogError(null);
    try {
      await createProject({ path: workspace });
      await refreshProjects();
    } catch (error: unknown) {
      setDialogError(errorMessage(error, t));
    } finally {
      setRegistering(false);
    }
  };

  const startAgent = async (): Promise<void> => {
    if (!canStart) {
      setDialogError(validation ?? t("agentLauncher.notRegistered"));
      return;
    }
    setStarting(true);
    setDialogError(null);
    const body = workflowRunBody(workflow, workspace, modelId, fields);
    try {
      const started = await startRun(body);
      onConfirm({
        workflow,
        model: modelId,
        runId: started.runId,
        fingerprint: started.fingerprint,
        workspaceRoot: workspace,
        inputJson: JSON.stringify(body.input),
        ...(filesContext !== null && filesContext.root === workspace
          ? { __connectFilesId: filesContext.id }
          : {}),
      });
    } catch (error: unknown) {
      if (isWorkspaceNotRegisteredError(error)) {
        await refreshProjects().catch(() => undefined);
        setDialogError(t("agentLauncher.notRegistered"));
      } else {
        setDialogError(errorMessage(error, t));
      }
    } finally {
      setStarting(false);
    }
  };

  const openRepositoryPicker = (): void => {
    if (!canBrowseRepository) return;
    void browseNativeDirectory(
      repositoryBrowseSeed,
      t("nativeDialog.selectRepository"),
      setWorkspaceRoot,
      setDialogError,
      t,
    );
  };

  // Picked source files come back ABSOLUTE from the native dialog; the agent workflows expect
  // repo-relative paths, so normalize against the workspace and refuse out-of-workspace picks
  // instead of silently writing an absolute path into the field.
  const openSourceFilePicker = (): void => {
    if (!canBrowseSourceFile) return;
    void pickWithNativeDialog({
      mode: "open-file",
      title: t("nativeDialog.selectSourceFile"),
      defaultPath: workspace,
    }).then((outcome) => {
      const resolved = resolveSourceFilePick(outcome, workspace, t);
      if (resolved.kind === "picked") {
        updateField({ unitFilePath: resolved.relative });
        return;
      }
      if (resolved.kind === "outside-workspace") {
        setDialogError(t("agentLauncher.fileOutsideRepository"));
        return;
      }
      if (resolved.kind === "message") setDialogError(resolved.message);
    });
  };

  return (
    <>
      <div className="dlg-agent-grid">
        <div className="dlg-field">
          <span className="dlg-label">{t("agentLauncher.agent")}</span>
          <span className="dlg-selwrap">
            <KeikoSelect
              triggerClassName="dlg-input"
              value={workflow}
              ariaLabel={t("agentLauncher.agent")}
              /* eslint-disable-next-line jsx-a11y/no-autofocus -- launcher dialog starts on workflow selection for keyboard users. */
              autoFocus
              menuTitle={t("agentLauncher.agent")}
              menuCountLabel={t("agentLauncher.agentCount", { count: AGENT_WORKFLOWS.length })}
              sections={[
                {
                  options: AGENT_WORKFLOWS.map((item) => ({
                    value: item.id,
                    label: t(item.labelKey),
                  })),
                },
              ]}
              onValueChange={(next) => {
                const item = AGENT_WORKFLOWS.find((candidate) => candidate.id === next);
                if (item !== undefined) setWorkflow(item.id);
              }}
            />
          </span>
        </div>
        <div className="dlg-field">
          <span className="dlg-label">{t("agentLauncher.model")}</span>
          <span className="dlg-selwrap">
            <KeikoSelect
              triggerClassName="dlg-input mono"
              value={modelId}
              ariaLabel={t("agentLauncher.model")}
              disabled={models.length === 0}
              menuTitle={t("agentLauncher.model")}
              mono
              sections={[
                {
                  options: models.map((model) => ({
                    value: model.id,
                    label: model.id,
                  })),
                },
              ]}
              onValueChange={setModelId}
            />
          </span>
        </div>
      </div>
      <label className="dlg-field">
        <span className="dlg-label">{t("agentLauncher.repository")}</span>
        <span className="dlg-dirwrap">
          <input
            className="dlg-input mono"
            value={workspaceRoot}
            placeholder={t("agentLauncher.repositoryPlaceholder")}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
          <button
            type="button"
            className="dlg-btn dlg-dirbtn"
            disabled={!canBrowseRepository}
            aria-describedby={!canBrowseRepository ? repositoryBrowseHelperId : undefined}
            onClick={openRepositoryPicker}
          >
            {t("common.browse")}
          </button>
        </span>
        {renderRepositoryBrowseNote(canBrowseRepository, repositoryBrowseHelperId, t)}
      </label>
      {renderAgentRegistrationWarning(
        workspace,
        registered,
        registering,
        () => void registerWorkspace(),
        t,
      )}
      {renderCurrentFileButton(currentFile, useCurrentFile, t)}
      <div className="dlg-agent-task">
        <div className="dlg-agent-task-head">
          <span className="dlg-agent-task-title">{t(selectedAgent.labelKey)}</span>
          <span className="dlg-agent-task-scope">{t(selectedAgent.scopeKey)}</span>
        </div>
        {renderAgentTaskFields({
          workflow,
          fields,
          workspace,
          canBrowseSourceFile,
          nativeDialogSupported,
          sourceBrowseHelperId,
          t,
          updateField,
          onBrowseSourceFile: openSourceFilePicker,
        })}
      </div>
      <div className="dlg-agent-actions">
        {renderAgentLoadingStatus(loading, t)}
        {renderAgentValidationStatus(loading, validation)}
        <button type="button" className="dlg-btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="dlg-btn dlg-primary"
          disabled={!canStart}
          aria-busy={starting}
          aria-describedby={!canStart && !starting ? "agent-start-validation" : undefined}
          onClick={() => void startAgent()}
        >
          {starting ? t("agentLauncher.starting") : startLabel}
        </button>
      </div>
    </>
  );
}

export function NewWindowDialog({
  type,
  types,
  filesContext = null,
  onConfirm,
  onClose,
}: NewWindowDialogProps): ReactNode {
  const translate = useTranslate();
  const def = types[type];
  // Every launcher field arrives already localized; `type === "chat"` no longer needs a bespoke
  // branch, because the whole registry now carries message keys instead of English literals.
  const fields = useMemo(() => localizedWindowConfigFields(translate, type), [translate, type]);
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const nativeDialogSupported = useNativeFileDialogCapability();
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const dlgRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const windowLabel = localizedWindowTitle(translate, type);
  const dialogTitle = translate("newWindow.title", { label: windowLabel });
  const dialogDesc = localizedWindowDesc(translate, type);
  const cta =
    localizedWindowCta(translate, type) ?? translate("newWindow.open", { label: windowLabel });

  useEffect(() => {
    // capture the element that opened this dialog so we can return focus on close
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      const trigger = triggerRef.current;
      // Audit C148 — confirming from the Empty State unmounts the trigger button
      // (the first window replaces the empty state), so focusing it silently
      // dropped keyboard focus to <body>. Fall back to the freshly created top
      // window (focusable via tabIndex={-1}) or the New-window FAB — the same
      // deterministic targets as WindowFrame's close-with-focus-restore. The rAF
      // waits for React to commit the new window before querying it.
      if (trigger?.isConnected === true) {
        trigger.focus();
        return;
      }
      requestAnimationFrame(() => {
        // MD-05: guaranteed fallback to document.body so focus never lands in
        // limbo when neither the top window nor the FAB is in the DOM yet.
        const next =
          document.querySelector<HTMLElement>('.window[data-top="true"]') ??
          document.querySelector<HTMLElement>(".ws-fab") ??
          document.body;
        next.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    const r = requestAnimationFrame(() => {
      setShown(true);
      // uiux-fix F008 C053 — config-less types (connector, figma) have no first field, so focus
      // used to stay on the trigger OUTSIDE this aria-modal dialog: Escape and the Tab trap
      // (both bound to the dialog div) never fired. Fall back to the dialog container itself.
      (firstFieldRef.current ?? dlgRef.current)?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, []);

  // uiux-fix F008 C053 — window-level Escape covers the residual cases where focus sits outside
  // the dialog (the div's own onKeyDown only fires while focus is inside). Scoped to the dialog's
  // lifetime via the effect cleanup so it never eats Escape meant for other overlays.
  useEffect(() => {
    const onWindowKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [onClose]);

  // ADR-0018 — no shell prefetch: the terminal tool is a permitted-command picker now. The
  // window only needs a projectPath and an optional cwd, both supplied via the form below.

  useEffect(() => {
    if (type !== "files" && type !== "editor") return;
    let cancelled = false;
    const currentRoot = cfg.root;
    if (typeof currentRoot === "string" && currentRoot.length > 0) return;
    setDialogError(null);
    void fetchProjects()
      .then((payload) => {
        const firstProject = availableProjectPaths(payload.projects)[0];
        if (!cancelled && firstProject !== undefined) {
          setCfg((current) => ({ ...current, root: firstProject }));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(errorMessage(error, translate));
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.root, type, translate]);

  const set = (k: string, v: CfgValue): void => setCfg((s) => ({ ...s, [k]: v }));
  // Epic #1941 — directory fields browse through the native OS dialog; a picked folder lands in
  // the same cfg slot the manual input writes, cancellation changes nothing.
  const browse: DirectoryBrowseControl = {
    supported: nativeDialogSupported,
    open: (key, value) => {
      setDialogError(null);
      void browseNativeDirectory(
        value,
        translate("nativeDialog.selectFolder"),
        (path) => set(key, path),
        setDialogError,
        translate,
      );
    },
  };
  const submit = (): void => {
    if (type !== "agents") onConfirm(cfg);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      submit();
      return;
    }
    // uiux-fix F017 C364 — plain Enter in a single-line field confirms the dialog
    // (one-field-dialog expectation). Textareas keep Enter for newlines and buttons keep
    // native activation.
    if (e.key === "Enter") {
      const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
      if (tag === "INPUT" || tag === "SELECT") {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusableInside(e.currentTarget);
    if (f.length === 0) return;
    const first = f[0] as HTMLElement;
    const last = f.at(-1) as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const Icon = Icons[def.icon];

  return (
    <div className={"dlg-overlay" + (shown ? " in" : "")} onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Esc/Tab/⌘Enter key handling */}
      <div
        ref={dlgRef}
        className={type === "agents" ? "dlg dlg-agents" : "dlg"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-window-title"
        aria-describedby="new-window-desc"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="dlg-head">
          <span className="dlg-ico">
            <Icon size={20} />
          </span>
          <div className="dlg-htext">
            <span id="new-window-title" className="dlg-title">
              {dialogTitle}
            </span>
            <span id="new-window-desc" className="dlg-sub">
              {dialogDesc}
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="palette-x"
            onClick={onClose}
            aria-label={translate("common.cancel")}
            title={translate("common.cancel")}
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="dlg-body">
          {type === "agents" ? (
            <AgentLauncher
              filesContext={filesContext}
              setDialogError={setDialogError}
              onConfirm={onConfirm}
              onClose={onClose}
            />
          ) : (
            fields.length === 0 && (
              <div className="dlg-empty">
                {translate("newWindow.empty", { label: windowLabel })}
              </div>
            )
          )}
          {type !== "agents" &&
            fields.map((f, i) => (
              <label className="dlg-field" key={f.key}>
                <span className="dlg-label">
                  {f.label}
                  {f.optional === true && (
                    <span className="dlg-opt">{translate("common.optional")}</span>
                  )}
                </span>
                {renderField(
                  f,
                  cfg,
                  set,
                  i === 0
                    ? (node) => {
                        firstFieldRef.current = node;
                      }
                    : null,
                  browse,
                  translate,
                )}
              </label>
            ))}
          {dialogError !== null ? (
            <div className="dlg-error" role="alert">
              {dialogError}
            </div>
          ) : null}
        </div>
        {type !== "agents" ? (
          <div className="dlg-foot">
            <button type="button" className="dlg-btn" onClick={onClose}>
              {translate("common.cancel")}
            </button>
            <button type="button" className="dlg-btn dlg-primary" onClick={submit}>
              {cta}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
