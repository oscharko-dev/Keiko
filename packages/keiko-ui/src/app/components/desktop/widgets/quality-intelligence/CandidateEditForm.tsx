"use client";

// Inline edit form for a single QI candidate (Issue #727, Epic #712). Renders labelled controls for
// the editable fields, computes the minimal changed-field diff on Save, and submits it through the
// `onSave` handler (which calls the BFF edit route + reloads the run detail). Escape cancels.
// Keyboard-accessible: every control is labelled; Escape on any field cancels without persisting.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  QualityIntelligence,
  type QualityIntelligenceUiCandidate,
  type QualityIntelligenceCandidateEditableFields,
  type QualityIntelligencePriority,
  type QualityIntelligenceRiskClass,
} from "@oscharko-dev/keiko-contracts";
import { formatError } from "./qiShared";

const QUALITY_INTELLIGENCE_PRIORITIES = QualityIntelligence.QUALITY_INTELLIGENCE_PRIORITIES;
const QUALITY_INTELLIGENCE_RISK_CLASSES = QualityIntelligence.QUALITY_INTELLIGENCE_RISK_CLASSES;

const linesToList = (value: string): readonly string[] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const tagsToList = (value: string): readonly string[] =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

interface FormState {
  readonly title: string;
  readonly preconditions: string;
  readonly steps: string;
  readonly expectedResults: string;
  readonly priority: QualityIntelligencePriority;
  readonly riskClass: QualityIntelligenceRiskClass;
  readonly tags: string;
}

function initialState(candidate: QualityIntelligenceUiCandidate): FormState {
  return {
    title: candidate.title,
    preconditions: candidate.preconditions.join("\n"),
    steps: candidate.steps.join("\n"),
    expectedResults: candidate.expectedResults.join("\n"),
    priority: candidate.priority,
    riskClass: candidate.riskClass,
    tags: candidate.tags.join(", "),
  };
}

// Build the minimal set of changed fields. Only fields that differ from the candidate are included,
// so the request mirrors the reviewer's intent and untouched fields are never re-sent.
function diffEdited(
  candidate: QualityIntelligenceUiCandidate,
  state: FormState,
): QualityIntelligenceCandidateEditableFields {
  const preconditions = linesToList(state.preconditions);
  const steps = linesToList(state.steps);
  const expectedResults = linesToList(state.expectedResults);
  const tags = tagsToList(state.tags);
  return {
    ...(state.title !== candidate.title ? { title: state.title } : {}),
    ...(!sameList(preconditions, candidate.preconditions) ? { preconditions } : {}),
    ...(!sameList(steps, candidate.steps) ? { steps } : {}),
    ...(!sameList(expectedResults, candidate.expectedResults) ? { expectedResults } : {}),
    ...(state.priority !== candidate.priority ? { priority: state.priority } : {}),
    ...(state.riskClass !== candidate.riskClass ? { riskClass: state.riskClass } : {}),
    ...(!sameList(tags, candidate.tags) ? { tags } : {}),
  };
}

function TextAreaField({
  id,
  label,
  value,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (next: string) => void;
}): ReactNode {
  return (
    <label className="qi-edit-field" htmlFor={id}>
      <span className="qi-edit-label">{label}</span>
      <textarea
        id={id}
        className="qi-edit-textarea"
        value={value}
        rows={3}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </label>
  );
}

function InputField({
  id,
  label,
  value,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (next: string) => void;
}): ReactNode {
  return (
    <label className="qi-edit-field" htmlFor={id}>
      <span className="qi-edit-label">{label}</span>
      <input
        id={id}
        className="qi-edit-input"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </label>
  );
}

function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly disabled?: boolean;
  readonly onChange: (next: T) => void;
}): ReactNode {
  return (
    <label className="qi-edit-field" htmlFor={id}>
      <span className="qi-edit-label">{label}</span>
      <select
        id={id}
        className="qi-edit-select"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value as T);
        }}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

// Save/Cancel use aria-disabled (NOT native disabled) while a save is in flight: the just-activated
// Save button keeps focus, so on the error path (form stays open) the keyboard user is not dropped
// to <body> and Escape keeps working. Activation is blocked by handler guards instead.
function EditActions({
  onCancel,
  saving,
}: {
  readonly onCancel: () => void;
  readonly saving: boolean;
}): ReactNode {
  return (
    <div className="qi-edit-actions">
      <button
        type="submit"
        className="qi-btn qi-btn-approve qi-edit-save"
        aria-disabled={saving || undefined}
      >
        Save
      </button>
      <button
        type="button"
        className="qi-btn qi-btn-secondary qi-edit-cancel"
        aria-disabled={saving || undefined}
        onClick={() => {
          if (!saving) onCancel();
        }}
      >
        Cancel
      </button>
    </div>
  );
}

export interface CandidateEditFormProps {
  readonly candidate: QualityIntelligenceUiCandidate;
  readonly onSave: (edited: QualityIntelligenceCandidateEditableFields) => Promise<void> | void;
  readonly onCancel: () => void;
}

export function CandidateEditForm({
  candidate,
  onSave,
  onCancel,
}: CandidateEditFormProps): ReactNode {
  const [state, setState] = useState<FormState>(() => initialState(candidate));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setSaveError(null);
    setConfirmDiscard(false);
    setState((prev) => ({ ...prev, [key]: value }));
  };
  // Cancelling with unsaved edits requires a second activation (two-stage discard): a stray Escape
  // mid-typing must not silently destroy minutes of editing. A pristine form closes immediately.
  const requestCancel = useCallback((): void => {
    if (saving) return;
    const dirty = Object.keys(diffEdited(candidate, state)).length > 0;
    if (!dirty || confirmDiscard) {
      onCancel();
      return;
    }
    setConfirmDiscard(true);
  }, [candidate, confirmDiscard, onCancel, saving, state]);
  // Escape cancels the edit. Handled as a document keydown listener scoped to the form's lifetime
  // rather than a JSX handler on the (non-interactive) <form>, so the keyboard affordance works for
  // the whole open form without a noninteractive-element a11y violation. Scoped to THIS form: only
  // cancel when focus is inside it, so with multiple cards open at once Escape closes just the
  // focused one (not every open form).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || saving) return;
      const form = formRef.current;
      if (form !== null && form.contains(document.activeElement)) requestCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [requestCancel, saving]);
  // Move focus into the form when it opens. The inline form replaces the (now-removed) Edit button,
  // so without this a keyboard user would be dropped to <body>; CandidatesPane restores focus to the
  // Edit trigger on close. Done via a ref (not the autoFocus prop) to satisfy jsx-a11y/no-autofocus.
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input.qi-edit-input")?.focus();
  }, []);
  const id = `qi-edit-${candidate.id}`;
  const handleSubmit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(diffEdited(candidate, state));
    } catch (error) {
      setSaveError(formatError(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      ref={formRef}
      className="qi-edit-form"
      aria-label={`Edit ${candidate.title}`}
      aria-busy={saving}
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
    >
      <InputField
        id={`${id}-title`}
        label="Title"
        value={state.title}
        disabled={saving}
        onChange={(v) => {
          set("title", v);
        }}
      />
      {saveError !== null ? (
        <p className="qi-edit-error" role="alert" aria-live="assertive">
          {saveError}
        </p>
      ) : null}
      {/* a11y m-01: persistent live region — a role="status" inserted together with its text is
          unreliably announced by AT, so mount it always (empty, no visible box) and toggle the
          text when a discard is pending. */}
      <p className="qi-edit-discard-note" role="status" aria-live="polite">
        {confirmDiscard
          ? "Unsaved changes — press Escape or activate Cancel again to discard them."
          : ""}
      </p>
      <EditActions onCancel={requestCancel} saving={saving} />
      <TextAreaField
        id={`${id}-preconditions`}
        label="Preconditions (one per line)"
        value={state.preconditions}
        disabled={saving}
        onChange={(v) => {
          set("preconditions", v);
        }}
      />
      <TextAreaField
        id={`${id}-steps`}
        label="Steps (one per line)"
        value={state.steps}
        disabled={saving}
        onChange={(v) => {
          set("steps", v);
        }}
      />
      <TextAreaField
        id={`${id}-expected`}
        label="Expected results (one per line)"
        value={state.expectedResults}
        disabled={saving}
        onChange={(v) => {
          set("expectedResults", v);
        }}
      />
      <SelectField
        id={`${id}-priority`}
        label="Priority"
        value={state.priority}
        options={QUALITY_INTELLIGENCE_PRIORITIES}
        disabled={saving}
        onChange={(v) => {
          set("priority", v);
        }}
      />
      <SelectField
        id={`${id}-risk`}
        label="Risk class"
        value={state.riskClass}
        options={QUALITY_INTELLIGENCE_RISK_CLASSES}
        disabled={saving}
        onChange={(v) => {
          set("riskClass", v);
        }}
      />
      <InputField
        id={`${id}-tags`}
        label="Tags (comma-separated)"
        value={state.tags}
        disabled={saving}
        onChange={(v) => {
          set("tags", v);
        }}
      />
    </form>
  );
}
