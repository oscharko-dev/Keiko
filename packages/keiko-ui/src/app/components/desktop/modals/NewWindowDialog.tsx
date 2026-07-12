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
  type ConfigField,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import KeikoSelect from "../KeikoSelect";
import { PermControl, type Cfg, type CfgValue } from "./PermControl";
import { isWorkflowEligibleModel } from "../../../../lib/workflow-eligibility";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";

interface NewWindowDialogProps {
  readonly type: WindowType;
  readonly types: typeof WinTypes;
  readonly filesContext?: FilesWindowContext | null;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

function initialCfg(fields: readonly ConfigField[]): Cfg {
  const out: Cfg = {};
  for (const f of fields) {
    out[f.key] = f.def ?? "";
  }
  return out;
}

function localizedNewWindowFields(
  type: WindowType,
  fields: readonly ConfigField[],
  t: I18nTranslate,
): readonly ConfigField[] {
  if (type !== "chat") return fields;
  return fields.map((field) =>
    field.key === "title"
      ? {
          ...field,
          label: t("newWindow.chat.fieldTitle"),
          def: t("newWindow.chat.defaultTitle"),
          placeholder: t("newWindow.chat.placeholder"),
        }
      : field,
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

// Epic #1941 (ADR-0118 D4) — copy for the two calm native-dialog outcomes every Browse surface in
// this dialog shares. Manual path entry stays available either way.
const NATIVE_DIALOG_BUSY_MESSAGE = "A native dialog is already open. Close it first.";
const NATIVE_DIALOG_UNSUPPORTED_MESSAGE =
  "Native dialogs are unavailable on this platform. Enter the path manually.";

// Opens the native OS folder dialog and routes the outcome: a picked path lands in `onPick`,
// cancellation is a non-event, everything else becomes calm dialog copy via `onError`.
async function browseNativeDirectory(
  seedPath: string,
  title: string,
  onPick: (path: string) => void,
  onError: (message: string) => void,
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
  if (outcome.kind === "busy") onError(NATIVE_DIALOG_BUSY_MESSAGE);
  if (outcome.kind === "unsupported") onError(NATIVE_DIALOG_UNSUPPORTED_MESSAGE);
  if (outcome.kind === "error") onError(outcome.message);
}

type ProductionAgentWorkflowId = Extract<
  AgentWorkflowId,
  "unit-test-generation" | "bug-investigation"
>;

const AGENT_WORKFLOWS: readonly {
  readonly id: ProductionAgentWorkflowId;
  readonly label: string;
  readonly scope: string;
}[] = [
  { id: "unit-test-generation", label: "Unit Test Agent", scope: "Source file" },
  { id: "bug-investigation", label: "Bugfix Agent", scope: "Bug report" },
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

export function normalizeAgentPathForWorkspace(workspaceRoot: string, value: string): string {
  const candidate = toPosix(value.trim());
  if (candidate.length === 0) return "";
  const workspace = toPosix(workspaceRoot.trim()).replace(/\/+$/u, "");
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
): string | null {
  if (workspaceRoot.length === 0) return "Repository is required.";
  if (modelId.length === 0) return "No compatible model is available.";
  if (workflow === "explain-plan" && fields.explainFilePath.trim().length === 0) {
    return "Explain plan requires a file path.";
  }
  if (workflow === "unit-test-generation") {
    if (fields.unitFilePath.trim().length === 0) return "Unit Test Agent requires a source file.";
  }
  if (workflow === "bug-investigation") {
    if (fields.bugDescription.trim().length === 0)
      return "Bugfix Agent requires an observed behavior.";
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

function renderField(
  f: ConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  browse: DirectoryBrowseControl,
): ReactNode {
  if (f.type === "perm") return <PermControl cfg={cfg} set={set} />;
  const raw = cfg[f.key];
  const value = typeof raw === "string" ? raw : raw === undefined ? "" : String(raw);
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
            Browse
          </button>
        </span>
        {!browse.supported ? (
          <span id={nativeNoteId} className="dlg-note">
            {NATIVE_DIALOG_UNSUPPORTED_MESSAGE}
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

function agentStartLabel(workflow: ProductionAgentWorkflowId): string {
  return workflow === "unit-test-generation" ? "Start Unit Test Agent" : "Start Bugfix Agent";
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
): SourceFilePickResolution {
  if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
    const relative = normalizeAgentPathForWorkspace(workspace, outcome.paths[0]);
    return isAbsolutePathLike(relative)
      ? { kind: "outside-workspace" }
      : { kind: "picked", relative };
  }
  if (outcome.kind === "busy") return { kind: "message", message: NATIVE_DIALOG_BUSY_MESSAGE };
  if (outcome.kind === "unsupported") {
    return { kind: "message", message: NATIVE_DIALOG_UNSUPPORTED_MESSAGE };
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
    updateField,
    onBrowseSourceFile,
  } = props;
  return (
    <label className="dlg-field">
      <span className="dlg-label">Source file</span>
      <span className="dlg-dirwrap">
        <input
          className="dlg-input mono"
          placeholder="src/file.ts"
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
          aria-label="Browse source file"
          disabled={!canBrowseSourceFile}
          aria-describedby={!canBrowseSourceFile ? sourceBrowseHelperId : undefined}
          onClick={onBrowseSourceFile}
        >
          Browse
        </button>
      </span>
      {!canBrowseSourceFile ? (
        <span id={sourceBrowseHelperId} className="dlg-note">
          {nativeDialogSupported
            ? "Select a repository before browsing source files."
            : NATIVE_DIALOG_UNSUPPORTED_MESSAGE}
        </span>
      ) : null}
    </label>
  );
}

function renderAgentBugFields(props: AgentTaskFieldsProps): ReactNode {
  const { fields, workspace, updateField } = props;
  return (
    <>
      <label className="dlg-field">
        <span className="dlg-label">Observed behavior</span>
        <textarea
          className="dlg-input dlg-textarea"
          rows={2}
          placeholder="Describe the observed bug."
          value={fields.bugDescription}
          onChange={(event) => updateField({ bugDescription: event.target.value })}
        />
      </label>
      <label className="dlg-field">
        <span className="dlg-label">
          Failing output <span className="dlg-opt">optional</span>
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
          Stack trace <span className="dlg-opt">optional</span>
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
          Related files <span className="dlg-opt">optional</span>
        </span>
        <textarea
          className="dlg-input dlg-textarea mono"
          rows={2}
          placeholder="src/file.ts, src/other.ts"
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
): ReactNode {
  if (workspace.length === 0 || registered) return null;
  return (
    <div className="dlg-agent-warning">
      <span>Repository is not registered.</span>
      <button type="button" className="dlg-btn" disabled={registering} onClick={onRegister}>
        {registering ? "Registering…" : "Register repository"}
      </button>
    </div>
  );
}

function renderCurrentFileButton(
  currentFile: string | null,
  onUseCurrentFile: () => void,
): ReactNode {
  if (currentFile === null) return null;
  return (
    <button
      type="button"
      className="dlg-current-file"
      onClick={onUseCurrentFile}
      title={currentFile}
    >
      <Icons.files size={13} /> Use current file <span className="mono">{currentFile}</span>
    </button>
  );
}

function renderAgentLoadingStatus(loading: boolean): ReactNode {
  if (!loading) return null;
  return (
    <span id="agent-start-validation" className="dlg-note" role="status">
      Loading models and projects…
    </span>
  );
}

// uiux-fix F017 C189 — the disabled Start button never reached the click guard, so its
// validation copy was dead code; surface the reason inline instead.
function renderAgentValidationStatus(loading: boolean, validation: string | null): ReactNode {
  if (loading || validation === null) return null;
  return (
    <span id="agent-start-validation" className="dlg-note" role="status">
      {validation}
    </span>
  );
}

function renderRepositoryBrowseNote(canBrowseRepository: boolean, helperId: string): ReactNode {
  if (canBrowseRepository) return null;
  return (
    <span id={helperId} className="dlg-note">
      {NATIVE_DIALOG_UNSUPPORTED_MESSAGE}
    </span>
  );
}

function AgentLauncher({
  filesContext,
  setDialogError,
  onConfirm,
  onClose,
}: AgentLauncherProps): ReactNode {
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
  const validation = validationMessage(workflow, workspace, modelId, fields);
  const canStart = validation === null && registered && !starting && !loading;
  const selectedAgent = findAgentWorkflow(workflow);
  const startLabel = agentStartLabel(workflow);
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
        if (!cancelled) setDialogError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setDialogError]);

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
      setDialogError(errorMessage(error));
    } finally {
      setRegistering(false);
    }
  };

  const startAgent = async (): Promise<void> => {
    if (!canStart) {
      setDialogError(validation ?? "Repository is not registered.");
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
        setDialogError("Repository is not registered.");
      } else {
        setDialogError(errorMessage(error));
      }
    } finally {
      setStarting(false);
    }
  };

  const openRepositoryPicker = (): void => {
    if (!canBrowseRepository) return;
    void browseNativeDirectory(
      repositoryBrowseSeed,
      "Select repository folder",
      setWorkspaceRoot,
      setDialogError,
    );
  };

  // Picked source files come back ABSOLUTE from the native dialog; the agent workflows expect
  // repo-relative paths, so normalize against the workspace and refuse out-of-workspace picks
  // instead of silently writing an absolute path into the field.
  const openSourceFilePicker = (): void => {
    if (!canBrowseSourceFile) return;
    void pickWithNativeDialog({
      mode: "open-file",
      title: "Select source file",
      defaultPath: workspace,
    }).then((outcome) => {
      const resolved = resolveSourceFilePick(outcome, workspace);
      if (resolved.kind === "picked") {
        updateField({ unitFilePath: resolved.relative });
        return;
      }
      if (resolved.kind === "outside-workspace") {
        setDialogError("Choose a file inside the selected repository.");
        return;
      }
      if (resolved.kind === "message") setDialogError(resolved.message);
    });
  };

  return (
    <>
      <div className="dlg-agent-grid">
        <div className="dlg-field">
          <span className="dlg-label">Agent</span>
          <span className="dlg-selwrap">
            <KeikoSelect
              triggerClassName="dlg-input"
              value={workflow}
              ariaLabel="Agent"
              /* eslint-disable-next-line jsx-a11y/no-autofocus -- launcher dialog starts on workflow selection for keyboard users. */
              autoFocus
              menuTitle="Agent"
              menuCountLabel={`${AGENT_WORKFLOWS.length.toString()} agents`}
              sections={[
                {
                  options: AGENT_WORKFLOWS.map((item) => ({
                    value: item.id,
                    label: item.label,
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
          <span className="dlg-label">Model</span>
          <span className="dlg-selwrap">
            <KeikoSelect
              triggerClassName="dlg-input mono"
              value={modelId}
              ariaLabel="Model"
              disabled={models.length === 0}
              menuTitle="Model"
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
        <span className="dlg-label">Repository</span>
        <span className="dlg-dirwrap">
          <input
            className="dlg-input mono"
            value={workspaceRoot}
            placeholder="/absolute/repository/path"
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
          <button
            type="button"
            className="dlg-btn dlg-dirbtn"
            disabled={!canBrowseRepository}
            aria-describedby={!canBrowseRepository ? repositoryBrowseHelperId : undefined}
            onClick={openRepositoryPicker}
          >
            Browse
          </button>
        </span>
        {renderRepositoryBrowseNote(canBrowseRepository, repositoryBrowseHelperId)}
      </label>
      {renderAgentRegistrationWarning(
        workspace,
        registered,
        registering,
        () => void registerWorkspace(),
      )}
      {renderCurrentFileButton(currentFile, useCurrentFile)}
      <div className="dlg-agent-task">
        <div className="dlg-agent-task-head">
          <span className="dlg-agent-task-title">{selectedAgent.label}</span>
          <span className="dlg-agent-task-scope">{selectedAgent.scope}</span>
        </div>
        {renderAgentTaskFields({
          workflow,
          fields,
          workspace,
          canBrowseSourceFile,
          nativeDialogSupported,
          sourceBrowseHelperId,
          updateField,
          onBrowseSourceFile: openSourceFilePicker,
        })}
      </div>
      <div className="dlg-agent-actions">
        {renderAgentLoadingStatus(loading)}
        {renderAgentValidationStatus(loading, validation)}
        <button type="button" className="dlg-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="dlg-btn dlg-primary"
          disabled={!canStart}
          aria-busy={starting}
          aria-describedby={!canStart && !starting ? "agent-start-validation" : undefined}
          onClick={() => void startAgent()}
        >
          {starting ? "Starting…" : startLabel}
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
  const t = types[type];
  const fields = useMemo(
    () => localizedNewWindowFields(type, t.config ?? [], translate),
    [translate, t.config, type],
  );
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const nativeDialogSupported = useNativeFileDialogCapability();
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const dlgRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dialogTitle = type === "chat" ? translate("newWindow.chat.title") : `New ${t.title} window`;
  const dialogDesc = type === "chat" ? translate("newWindow.chat.description") : t.desc;
  const cta = type === "chat" ? translate("newWindow.chat.open") : (t.cta ?? `Open ${t.title}`);

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
      if (trigger !== null && trigger.isConnected) {
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
        if (!cancelled) setDialogError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.root, type]);

  const set = (k: string, v: CfgValue): void => setCfg((s) => ({ ...s, [k]: v }));
  // Epic #1941 — directory fields browse through the native OS dialog; a picked folder lands in
  // the same cfg slot the manual input writes, cancellation changes nothing.
  const browse: DirectoryBrowseControl = {
    supported: nativeDialogSupported,
    open: (key, value) => {
      setDialogError(null);
      void browseNativeDirectory(value, "Select folder", (path) => set(key, path), setDialogError);
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
    const last = f[f.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const Icon = Icons[t.icon];

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
            <Icons.close size={16} />
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
              <div className="dlg-empty">Add a new {t.title} window to your workspace.</div>
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
