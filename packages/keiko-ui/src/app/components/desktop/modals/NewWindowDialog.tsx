"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  ApiError,
  createProject,
  fetchFilesDirectories,
  fetchFilesTree,
  fetchModels,
  fetchProjects,
  startRun,
} from "../../../../lib/api";
import type {
  AgentWorkflowId,
  FilesDirectoryListing,
  FilesTreeEntry,
  ModelCapability,
  ProjectWithAvailability,
} from "../../../../lib/types";
import { Icons } from "../Icons";
import type { FilesWindowContext } from "../hooks/useWorkspace.types";
import {
  type ConfigField,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import KeikoSelect from "../KeikoSelect";
import { PermControl, type Cfg, type CfgValue } from "./PermControl";
import { isWorkflowEligibleModel } from "../../../../lib/workflow-eligibility";
import { useI18n, type I18nTranslate } from "@/lib/i18n";

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

interface DirectoryPickerProps {
  readonly value: string;
  readonly projectId?: string | undefined;
  readonly selectProjectRoot?: boolean | undefined;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
}

// M2 (#532) — exported so tests can assert the mapping independently of the
// component render cycle. Maps BFF error codes to user-facing copy:
//   400 BAD_ROOT  → absolute path required
//   403 DENIED    → path on the filesystem deny-list
export function directoryPickerError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "BAD_ROOT") return "Enter an absolute folder path.";
    if (error.code === "DENIED") return "That location is excluded.";
  }
  return error instanceof Error ? error.message : "Unable to read directories.";
}

function errorMessage(error: unknown): string {
  return directoryPickerError(error);
}

function DirectoryPicker({
  value,
  projectId,
  selectProjectRoot = false,
  onSelect,
  onClose,
}: DirectoryPickerProps): ReactNode {
  const [listing, setListing] = useState<FilesDirectoryListing | null>(null);
  const [draft, setDraft] = useState(value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRoot = projectId ?? value.trim();

  const load = useCallback(
    async (path?: string): Promise<void> => {
      // M2 (#532): the BFF now accepts any absolute folder. When there is no
      // requestRoot yet, show a prompt rather than an error so the input feels
      // intentional (the user hasn't typed anything yet, not an error state).
      if (requestRoot.length === 0) {
        setListing(null);
        setError("Enter an absolute folder path.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await fetchFilesDirectories(requestRoot, path);
        setListing(next);
        setDraft(next.path);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [requestRoot],
  );

  // uiux-fix F017 C341 — load once when the picker opens. Re-running on every outer
  // input keystroke fired a fetch per character and flashed transient errors
  // ("Enter an absolute folder path.") while the user was still typing; navigation
  // stays explicit via Go/Enter/row clicks.
  useEffect(() => {
    void load(value.length > 0 ? value : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only load
  }, []);

  const choose = (): void => {
    if (listing !== null) {
      onSelect(selectProjectRoot ? (listing.roots[0]?.path ?? listing.path) : listing.path);
      onClose();
    }
  };

  return (
    <div className="dir-picker" role="group" aria-label="Directory picker">
      <div className="dir-top">
        <input
          className="dlg-input mono dir-path"
          value={draft}
          aria-label="Folder path"
          placeholder="/absolute/folder/path"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              // uiux-fix F017 C364 — the dialog submits on plain Enter in inputs now;
              // keep Enter-to-navigate local to the picker.
              event.stopPropagation();
              void load(draft);
            }
          }}
        />
        <button type="button" className="dlg-btn dir-go" onClick={() => void load(draft)}>
          Go
        </button>
      </div>
      {listing !== null ? (
        <div className="dir-roots">
          {listing.roots.map((root) => (
            <button
              type="button"
              key={`${root.label}:${root.path}`}
              className="dir-chip"
              onClick={() => void load(root.path)}
            >
              {root.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dir-list">
        {listing?.parent !== null && listing?.parent !== undefined ? (
          <button
            type="button"
            className="dir-row"
            onClick={() => void load(listing.parent ?? undefined)}
          >
            <Icons.back size={14} />
            <span>Parent directory</span>
          </button>
        ) : null}
        {listing?.entries.map((entry) => (
          <button
            type="button"
            className="dir-row"
            key={entry.path}
            onClick={() => void load(entry.path)}
          >
            <Icons.folder size={14} />
            <span>{entry.name}</span>
          </button>
        ))}
        {loading ? (
          <div className="dir-note" role="status">
            Loading directories…
          </div>
        ) : null}
        {!loading && listing !== null && listing.entries.length === 0 ? (
          <div className="dir-note">No child directories.</div>
        ) : null}
        {error !== null ? (
          <div className="dir-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <div className="dir-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="dlg-btn dlg-primary"
          onClick={choose}
          disabled={listing === null}
        >
          Use directory
        </button>
      </div>
    </div>
  );
}

interface FilePickerProps {
  readonly root: string;
  readonly value: string;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
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

function parentRelativeFilePath(path: string): string {
  const normalized = toPosix(path.trim()).replace(/\/+$/u, "");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

function displayPickerDirectory(path: string): string {
  return path.length === 0 ? "Repository root" : path;
}

function formatPickerBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const value = index === 0 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2);
  return `${value} ${units[index]}`;
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

function FilePicker({ root, value, onSelect, onClose }: FilePickerProps): ReactNode {
  const initialPath = normalizeAgentPathForWorkspace(root, value);
  const [directory, setDirectory] = useState(parentRelativeFilePath(initialPath));
  const [selectedPath, setSelectedPath] = useState(initialPath);
  const [entries, setEntries] = useState<readonly FilesTreeEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (root.trim().length === 0) {
      setEntries([]);
      setTruncated(false);
      setLoading(false);
      setError("Select a repository first.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchFilesTree(root.trim(), directory)
      .then((listing) => {
        if (cancelled) return;
        setEntries(listing.entries);
        setTruncated(listing.truncated);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setTruncated(false);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, root]);

  const goParent = (): void => setDirectory(parentRelativeFilePath(directory));
  const choose = (): void => {
    if (selectedPath.trim().length === 0) return;
    onSelect(normalizeAgentPathForWorkspace(root, selectedPath));
    onClose();
  };

  const directories = entries.filter((entry) => entry.kind === "directory");
  const files = entries.filter((entry) => entry.kind !== "directory");

  return (
    <div className="file-picker" role="group" aria-label="File picker">
      <div className="file-picker-head">
        <span className="file-picker-path mono">{displayPickerDirectory(directory)}</span>
      </div>
      <div className="dir-list file-picker-list">
        {directory.length > 0 ? (
          <button type="button" className="dir-row" onClick={goParent}>
            <Icons.back size={14} />
            <span>Parent folder</span>
          </button>
        ) : null}
        {directories.map((entry) => (
          <button
            type="button"
            className="dir-row file-picker-row"
            key={entry.path}
            disabled={!entry.readable}
            onClick={() => setDirectory(entry.path)}
            title={entry.path}
          >
            <Icons.folder size={14} />
            <span>{entry.name}</span>
          </button>
        ))}
        {files.map((entry) => (
          <button
            type="button"
            className="dir-row file-picker-row"
            data-selected={selectedPath === entry.path ? "true" : undefined}
            key={entry.path}
            disabled={!entry.readable}
            aria-pressed={selectedPath === entry.path}
            onClick={() => setSelectedPath(entry.path)}
            title={entry.path}
          >
            <Icons.file size={14} />
            <span>{entry.name}</span>
            <span className="file-picker-meta mono">{formatPickerBytes(entry.sizeBytes)}</span>
          </button>
        ))}
        {loading ? (
          <div className="dir-note" role="status">
            Loading files…
          </div>
        ) : null}
        {!loading && error === null && entries.length === 0 ? (
          <div className="dir-note">No files in this folder.</div>
        ) : null}
        {truncated ? (
          <div className="dir-note file-picker-warning" role="status">
            Showing only the first {entries.length.toString()} entries.
          </div>
        ) : null}
        {error !== null ? (
          <div className="dir-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <div className="dir-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="dlg-btn dlg-primary"
          onClick={choose}
          disabled={selectedPath.trim().length === 0}
        >
          Use file
        </button>
      </div>
    </div>
  );
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

function renderField(
  f: ConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  openDirectoryPicker: (key: string) => void,
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
    return (
      <span className="dlg-dirwrap">
        <input
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          placeholder={f.placeholder ?? f.label}
          value={value}
          onClick={() => openDirectoryPicker(f.key)}
          onChange={(e) => set(f.key, e.target.value)}
        />
        <button
          type="button"
          className="dlg-btn dlg-dirbtn"
          onClick={() => openDirectoryPicker(f.key)}
        >
          Browse
        </button>
      </span>
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
  readonly firstRef: (node: HTMLElement | null) => void;
  readonly directoryField: string | null;
  readonly setDirectoryField: (key: string | null) => void;
  readonly setDialogError: (message: string | null) => void;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

function AgentLauncher({
  filesContext,
  firstRef,
  directoryField,
  setDirectoryField,
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
  const currentFile =
    filesContext !== null &&
    filesContext.root === workspace &&
    filesContext.activeFilePath !== undefined
      ? filesContext.activeFilePath
      : null;
  const registered = workspace.length > 0 && projects.includes(workspace);
  const validation = validationMessage(workflow, workspace, modelId, fields);
  const canStart = validation === null && registered && !starting && !loading;
  const selectedAgent = AGENT_WORKFLOWS.find((item) => item.id === workflow) ?? AGENT_WORKFLOWS[0]!;
  const startLabel =
    workflow === "unit-test-generation" ? "Start Unit Test Agent" : "Start Bugfix Agent";
  const firstAvailableProjectRoot = projects[0] ?? "";
  const repositoryBrowseSeed =
    workspace.length > 0 ? workspace : (filesContext?.root ?? firstAvailableProjectRoot);
  const canBrowseRepository = repositoryBrowseSeed.length > 0;
  const repositoryBrowseHelperId = "agent-repository-browse-help";
  const canBrowseSourceFile = registered;
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
    setFields((current) => {
      const patch: Record<string, string> = {};
      if (current.verifyTargetFiles.trim().length === 0)
        patch.verifyTargetFiles = normalizedCurrentFile;
      if (current.explainFilePath.trim().length === 0)
        patch.explainFilePath = normalizedCurrentFile;
      if (current.unitFilePath.trim().length === 0) patch.unitFilePath = normalizedCurrentFile;
      if (current.bugTargetFiles.trim().length === 0) patch.bugTargetFiles = normalizedCurrentFile;
      return Object.keys(patch).length === 0 ? current : { ...current, ...patch };
    });
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
      if (error instanceof ApiError && error.code === "WORKSPACE_NOT_REGISTERED") {
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
    if (workspace.length === 0) setWorkspaceRoot(repositoryBrowseSeed);
    setDirectoryField("agentWorkspace");
  };

  const renderAgentFields = (): ReactNode => {
    if (workflow === "unit-test-generation") {
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
              onClick={() => {
                if (canBrowseSourceFile) setDirectoryField("unitSourceFile");
              }}
            >
              Browse
            </button>
          </span>
          {!canBrowseSourceFile ? (
            <span id={sourceBrowseHelperId} className="dlg-note">
              Select a registered repository before browsing source files.
            </span>
          ) : null}
          {directoryField === "unitSourceFile" ? (
            <FilePicker
              root={workspace}
              value={fields.unitFilePath}
              onSelect={(path) => updateField({ unitFilePath: path })}
              onClose={() => setDirectoryField(null)}
            />
          ) : null}
        </label>
      );
    }
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
        {!canBrowseRepository ? (
          <span id={repositoryBrowseHelperId} className="dlg-note">
            Enter an absolute repository path to enable Browse.
          </span>
        ) : null}
        {directoryField === "agentWorkspace" ? (
          <DirectoryPicker
            value={repositoryBrowseSeed}
            projectId={projects.includes(repositoryBrowseSeed) ? repositoryBrowseSeed : undefined}
            onSelect={setWorkspaceRoot}
            onClose={() => setDirectoryField(null)}
          />
        ) : null}
      </label>
      {workspace.length > 0 && !registered ? (
        <div className="dlg-agent-warning">
          <span>Repository is not registered.</span>
          <button
            type="button"
            className="dlg-btn"
            disabled={registering}
            onClick={() => void registerWorkspace()}
          >
            {registering ? "Registering…" : "Register repository"}
          </button>
        </div>
      ) : null}
      {currentFile !== null ? (
        <button
          type="button"
          className="dlg-current-file"
          onClick={useCurrentFile}
          title={currentFile}
        >
          <Icons.files size={13} /> Use current file <span className="mono">{currentFile}</span>
        </button>
      ) : null}
      <div className="dlg-agent-task">
        <div className="dlg-agent-task-head">
          <span className="dlg-agent-task-title">{selectedAgent.label}</span>
          <span className="dlg-agent-task-scope">{selectedAgent.scope}</span>
        </div>
        {renderAgentFields()}
      </div>
      <div className="dlg-agent-actions">
        {loading ? (
          <span id="agent-start-validation" className="dlg-note" role="status">
            Loading models and projects…
          </span>
        ) : null}
        {/* uiux-fix F017 C189 — the disabled Start button never reached the click guard,
            so its validation copy was dead code; surface the reason inline instead. */}
        {!loading && validation !== null ? (
          <span id="agent-start-validation" className="dlg-note" role="status">
            {validation}
          </span>
        ) : null}
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
  const { t: translate } = useI18n();
  const t = types[type];
  const fields = useMemo(
    () => localizedNewWindowFields(type, t.config ?? [], translate),
    [translate, t.config, type],
  );
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [directoryField, setDirectoryField] = useState<string | null>(null);
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
    // (one-field-dialog expectation). Textareas keep Enter for newlines, buttons keep
    // native activation, and the DirectoryPicker path input stops propagation so its
    // Enter keeps navigating instead of submitting.
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
              firstRef={(node) => {
                firstFieldRef.current = node;
              }}
              directoryField={directoryField}
              setDirectoryField={setDirectoryField}
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
                  setDirectoryField,
                )}
                {f.type === "directory" && directoryField === f.key ? (
                  <DirectoryPicker
                    value={typeof cfg[f.key] === "string" ? (cfg[f.key] as string) : ""}
                    selectProjectRoot={f.key === "root"}
                    onSelect={(path) => set(f.key, path)}
                    onClose={() => setDirectoryField(null)}
                  />
                ) : null}
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
