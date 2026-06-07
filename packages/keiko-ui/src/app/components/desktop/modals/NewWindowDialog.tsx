"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  ApiError,
  createProject,
  fetchFilesDirectories,
  fetchModels,
  fetchProjects,
  startRun,
} from "../../../../lib/api";
import type {
  AgentWorkflowId,
  FilesDirectoryListing,
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
import { PermControl, type Cfg, type CfgValue } from "./PermControl";
import { isWorkflowEligibleModel } from "../../../../lib/workflow-eligibility";

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

  useEffect(() => {
    void load(value.length > 0 ? value : undefined);
  }, [load, value]);

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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
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
        {loading ? <div className="dir-note">Loading directories...</div> : null}
        {!loading && listing !== null && listing.entries.length === 0 ? (
          <div className="dir-note">No child directories.</div>
        ) : null}
        {error !== null ? <div className="dir-error">{error}</div> : null}
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

const AGENT_WORKFLOWS: readonly { id: AgentWorkflowId; label: string }[] = [
  { id: "verify", label: "Verify" },
  { id: "explain-plan", label: "Explain plan" },
  { id: "unit-test-generation", label: "Generate unit tests" },
  { id: "bug-investigation", label: "Investigate bug" },
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

// Issue #153 — single source of truth lives in @/lib/workflow-eligibility so the in-chat
// launcher (ChatWindow → WorkflowHandoff) and this legacy modal cannot drift. The thin
// alias below preserves the historical `isAgentWorkflowModel` export name so the existing
// NewWindowDialog.test imports keep resolving.
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
    unitTargetKind: "file",
    unitFilePath: file,
    unitModuleDir: "",
    unitFilePaths: file,
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
    const filePaths = splitPaths(fields.unitFilePaths).map((entry) =>
      normalizeAgentPathForWorkspace(workspaceRoot, entry),
    );
    const target =
      fields.unitTargetKind === "module"
        ? {
            kind: "module",
            moduleDir: normalizeAgentPathForWorkspace(workspaceRoot, fields.unitModuleDir),
          }
        : fields.unitTargetKind === "changedFiles"
          ? { kind: "changedFiles", filePaths }
          : {
              kind: "file",
              filePath: normalizeAgentPathForWorkspace(workspaceRoot, fields.unitFilePath),
            };
    return {
      workflowId: "unit-test-generation",
      modelId,
      input: { workspaceRoot, target },
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
  readonly unitTargetKind: "file" | "module" | "changedFiles";
  readonly unitFilePath: string;
  readonly unitModuleDir: string;
  readonly unitFilePaths: string;
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
  if (workspaceRoot.length === 0) return "Workspace is required.";
  if (modelId.length === 0) return "No model is available.";
  if (workflow === "explain-plan" && fields.explainFilePath.trim().length === 0) {
    return "Explain plan requires a filePath.";
  }
  if (workflow === "unit-test-generation") {
    if (fields.unitTargetKind === "file" && fields.unitFilePath.trim().length === 0) {
      return "Unit test generation requires a filePath.";
    }
    if (fields.unitTargetKind === "module" && fields.unitModuleDir.trim().length === 0) {
      return "Unit test generation requires a moduleDir.";
    }
    if (fields.unitTargetKind === "changedFiles" && splitPaths(fields.unitFilePaths).length === 0) {
      return "Unit test generation requires at least one filePath.";
    }
  }
  if (workflow === "bug-investigation") {
    const hasEvidence =
      fields.bugDescription.trim().length > 0 ||
      fields.bugFailingOutput.trim().length > 0 ||
      fields.bugStackTrace.trim().length > 0 ||
      splitPaths(fields.bugTargetFiles).length > 0;
    if (!hasEvidence)
      return "Bug investigation requires description, output, stack trace, or target files.";
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
        <select
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          value={value}
          onChange={(e) => set(f.key, e.target.value)}
          disabled={options.length === 0}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {(f.prefix ?? "") + o}
            </option>
          ))}
        </select>
        <span className="dlg-selchev">
          <Icons.chevron size={15} />
        </span>
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
        <button type="button" className="dlg-dirbtn" onClick={() => openDirectoryPicker(f.key)}>
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
}

function AgentLauncher({
  filesContext,
  firstRef,
  directoryField,
  setDirectoryField,
  setDialogError,
  onConfirm,
}: AgentLauncherProps): ReactNode {
  const [workflow, setWorkflow] = useState<AgentWorkflowId>("verify");
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
      if (current.unitFilePaths.trim().length === 0) patch.unitFilePaths = normalizedCurrentFile;
      if (current.bugTargetFiles.trim().length === 0) patch.bugTargetFiles = normalizedCurrentFile;
      return Object.keys(patch).length === 0 ? current : { ...current, ...patch };
    });
  }, [currentFile, workspace]);

  const useCurrentFile = (): void => {
    if (currentFile === null) return;
    const normalizedCurrentFile = normalizeAgentPathForWorkspace(workspace, currentFile);
    if (workflow === "verify") updateField({ verifyTargetFiles: normalizedCurrentFile });
    else if (workflow === "explain-plan") updateField({ explainFilePath: normalizedCurrentFile });
    else if (workflow === "unit-test-generation") {
      if (fields.unitTargetKind === "changedFiles")
        updateField({ unitFilePaths: normalizedCurrentFile });
      else updateField({ unitTargetKind: "file", unitFilePath: normalizedCurrentFile });
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
      setDialogError(validation ?? "Workspace is not registered.");
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
        setDialogError("Workspace is not registered.");
      } else {
        setDialogError(errorMessage(error));
      }
    } finally {
      setStarting(false);
    }
  };

  const renderWorkflowFields = (): ReactNode => {
    if (workflow === "verify") {
      return (
        <label className="dlg-field">
          <span className="dlg-label">
            Target files <span className="dlg-opt">optional</span>
          </span>
          <textarea
            className="dlg-input dlg-textarea mono"
            rows={2}
            placeholder="src/file.ts, src/other.ts"
            value={fields.verifyTargetFiles}
            onChange={(event) => updateField({ verifyTargetFiles: event.target.value })}
            onBlur={(event) =>
              updateField({ verifyTargetFiles: normalizePathList(workspace, event.target.value) })
            }
          />
        </label>
      );
    }
    if (workflow === "explain-plan") {
      return (
        <>
          <label className="dlg-field">
            <span className="dlg-label">filePath</span>
            <input
              className="dlg-input mono"
              placeholder="src/file.ts"
              value={fields.explainFilePath}
              onChange={(event) => updateField({ explainFilePath: event.target.value })}
              onBlur={(event) =>
                updateField({
                  explainFilePath: normalizeAgentPathForWorkspace(workspace, event.target.value),
                })
              }
            />
          </label>
          <label className="dlg-field">
            <span className="dlg-label">
              Question <span className="dlg-opt">optional</span>
            </span>
            <textarea
              className="dlg-input dlg-textarea"
              rows={2}
              placeholder="What should the plan focus on?"
              value={fields.explainQuestion}
              onChange={(event) => updateField({ explainQuestion: event.target.value })}
            />
          </label>
        </>
      );
    }
    if (workflow === "unit-test-generation") {
      return (
        <>
          <label className="dlg-field">
            <span className="dlg-label">targetKind</span>
            <span className="dlg-selwrap">
              <select
                className="dlg-input mono"
                value={fields.unitTargetKind}
                onChange={(event) =>
                  updateField({
                    unitTargetKind: event.target.value as AgentLauncherFields["unitTargetKind"],
                  })
                }
              >
                <option value="file">file</option>
                <option value="module">module</option>
                <option value="changedFiles">changedFiles</option>
              </select>
              <span className="dlg-selchev">
                <Icons.chevron size={15} />
              </span>
            </span>
          </label>
          {fields.unitTargetKind === "module" ? (
            <label className="dlg-field">
              <span className="dlg-label">moduleDir</span>
              <input
                className="dlg-input mono"
                placeholder="src/module"
                value={fields.unitModuleDir}
                onChange={(event) => updateField({ unitModuleDir: event.target.value })}
                onBlur={(event) =>
                  updateField({
                    unitModuleDir: normalizeAgentPathForWorkspace(workspace, event.target.value),
                  })
                }
              />
            </label>
          ) : fields.unitTargetKind === "changedFiles" ? (
            <label className="dlg-field">
              <span className="dlg-label">filePaths</span>
              <textarea
                className="dlg-input dlg-textarea mono"
                rows={2}
                placeholder="src/file.ts, src/other.ts"
                value={fields.unitFilePaths}
                onChange={(event) => updateField({ unitFilePaths: event.target.value })}
                onBlur={(event) =>
                  updateField({ unitFilePaths: normalizePathList(workspace, event.target.value) })
                }
              />
            </label>
          ) : (
            <label className="dlg-field">
              <span className="dlg-label">filePath</span>
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
            </label>
          )}
        </>
      );
    }
    return (
      <>
        <label className="dlg-field">
          <span className="dlg-label">
            Description <span className="dlg-opt">optional</span>
          </span>
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
            Target files <span className="dlg-opt">optional</span>
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
      <label className="dlg-field">
        <span className="dlg-label">Workflow</span>
        <span className="dlg-selwrap">
          <select
            ref={firstRef}
            className="dlg-input mono"
            value={workflow}
            onChange={(event) => setWorkflow(event.target.value as AgentWorkflowId)}
          >
            {AGENT_WORKFLOWS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="dlg-selchev">
            <Icons.chevron size={15} />
          </span>
        </span>
      </label>
      <label className="dlg-field">
        <span className="dlg-label">Workspace</span>
        <span className="dlg-dirwrap">
          <input
            className="dlg-input mono"
            value={workspaceRoot}
            placeholder="/absolute/project/path"
            onClick={() => setDirectoryField("agentWorkspace")}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
          <button
            type="button"
            className="dlg-dirbtn"
            onClick={() => setDirectoryField("agentWorkspace")}
          >
            Browse
          </button>
        </span>
        {directoryField === "agentWorkspace" ? (
          <DirectoryPicker
            value={workspaceRoot}
            projectId={registered ? workspace : undefined}
            onSelect={setWorkspaceRoot}
            onClose={() => setDirectoryField(null)}
          />
        ) : null}
      </label>
      {workspace.length > 0 && !registered ? (
        <div className="dlg-agent-warning">
          <span>Workspace is not registered.</span>
          <button
            type="button"
            className="dlg-btn"
            disabled={registering}
            onClick={() => void registerWorkspace()}
          >
            {registering ? "Registering..." : "Register workspace"}
          </button>
        </div>
      ) : null}
      <label className="dlg-field">
        <span className="dlg-label">Model</span>
        <span className="dlg-selwrap">
          <select
            className="dlg-input mono"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={models.length === 0}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          <span className="dlg-selchev">
            <Icons.chevron size={15} />
          </span>
        </span>
      </label>
      {currentFile !== null ? (
        <button type="button" className="dlg-current-file" onClick={useCurrentFile}>
          <Icons.files size={13} /> Use current file <span className="mono">{currentFile}</span>
        </button>
      ) : null}
      {renderWorkflowFields()}
      <div className="permctl agent-disabled-perm" aria-disabled="true">
        <div className="perm-toggle" data-on={true}>
          {/* eslint-disable-next-line @next/next/no-img-element -- raw SVG sized by .perm-orca */}
          <img className="perm-orca" src="/assets/keiko-logo.svg" alt="" />
          <span className="perm-tt">
            <span className="perm-name">Keiko-Mode</span>
            <span className="perm-desc">coming soon</span>
          </span>
          <span className="perm-sw on">
            <span />
          </span>
        </div>
        <div className="perm-note">
          Runs are dry-run only. Apply requires explicit review and Apply.
        </div>
      </div>
      <div className="dlg-agent-actions">
        <button
          type="button"
          className="dlg-btn dlg-primary"
          disabled={!canStart}
          onClick={() => void startAgent()}
        >
          {starting ? "Starting..." : "Start agent"}
        </button>
        {loading ? <span className="dlg-note">Loading models and projects...</span> : null}
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
  const t = types[type];
  const fields = t.config ?? [];
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [directoryField, setDirectoryField] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // capture the element that opened this dialog so we can return focus on close
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const r = requestAnimationFrame(() => {
      setShown(true);
      firstFieldRef.current?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, []);

  // ADR-0018 — no shell prefetch: the terminal tool is a permitted-command picker now. The
  // window only needs a projectPath and an optional cwd, both supplied via the form below.

  useEffect(() => {
    if (type !== "files") return;
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
  const cta = t.cta ?? `Open ${t.title}`;

  return (
    <div className={"dlg-overlay" + (shown ? " in" : "")} onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Esc/Tab/⌘Enter key handling */}
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-window-title"
        aria-describedby="new-window-desc"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="dlg-head">
          <span className="dlg-ico">
            <Icon size={20} />
          </span>
          <div className="dlg-htext">
            <span id="new-window-title" className="dlg-title">
              New {t.title} window
            </span>
            <span id="new-window-desc" className="dlg-sub">
              {t.desc}
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="palette-x"
            onClick={onClose}
            aria-label="Cancel"
            title="Cancel"
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
                  {f.optional === true && <span className="dlg-opt">optional</span>}
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
          {dialogError !== null ? <div className="dlg-error">{dialogError}</div> : null}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onClose}>
            Cancel
          </button>
          {type !== "agents" ? (
            <button type="button" className="dlg-btn dlg-primary" onClick={submit}>
              {cta}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
