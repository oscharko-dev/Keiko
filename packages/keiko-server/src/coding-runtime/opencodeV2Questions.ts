import type { OpenCodeQuestionRequest } from "./opencodeHttpClient.js";

type Form = Readonly<Record<string, unknown>>;
type Field = Readonly<Record<string, unknown>>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function v2FormId(questionId: string): string | undefined {
  return /^que_[A-Za-z0-9_-]{1,251}$/u.test(questionId) ? `frm_${questionId.slice(4)}` : undefined;
}

function fields(form: Form): readonly Field[] {
  if (!Array.isArray(form.fields) || form.fields.length === 0 || form.fields.length > 32) {
    throw new Error("opencode-v2-form-fields-invalid");
  }
  const result = form.fields.map((value: unknown) => record(value));
  if (result.includes(undefined)) throw new Error("opencode-v2-form-field-invalid");
  return result as readonly Field[];
}

function options(
  field: Field,
): readonly { readonly label: string; readonly description: string }[] {
  if (field.type === "boolean")
    return [
      { label: "Yes", description: "" },
      { label: "No", description: "" },
    ];
  if (field.options === undefined) return [];
  if (!Array.isArray(field.options) || field.options.length > 32) {
    throw new Error("opencode-v2-form-options-invalid");
  }
  return field.options.map((value: unknown) => {
    const option = record(value);
    if (typeof option?.label !== "string" || typeof option.value !== "string") {
      throw new TypeError("opencode-v2-form-option-invalid");
    }
    return {
      label: option.label,
      description: typeof option.description === "string" ? option.description : "",
    };
  });
}

function question(form: Form, field: Field): OpenCodeQuestionRequest["questions"][number] {
  if (field.hidden === true || field.when !== undefined || field.type === "external") {
    throw new Error("opencode-v2-form-field-unsupported");
  }
  const title = typeof field.title === "string" ? field.title : String(form.title);
  if (typeof field.key !== "string" || field.key.length === 0 || title.length === 0) {
    throw new Error("opencode-v2-form-field-invalid");
  }
  const selection = options(field);
  return {
    question: fieldDescription(field) ?? title,
    header: title.slice(0, 30),
    options: selection,
    multiple: field.type === "multiselect",
    custom: selection.length === 0 || field.custom === true,
  };
}

function fieldDescription(field: Field): string | undefined {
  return typeof field.description === "string" && field.description.length > 0
    ? field.description
    : undefined;
}

export function projectOpenCodeV2Form(form: Form): OpenCodeQuestionRequest {
  const id = form.id;
  if (
    typeof id !== "string" ||
    !/^frm_[A-Za-z0-9_-]{1,251}$/u.test(id) ||
    typeof form.sessionID !== "string" ||
    typeof form.title !== "string"
  ) {
    throw new Error("opencode-v2-form-invalid");
  }
  return {
    id: `que_${id.slice(4)}`,
    sessionID: form.sessionID,
    questions: fields(form).map((field) => question(form, field)),
  };
}

function selectedValue(field: Field, selection: string): string {
  if (Array.isArray(field.options)) {
    const option = field.options
      .map((value: unknown) => record(value))
      .find((value) => value?.label === selection);
    if (typeof option?.value === "string") return option.value;
  }
  if (field.custom === true || field.options === undefined) return selection;
  throw new Error("opencode-v2-form-selection-invalid");
}

function fieldAnswer(field: Field, selections: readonly string[]): unknown {
  if (field.type === "multiselect") return selections.map((value) => selectedValue(field, value));
  if (selections.length !== 1) throw new Error("opencode-v2-form-answer-invalid");
  const selection = selections[0];
  if (selection === undefined) throw new Error("opencode-v2-form-answer-invalid");
  if (field.type === "boolean") {
    if (selection !== "Yes" && selection !== "No")
      throw new Error("opencode-v2-form-answer-invalid");
    return selection === "Yes";
  }
  if (field.type === "number" || field.type === "integer") return numericAnswer(field, selection);
  if (field.type === "string") return selectedValue(field, selection);
  throw new Error("opencode-v2-form-field-unsupported");
}

function numericAnswer(field: Field, selection: string): number {
  const parsed = Number(selection);
  if (!Number.isFinite(parsed) || (field.type === "integer" && !Number.isSafeInteger(parsed))) {
    throw new Error("opencode-v2-form-answer-invalid");
  }
  return parsed;
}

export function answerOpenCodeV2Form(
  form: Form,
  selections: readonly (readonly string[])[],
): Readonly<Record<string, unknown>> {
  const configured = fields(form);
  if (configured.length !== selections.length) throw new Error("opencode-v2-form-answer-invalid");
  return Object.fromEntries(
    configured.map((field, index) => {
      const selected = selections[index];
      if (typeof field.key !== "string" || selected === undefined) {
        throw new Error("opencode-v2-form-answer-invalid");
      }
      return [field.key, fieldAnswer(field, selected)];
    }),
  );
}
