"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { fetchModels, fetchWorkflows, startRun, ApiError } from "@/lib/api";
import type {
  ModelCapability,
  WorkflowDescriptor,
  WorkflowInputSpec,
  WorkflowsResponse,
} from "@/lib/types";
import { costClassClasses, costClassLabel } from "@/lib/format";

// ---------------------------------------------------------------------------
// Field renderer — driven by WorkflowInputSpec.type
// ---------------------------------------------------------------------------

interface FieldProps {
  spec: WorkflowInputSpec;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  idPrefix: string;
}

function WorkflowField({ spec, value, onChange, idPrefix }: FieldProps): ReactNode {
  const id = `${idPrefix}-${spec.name}`;

  if (spec.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={id}
          name={spec.name}
          checked={typeof value === "boolean" ? value : false}
          onChange={(e) => { onChange(spec.name, e.target.checked); }}
          className="h-4 w-4 rounded border-ink/30 text-accent"
        />
        <label htmlFor={id} className="text-sm text-ink">
          {spec.description}
          {spec.required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
        </label>
      </div>
    );
  }

  if (spec.type === "string[]") {
    return (
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-ink">
          {spec.description}
          {spec.required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
        </label>
        <input
          type="text"
          id={id}
          name={spec.name}
          placeholder="Comma-separated values"
          value={Array.isArray(value) ? value.join(", ") : ""}
          onChange={(e) => {
            onChange(
              spec.name,
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            );
          }}
          required={spec.required}
          className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </div>
    );
  }

  // string / object (render as textarea for object type)
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {spec.description}
        {spec.required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
      </label>
      {spec.type === "object" ? (
        <textarea
          id={id}
          name={spec.name}
          rows={4}
          placeholder='{ "key": "value" }'
          value={typeof value === "string" ? value : ""}
          onChange={(e) => { onChange(spec.name, e.target.value); }}
          required={spec.required}
          className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
          aria-describedby={`${id}-hint`}
        />
      ) : (
        <input
          type="text"
          id={id}
          name={spec.name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => { onChange(spec.name, e.target.value); }}
          required={spec.required}
          className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
        />
      )}
      {spec.type === "object" && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-muted">
          JSON object
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible limits editor
// ---------------------------------------------------------------------------

type LimitsRecord = Record<string, number | undefined>;

interface LimitsEditorProps {
  limits: LimitsRecord;
  onChange: (limits: LimitsRecord) => void;
  /** Unique id for the controlled content element (aria-controls target). */
  contentId: string;
}

function LimitsEditor({ limits, onChange, contentId }: LimitsEditorProps): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded border border-ink/10">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); }}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium text-ink-muted hover:text-ink"
      >
        Advanced harness limits
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>
      <div id={contentId} hidden={!open} className="grid gap-3 border-t border-ink/10 p-4 sm:grid-cols-2">
          {Object.entries(limits).map(([key, val]) => (
            <div key={key}>
              <label htmlFor={`limit-${key}`} className="block text-xs text-ink-muted">
                {key}
              </label>
              <input
                type="number"
                id={`limit-${key}`}
                min={0}
                value={val ?? ""}
                onChange={(e) => {
                  onChange({
                    ...limits,
                    [key]: e.target.value === "" ? undefined : Number(e.target.value),
                  });
                }}
                className="mt-1 block w-full rounded border border-ink/20 bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
              />
            </div>
          ))}
        </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow section
// ---------------------------------------------------------------------------

interface WorkflowSectionProps {
  descriptor: WorkflowDescriptor;
  models: ModelCapability[];
  isSelected: boolean;
  onSelect: () => void;
}

function WorkflowSection({
  descriptor,
  models,
  isSelected,
  onSelect,
}: WorkflowSectionProps): ReactNode {
  const sectionId = `workflow-${descriptor.workflowId}`;
  const chatModels = models.filter((m) => m.kind === "chat");
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {};
    for (const spec of descriptor.inputs) {
      if (spec.name !== "apply" && spec.name !== "modelId" && spec.name !== "limits") {
        defaults[spec.name] = spec.defaultValue ?? (spec.type === "boolean" ? false : "");
      }
    }
    return defaults;
  });
  const [selectedModel, setSelectedModel] = useState<string>(
    chatModels[0]?.id ?? "",
  );
  const [applyMode, setApplyMode] = useState(false);
  const [limits, setLimits] = useState<LimitsRecord>(() => {
    const dl = descriptor.defaultLimits;
    const out: LimitsRecord = {};
    if (dl && typeof dl === "object") {
      for (const [k, v] of Object.entries(dl)) {
        if (typeof v === "number") out[k] = v;
      }
    }
    return out;
  });
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const router = useRouter();
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isSelected && firstInputRef.current) {
      firstInputRef.current.focus();
    }
  }, [isSelected]);

  function updateField(name: string, value: unknown): void {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);

    // Build the input object for this workflow's specs
    const input: Record<string, unknown> = { ...fieldValues };
    if (workspaceRoot) input.workspaceRoot = workspaceRoot;

    try {
      setSubmitting(true);
      const { runId } = await startRun({
        workflowId: descriptor.workflowId,
        input,
        modelId: selectedModel,
        apply: applyMode,
        limits,
      });
      router.push(`/run?id=${encodeURIComponent(runId)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to start run";
      setFormError(msg);
      setSubmitting(false);
    }
  }

  const userFacingInputs = descriptor.inputs.filter(
    (s) => s.name !== "apply" && s.name !== "modelId" && s.name !== "limits",
  );

  return (
    <section
      aria-labelledby={`${sectionId}-heading`}
      className={`rounded-lg border ${isSelected ? "border-accent" : "border-ink/10"} p-6`}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          id={`${sectionId}-radio`}
          name="workflow-select"
          checked={isSelected}
          onChange={onSelect}
          className="mt-1"
          aria-describedby={`${sectionId}-desc`}
        />
        <div className="flex-1">
          <label htmlFor={`${sectionId}-radio`}>
            <h2 id={`${sectionId}-heading`} className="text-subheading text-ink">
              {descriptor.name}
            </h2>
          </label>
          <p id={`${sectionId}-desc`} className="mt-1 text-sm text-ink-muted">
            {descriptor.description}
          </p>
          {/* Preferred cost class hint */}
          <span
            className={`mt-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${costClassClasses(descriptor.modelSelectionOptions.preferredCostClass)}`}
          >
            {costClassLabel(descriptor.modelSelectionOptions.preferredCostClass)}
          </span>
        </div>
      </div>

      {isSelected && (
        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          noValidate
          className="mt-6 grid gap-4"
        >
          {/* Workspace root */}
          <div>
            <label
              htmlFor={`${sectionId}-workspace`}
              className="block text-sm font-medium text-ink"
            >
              Workspace path <span className="ml-1 text-red-600" aria-hidden="true">*</span>
            </label>
            <input
              ref={firstInputRef}
              type="text"
              id={`${sectionId}-workspace`}
              value={workspaceRoot}
              onChange={(e) => { setWorkspaceRoot(e.target.value); }}
              placeholder="/path/to/project"
              required
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
            />
          </div>

          {/* Workflow-specific inputs */}
          {userFacingInputs.map((spec) => (
            <WorkflowField
              key={spec.name}
              spec={spec}
              value={fieldValues[spec.name]}
              onChange={updateField}
              idPrefix={sectionId}
            />
          ))}

          {/* Model picker */}
          <div>
            <label
              htmlFor={`${sectionId}-model`}
              className="block text-sm font-medium text-ink"
            >
              Model
            </label>
            <select
              id={`${sectionId}-model`}
              value={selectedModel}
              onChange={(e) => { setSelectedModel(e.target.value); }}
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
            >
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} ({m.costClass} cost)
                </option>
              ))}
            </select>
          </div>

          {/* Dry-run / apply toggle */}
          {descriptor.supportsApply && (
            <fieldset className="rounded border border-ink/10 p-4">
              <legend className="px-1 text-sm font-medium text-ink">Execution mode</legend>
              <div className="mt-2 flex gap-6">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${sectionId}-apply-mode`}
                    value="dry-run"
                    checked={!applyMode}
                    onChange={() => { setApplyMode(false); }}
                  />
                  Dry-run (review before applying)
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${sectionId}-apply-mode`}
                    value="apply"
                    checked={applyMode}
                    onChange={() => { setApplyMode(true); }}
                  />
                  Apply immediately
                </label>
              </div>
              {applyMode && (
                <p className="mt-2 text-xs text-orange-700" role="alert">
                  Apply mode will write files to your workspace after the workflow completes.
                </p>
              )}
            </fieldset>
          )}

          {/* Limits editor */}
          <LimitsEditor limits={limits} onChange={setLimits} contentId={`${sectionId}-limits-content`} />

          {/* Error */}
          {formError !== null && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="self-start rounded bg-accent px-6 py-2 text-sm font-semibold text-ink-inverse hover:bg-accent-strong focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting…" : "Start run"}
          </button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Explain-plan section
// ---------------------------------------------------------------------------

interface ExplainPlanSectionProps {
  models: ModelCapability[];
  isSelected: boolean;
  onSelect: () => void;
}

function ExplainPlanSection({ models, isSelected, onSelect }: ExplainPlanSectionProps): ReactNode {
  const chatModels = models.filter((m) => m.kind === "chat");
  const [filePath, setFilePath] = useState("");
  const [question, setQuestion] = useState("");
  const [selectedModel, setSelectedModel] = useState(chatModels[0]?.id ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const router = useRouter();
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isSelected && firstRef.current) {
      firstRef.current.focus();
    }
  }, [isSelected]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (!filePath.trim()) {
      setFormError("File path is required.");
      return;
    }
    try {
      setSubmitting(true);
      const { runId } = await startRun({
        taskType: "explain-plan",
        input: {
          workspaceRoot: workspaceRoot || undefined,
          filePath: filePath.trim(),
          question: question.trim() || undefined,
        },
        modelId: selectedModel,
        apply: false,
      });
      router.push(`/run?id=${encodeURIComponent(runId)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to start run";
      setFormError(msg);
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-labelledby="explain-plan-heading"
      className={`rounded-lg border ${isSelected ? "border-accent" : "border-ink/10"} p-6`}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          id="explain-plan-radio"
          name="workflow-select"
          checked={isSelected}
          onChange={onSelect}
          className="mt-1"
        />
        <div>
          <label htmlFor="explain-plan-radio">
            <h2 id="explain-plan-heading" className="text-subheading text-ink">
              Explain plan
            </h2>
          </label>
          <p className="mt-1 text-sm text-ink-muted">
            Read-only task: ask the model to explain a file or code section.
          </p>
        </div>
      </div>

      {isSelected && (
        <form
          onSubmit={(e) => { void handleSubmit(e); }}
          noValidate
          className="mt-6 grid gap-4"
        >
          <div>
            <label htmlFor="explain-workspace" className="block text-sm font-medium text-ink">
              Workspace path
            </label>
            <input
              ref={firstRef}
              type="text"
              id="explain-workspace"
              value={workspaceRoot}
              onChange={(e) => { setWorkspaceRoot(e.target.value); }}
              placeholder="/path/to/project (optional)"
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
            />
          </div>
          <div>
            <label htmlFor="explain-file" className="block text-sm font-medium text-ink">
              File path <span className="ml-1 text-red-600" aria-hidden="true">*</span>
            </label>
            <input
              type="text"
              id="explain-file"
              value={filePath}
              onChange={(e) => { setFilePath(e.target.value); }}
              placeholder="src/foo/bar.ts"
              required
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
            />
          </div>
          <div>
            <label htmlFor="explain-question" className="block text-sm font-medium text-ink">
              Question (optional)
            </label>
            <input
              type="text"
              id="explain-question"
              value={question}
              onChange={(e) => { setQuestion(e.target.value); }}
              placeholder="What does this function do?"
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-focus"
            />
          </div>
          <div>
            <label htmlFor="explain-model" className="block text-sm font-medium text-ink">
              Model
            </label>
            <select
              id="explain-model"
              value={selectedModel}
              onChange={(e) => { setSelectedModel(e.target.value); }}
              className="mt-1 block w-full rounded border border-ink/20 bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
            >
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          {formError !== null && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="self-start rounded bg-accent px-6 py-2 text-sm font-semibold text-ink-inverse hover:bg-accent-strong focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 disabled:opacity-50"
          >
            {submitting ? "Starting…" : "Explain"}
          </button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LaunchPage
// ---------------------------------------------------------------------------

type WorkflowSelection =
  | { kind: "workflow"; id: string }
  | { kind: "explain-plan" }
  | null;

export default function LaunchPage(): ReactNode {
  const [workflows, setWorkflows] = useState<WorkflowsResponse | null>(null);
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<WorkflowSelection>(null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      try {
        const [wf, mo] = await Promise.all([fetchWorkflows(), fetchModels()]);
        if (!active) return;
        setWorkflows(wf);
        setModels(mo.models);
        // Default select first workflow
        if (wf.descriptors[0] !== undefined) {
          setSelection({ kind: "workflow", id: wf.descriptors[0].workflowId });
        }
      } catch (err) {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load workflows";
        setLoadError(msg);
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  if (loadError !== null) {
    return (
      <section aria-labelledby="launch-heading">
        <h1 id="launch-heading" className="text-heading text-ink">
          Launch workflow
        </h1>
        <p role="alert" className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </p>
      </section>
    );
  }

  if (workflows === null) {
    return (
      <section aria-labelledby="launch-heading">
        <h1 id="launch-heading" className="text-heading text-ink">
          Launch workflow
        </h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">
          Loading workflows…
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="launch-heading">
      <h1 id="launch-heading" className="text-heading text-ink">
        Launch workflow
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Select a workflow, configure inputs, and start a run. Dry-run mode is the default — the
        model proposes a patch for review before any files are changed.
      </p>

      <div role="radiogroup" aria-label="Workflow selection" className="mt-section grid gap-6">
        {workflows.descriptors.map((descriptor) => (
          <WorkflowSection
            key={descriptor.workflowId}
            descriptor={descriptor}
            models={models}
            isSelected={
              selection?.kind === "workflow" && selection.id === descriptor.workflowId
            }
            onSelect={() => {
              setSelection({ kind: "workflow", id: descriptor.workflowId });
            }}
          />
        ))}

        <ExplainPlanSection
          models={models}
          isSelected={selection?.kind === "explain-plan"}
          onSelect={() => { setSelection({ kind: "explain-plan" }); }}
        />
      </div>
    </section>
  );
}
