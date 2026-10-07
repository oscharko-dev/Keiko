import {
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
  type EditorAgentChangeset,
  type EditorAgentChangesetFile,
} from "@oscharko-dev/keiko-contracts/editor-agent";
import { DEFAULT_PATCH_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { lineDiffSide, unifiedDiffHunks } from "../gitDelivery/lineDiff.js";
import {
  secureWorkspaceTextDigest,
  type SecureWorkspaceTextReadFailure,
} from "./secureWorkspaceTextRead.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";

/**
 * Exact-text replacement edits for `keiko_changeset_edit` (#3873). A strict unified diff asks the
 * model for exact hunk headers, line numbers and context; in the live Gemma qualification two of
 * three such patches were refused as INVALID_EDITS even after tool text reached the model verbatim.
 * A replacement names the exact current text and its successor instead, the edit form coding agents
 * are trained on. It is materialized here, against the hash-bound current file, into the same
 * unified-diff changeset the governed editor path already validates, reviews and applies: no second
 * mutation path, no weaker precondition.
 *
 * Deletions and renames (#3873 follow-up): the model cannot write a `/dev/null` diff itself, so a
 * `deletions` path becomes its full pre-image removed, and a `renames` entry that removal plus the
 * creation of `to` with identical content. One call applies renames first, then edits (which address
 * a moved file by its new path), then deletions. Every touched path stays hash-bound through `files`
 * and counts against the same 50-file and 65,536-byte caps as a hand-written changeset.
 *
 * Bounds (#3873 review): an edited file may not grow past the governed read ceiling, projected from
 * the match count before any result is built, so a `replaceAll` that would multiply a file cannot
 * hold the event loop or the heap; the rendered changeset is held to the editor's patch cap and to
 * the changed-line limit the editor route applies (`DEFAULT_PATCH_LIMITS`) here, before the run's
 * patch budget is charged, with a closed reason the model can act on, instead of failing later as
 * an opaque invalid changeset. A deletion or a rename renders its whole file and cannot be split, so
 * one that alone exceeds a call's bounds is refused as `whole-file-too-large`, never "split it".
 */
export interface CodingToolReplacementEdit {
  readonly file: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean | undefined;
}

export interface CodingToolReplacementRename {
  readonly from: string;
  readonly to: string;
}

export interface CodingToolReplacementChangeset {
  readonly edits: readonly CodingToolReplacementEdit[];
  /** Files removed entirely, after the edits; each is hash-bound through `files`. */
  readonly deletions?: readonly string[] | undefined;
  /** Files moved before the edits; `to` is a new path bound to the empty-content digest. */
  readonly renames?: readonly CodingToolReplacementRename[] | undefined;
  readonly files: readonly EditorAgentChangesetFile[];
  readonly selectedFiles?: readonly string[] | undefined;
}

/**
 * The closed reasons a materialization read can fail with: the secure read's own vocabulary plus
 * the refusals of the governed read path that serves it (codingToolReadEditPorts.ts), so a refused
 * edit records which one it was instead of one collapsed "read failed" (#3873 review).
 */
export type GovernedWorkspaceReadFailure =
  | SecureWorkspaceTextReadFailure
  | "exception"
  | "postflight-refused"
  | "preflight-refused"
  | "response-too-large";

export type GovernedWorkspaceReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: GovernedWorkspaceReadFailure };

/** The read a materialization is served by: the governed workspace read, never a raw port. */
export interface ReplacementReadPort {
  readText(request: {
    readonly relativePath: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<GovernedWorkspaceReadResult>;
}

export type ReplacementRefusalCode =
  "INVALID_EDITS" | "CONTENT_HASH_MISMATCH" | "PRECONDITION_REQUIRED" | "LIMIT_EXCEEDED";

/**
 * Why a replacement changeset was refused before any editor action existed: body-free evidence for
 * the refused-edit line, so a lab run can tell a stale read from an ambiguous match (#3873 review).
 */
export const REPLACEMENT_REFUSALS = [
  "digest-unbound",
  "stale-digest",
  "file-missing",
  "create-over-content",
  "identical-strings",
  "old-string-not-found",
  "old-string-ambiguous",
  "no-change",
  "path-conflict",
  "selection-gap",
  "target-exists",
  "result-too-large",
  "patch-too-large",
  // #3873 review: the bounds the editor route applies, checked before the run's budget is charged.
  "changed-lines-exceeded",
  "whole-file-too-large",
  "escaped-line-break",
] as const;
export type ReplacementRefusal = (typeof REPLACEMENT_REFUSALS)[number];

export type ReplacementMaterialization =
  | { readonly status: "materialized"; readonly changeset: EditorAgentChangeset }
  | {
      readonly status: "refused";
      readonly reasonCode: ReplacementRefusalCode;
      readonly refusal: ReplacementRefusal;
      readonly message: string;
    }
  | {
      readonly status: "read-failed";
      readonly reason: GovernedWorkspaceReadFailure;
      /** The file whose governed read did not answer, so the refusal can name it. */
      readonly file: string;
    };

type Refusal = Extract<ReplacementMaterialization, { readonly status: "refused" }>;
type ReadFailed = Extract<ReplacementMaterialization, { readonly status: "read-failed" }>;

/** One materialized file: its unified-diff section and the read digest it is bound to. */
interface FileChange {
  readonly section: string;
  readonly binding: EditorAgentChangesetFile;
}

type StepOutcome =
  { readonly status: "changed"; readonly changes: readonly FileChange[] } | Refusal | ReadFailed;

type ApplyOutcome = { readonly status: "applied"; readonly content: string } | Refusal;

// The operations of one call in application order: renames, then edits, then deletions. An edit
// addressed to a rename target is folded into that rename's creation.
type Step =
  | {
      readonly kind: "rename";
      readonly from: string;
      readonly to: string;
      readonly edits: readonly CodingToolReplacementEdit[];
    }
  | {
      readonly kind: "edit";
      readonly file: string;
      readonly edits: readonly CodingToolReplacementEdit[];
    }
  | { readonly kind: "delete"; readonly file: string };

/** The digest a file that does not exist yet is bound to: a created file or a rename target. */
export const EMPTY_CONTENT_SHA256 = secureWorkspaceTextDigest("");

const RESULT_CEILING_MESSAGE = `larger than ${String(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)} bytes, which no governed read could return; split the edits or narrow replaceAll.`;

export function isReplacementChangeset(
  changeset: EditorAgentChangeset | CodingToolReplacementChangeset,
): changeset is CodingToolReplacementChangeset {
  return "edits" in changeset;
}

/**
 * The bytes a changeset carries as a request: the replacement text, and the paths of its deletions
 * and renames. Admission reserves them as the floor of the run's patch budget; the materialized diff
 * is charged on top once it exists (codingToolReadEditPorts.ts), because the envelope bounds what is
 * applied, not what was sent (#3873 review).
 */
export function changesetPayloadBytes(
  changeset: EditorAgentChangeset | CodingToolReplacementChangeset,
): number {
  if (!isReplacementChangeset(changeset)) return Buffer.byteLength(changeset.patch, "utf8");
  const texts = [
    ...changeset.edits.flatMap((edit) => [edit.oldString, edit.newString]),
    ...(changeset.deletions ?? []),
    ...(changeset.renames ?? []).flatMap((rename) => [rename.from, rename.to]),
  ];
  return texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
}

/**
 * Applies every operation to its file's current, hash-bound text and renders the unified diff:
 * renames first, then edits, then deletions.
 */
export async function materializeReplacementChangeset(
  read: ReplacementReadPort,
  changeset: CodingToolReplacementChangeset,
  signal: AbortSignal | undefined,
): Promise<ReplacementMaterialization> {
  const planned = planSteps(changeset);
  if ("status" in planned) return planned;
  const changes: FileChange[] = [];
  for (const step of planned.steps) {
    const outcome = await materializeStep(read, changeset.files, step, signal);
    if (outcome.status !== "changed") return outcome;
    const wholeFile = wholeFileRefusal(step, outcome.changes);
    if (wholeFile !== undefined) return wholeFile;
    changes.push(...outcome.changes);
  }
  return assembled(changes);
}

// The editor route refuses any diff text that carries a literal "\n" followed by "+", "-" or a space:
// keiko-tools' guard against a model collapsing a diff's lines into one (`hasEscapedDiffLineBreak`,
// pinned there by "rejects escaped newline artifacts inside diff body lines"). A rendered section
// carries file text, so a file line with such text, or a newString that writes one, can never pass
// that guard. It is refused here, before the run's patch budget is charged, with an action the model
// can take (#3873 review); a test runs the rendered diff through the engine to keep the two in step.
const ESCAPED_LINE_BREAK_MARKERS = [String.raw`\n+`, String.raw`\n-`, String.raw`\n `] as const;

function carriesEscapedLineBreak(section: string): boolean {
  return ESCAPED_LINE_BREAK_MARKERS.some((marker) => section.includes(marker));
}

// The lines a rendered section adds or removes; its two header lines are not counted.
function changedLineCount(section: string): number {
  return section
    .split("\n")
    .slice(2)
    .filter((line) => line.startsWith("+") || line.startsWith("-")).length;
}

// A deletion or a rename renders its whole file and cannot be split into smaller calls: one that
// alone exceeds what one call may carry is refused with that reason and an action the model can
// take, never "split it" (#3873 review). An edit is judged with the whole call in `assembled`.
function wholeFileRefusal(step: Step, changes: readonly FileChange[]): Refusal | undefined {
  if (step.kind === "edit") return undefined;
  const file = step.kind === "rename" ? step.from : step.file;
  const verb = step.kind === "rename" ? "moved" : "deleted";
  if (changes.some((change) => carriesEscapedLineBreak(change.section))) {
    return refused(
      "LIMIT_EXCEEDED",
      "escaped-line-break",
      `${file} cannot be ${verb} with keiko_changeset_edit: its text contains a literal backslash-n followed by +, - or a space, which the governed editor refuses in a diff. Leave it in place and report it to the operator.`,
    );
  }
  const bytes = changes.reduce((sum, change) => sum + Buffer.byteLength(change.section, "utf8"), 0);
  const lines = changes.reduce((sum, change) => sum + changedLineCount(change.section), 0);
  if (
    bytes <= EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES &&
    lines <= DEFAULT_PATCH_LIMITS.maxChangedLines
  ) {
    return undefined;
  }
  return refused(
    "LIMIT_EXCEEDED",
    "whole-file-too-large",
    `${file} cannot be ${verb} with keiko_changeset_edit: a ${step.kind === "rename" ? "rename" : "deletion"} renders the whole file (${String(lines)} changed lines, ${String(bytes)} bytes), more than one call may carry (${String(DEFAULT_PATCH_LIMITS.maxChangedLines)} lines, ${String(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)} bytes). Leave it in place and report it to the operator.`,
  );
}

function assembled(changes: readonly FileChange[]): ReplacementMaterialization {
  const escaped = changes.find((change) => carriesEscapedLineBreak(change.section));
  if (escaped !== undefined) {
    return refused(
      "INVALID_EDITS",
      "escaped-line-break",
      `The edit of ${escaped.binding.file} would render a literal backslash-n followed by +, - or a space (from newString, or from a file line within three lines of the edit), which the governed editor refuses in a diff. Keep such text out of newString, or edit lines further away from it.`,
    );
  }
  const patch = changes.map((change) => change.section).join("");
  if (Buffer.byteLength(patch, "utf8") > EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES) {
    return refused(
      "LIMIT_EXCEEDED",
      "patch-too-large",
      `The materialized changeset exceeds ${String(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)} bytes; split it into smaller calls.`,
    );
  }
  const changedLines = changes.reduce((sum, change) => sum + changedLineCount(change.section), 0);
  if (changedLines > DEFAULT_PATCH_LIMITS.maxChangedLines) {
    return refused(
      "LIMIT_EXCEEDED",
      "changed-lines-exceeded",
      `The materialized changeset changes ${String(changedLines)} lines, more than the ${String(DEFAULT_PATCH_LIMITS.maxChangedLines)} one call may change; split the edits into smaller calls.`,
    );
  }
  const bindings = changes.map((change) => change.binding);
  return {
    status: "materialized",
    changeset: { patch, files: bindings, selectedFiles: bindings.map((binding) => binding.file) },
  };
}

// Structural validation before any file is read: every path plays one role, a renamed-away path is
// addressed by nobody, and a supplied selectedFiles covers every touched path (a partial call would
// otherwise apply half a rename, or a selection disjoint from the edits would widen to all of them).
function planSteps(
  changeset: CodingToolReplacementChangeset,
): { readonly steps: readonly Step[] } | Refusal {
  const renames = changeset.renames ?? [];
  const deletions = changeset.deletions ?? [];
  const edits = editsByFile(changeset.edits);
  const conflict = operationConflict(renames, deletions, edits);
  if (conflict !== undefined) return refused("INVALID_EDITS", "path-conflict", conflict);
  const touched = [
    ...renames.flatMap((rename) => [rename.from, rename.to]),
    ...edits.keys(),
    ...deletions,
  ];
  const gap = selectionGap(changeset.selectedFiles, touched);
  if (gap !== undefined) return refused("INVALID_EDITS", "selection-gap", gap);
  const renamedTo = new Set(renames.map((rename) => rename.to));
  const steps: Step[] = [
    ...renames.map(({ from, to }): Step => ({
      kind: "rename",
      from,
      to,
      edits: edits.get(to) ?? [],
    })),
    ...[...edits]
      .filter(([file]) => !renamedTo.has(file))
      .map(([file, fileEdits]): Step => ({ kind: "edit", file, edits: fileEdits })),
    ...deletions.map((file): Step => ({ kind: "delete", file })),
  ];
  return steps.length === 0
    ? refused(
        "INVALID_EDITS",
        "no-change",
        "The changeset changes nothing; add an edit, a rename or a deletion.",
      )
    : { steps };
}

function operationConflict(
  renames: readonly CodingToolReplacementRename[],
  deletions: readonly string[],
  edits: ReadonlyMap<string, readonly CodingToolReplacementEdit[]>,
): string | undefined {
  const renamedFrom = new Set<string>();
  const claimed = new Set<string>();
  for (const { from, to } of renames) {
    const message = renameConflict(from, to, claimed, edits);
    if (message !== undefined) return message;
    claimed.add(from).add(to);
    renamedFrom.add(from);
  }
  for (const file of deletions) {
    if (renamedFrom.has(file)) return `${file} no longer exists after the renames in this call.`;
    if (claimed.has(file)) return `${file} is named more than once in this call.`;
    if (edits.has(file))
      return `${file} is both edited and deleted in this call; drop one of them.`;
    claimed.add(file);
  }
  return undefined;
}

function renameConflict(
  from: string,
  to: string,
  claimed: ReadonlySet<string>,
  edits: ReadonlyMap<string, readonly CodingToolReplacementEdit[]>,
): string | undefined {
  if (from === to) return `${from} is renamed to itself.`;
  if (claimed.has(from) || claimed.has(to)) {
    return `${claimed.has(from) ? from : to} is named more than once in this call.`;
  }
  if (edits.has(from)) {
    return `${from} no longer exists after the renames in this call; address its edits to ${to}.`;
  }
  return undefined;
}

function selectionGap(
  selectedFiles: readonly string[] | undefined,
  touched: readonly string[],
): string | undefined {
  if (selectedFiles === undefined) return undefined;
  const selected = new Set(selectedFiles);
  const missing = touched.find((file) => !selected.has(file));
  return missing === undefined ? undefined : `List ${missing} in selectedFiles.`;
}

function editsByFile(
  edits: readonly CodingToolReplacementEdit[],
): ReadonlyMap<string, readonly CodingToolReplacementEdit[]> {
  const grouped = new Map<string, CodingToolReplacementEdit[]>();
  for (const edit of edits) {
    const existing = grouped.get(edit.file);
    if (existing === undefined) grouped.set(edit.file, [edit]);
    else existing.push(edit);
  }
  return grouped;
}

function materializeStep(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  step: Step,
  signal: AbortSignal | undefined,
): Promise<StepOutcome> {
  switch (step.kind) {
    case "rename":
      return materializeRename(read, files, step, signal);
    case "edit":
      return materializeFile(read, files, step.file, step.edits, signal);
    case "delete":
      return materializeDeletion(read, files, step.file, signal);
  }
}

async function materializeFile(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  file: string,
  edits: readonly CodingToolReplacementEdit[],
  signal: AbortSignal | undefined,
): Promise<StepOutcome> {
  const expectedContentHash = declaredHash(files, file);
  if (typeof expectedContentHash !== "string") return expectedContentHash;
  const current = await currentText(read, file, expectedContentHash, signal);
  if (!("before" in current)) return current;
  const applied = applyEdits(file, current.before, edits);
  if (applied.status !== "applied") return applied;
  if (applied.content === (current.before ?? "")) {
    return refused("INVALID_EDITS", "no-change", `The edits leave ${file} unchanged.`);
  }
  return changed(unifiedDiffSection(file, current.before, applied.content), {
    file,
    expectedContentHash,
  });
}

async function materializeRename(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  step: Extract<Step, { readonly kind: "rename" }>,
  signal: AbortSignal | undefined,
): Promise<StepOutcome> {
  const source = await existingSource(read, files, step.from, signal);
  if (!("before" in source)) return source;
  const target = await renameTargetRefusal(read, files, step.to, signal);
  if (target !== undefined) return target;
  const applied = applyEdits(step.to, source.before, step.edits);
  if (applied.status !== "applied") return applied;
  return {
    status: "changed",
    changes: [
      {
        section: unifiedDiffSection(step.from, source.before, undefined),
        binding: { file: step.from, expectedContentHash: source.expectedContentHash },
      },
      {
        section: unifiedDiffSection(step.to, undefined, applied.content),
        binding: { file: step.to, expectedContentHash: EMPTY_CONTENT_SHA256 },
      },
    ],
  };
}

async function materializeDeletion(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  file: string,
  signal: AbortSignal | undefined,
): Promise<StepOutcome> {
  const source = await existingSource(read, files, file, signal);
  if (!("before" in source)) return source;
  return changed(unifiedDiffSection(file, source.before, undefined), {
    file,
    expectedContentHash: source.expectedContentHash,
  });
}

function changed(section: string, binding: EditorAgentChangesetFile): StepOutcome {
  return { status: "changed", changes: [{ section, binding }] };
}

function declaredHash(files: readonly EditorAgentChangesetFile[], file: string): string | Refusal {
  const expectedContentHash = files.find(
    (candidate) => candidate.file === file,
  )?.expectedContentHash;
  return (
    expectedContentHash ??
    refused(
      "PRECONDITION_REQUIRED",
      "digest-unbound",
      `List ${file} in files with the digest from its latest keiko_workspace_read.`,
    )
  );
}

// The hash-bound current text of a file that must exist: the source of a rename or a deletion.
async function existingSource(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  file: string,
  signal: AbortSignal | undefined,
): Promise<
  { readonly before: string; readonly expectedContentHash: string } | Refusal | ReadFailed
> {
  const expectedContentHash = declaredHash(files, file);
  if (typeof expectedContentHash !== "string") return expectedContentHash;
  const current = await currentText(read, file, expectedContentHash, signal);
  if (!("before" in current)) return current;
  if (current.before === undefined) {
    return refused("INVALID_EDITS", "file-missing", `${file} does not exist.`);
  }
  return { before: current.before, expectedContentHash };
}

// A rename target is a new file: bound to the empty-content digest like a created file, and absent
// from the workspace. A denied or otherwise unreadable target is a governed read failure.
async function renameTargetRefusal(
  read: ReplacementReadPort,
  files: readonly EditorAgentChangesetFile[],
  to: string,
  signal: AbortSignal | undefined,
): Promise<Refusal | ReadFailed | undefined> {
  const declared = files.find((candidate) => candidate.file === to)?.expectedContentHash;
  if (declared !== EMPTY_CONTENT_SHA256) {
    return refused(
      declared === undefined ? "PRECONDITION_REQUIRED" : "CONTENT_HASH_MISMATCH",
      declared === undefined ? "digest-unbound" : "stale-digest",
      `List ${to} in files with the empty-content SHA-256 ${EMPTY_CONTENT_SHA256}; a rename target is a new file.`,
    );
  }
  const current = await read.readText({ relativePath: to, signal });
  if (current.ok) {
    return refused(
      "INVALID_EDITS",
      "target-exists",
      `${to} already exists; a rename target must be a new path.`,
    );
  }
  return current.reason === "not-found"
    ? undefined
    : { status: "read-failed", reason: current.reason, file: to };
}

// The hash-bound current text of a file: `undefined` for a file that does not exist yet.
async function currentText(
  read: ReplacementReadPort,
  file: string,
  expectedContentHash: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly before: string | undefined } | Refusal | ReadFailed> {
  const current = await read.readText({ relativePath: file, signal });
  if (!current.ok && current.reason !== "not-found") {
    return { status: "read-failed", reason: current.reason, file };
  }
  const before = current.ok ? current.text : undefined;
  if (secureWorkspaceTextDigest(before ?? "") !== expectedContentHash) {
    return refused(
      "CONTENT_HASH_MISMATCH",
      "stale-digest",
      `${file} changed since the read that produced its digest; re-read it before editing.`,
    );
  }
  return { before };
}

// Every intermediate result is held to the governed read ceiling in bytes as well: the projection in
// `replaceIn` bounds code units, and a result the model could never read back is refused outright.
function applyEdits(
  file: string,
  before: string | undefined,
  edits: readonly CodingToolReplacementEdit[],
): ApplyOutcome {
  let content = before;
  for (const [index, edit] of edits.entries()) {
    const next = applyEdit(file, content, edit, index === 0);
    if (next.status !== "applied") return next;
    if (Buffer.byteLength(next.content, "utf8") > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) {
      return resultTooLarge(file);
    }
    content = next.content;
  }
  return { status: "applied", content: content ?? "" };
}

function applyEdit(
  file: string,
  content: string | undefined,
  edit: CodingToolReplacementEdit,
  first: boolean,
): ApplyOutcome {
  if (edit.oldString === "") {
    return first && (content === undefined || content === "")
      ? { status: "applied", content: edit.newString }
      : refused(
          "INVALID_EDITS",
          "create-over-content",
          `An empty oldString only creates a new file; ${file} has content.`,
        );
  }
  if (content === undefined) {
    return refused(
      "INVALID_EDITS",
      "file-missing",
      `${file} does not exist; create it with an empty oldString.`,
    );
  }
  if (edit.oldString === edit.newString) {
    return refused(
      "INVALID_EDITS",
      "identical-strings",
      `oldString and newString are identical for ${file}.`,
    );
  }
  return replaceIn(file, content, edit);
}

// The tool contract asks for `oldString` byte for byte, so the exact text is matched first; only an
// `oldString` with no exact occurrence falls back to a line-ending-insensitive match, with every
// "\r\n" of the file and both strings read as "\n", because a model may read a CRLF file's lines
// without their carriage returns and a file with mixed endings must still match (#3873 review). A
// byte-exact match therefore never becomes "not found" over a trailing carriage return, nor
// ambiguous through normalization. Every line the replacement leaves unchanged keeps its own ending;
// a line it changes or adds takes the replaced line's ending or the file's majority ending.
function replaceIn(file: string, content: string, edit: CodingToolReplacementEdit): ApplyOutcome {
  const exact = occurrencesOf(content, edit.oldString);
  const normalized =
    exact.length > 0 ? { text: content, collapsed: [] } : normalizeLineEndings(content);
  const needle = exact.length > 0 ? edit.oldString : edit.oldString.replaceAll("\r\n", "\n");
  const starts = exact.length > 0 ? exact : occurrencesOf(normalized.text, needle);
  if (starts.length === 0) {
    return refused(
      "INVALID_EDITS",
      "old-string-not-found",
      `oldString was not found in ${file}; copy the exact current text from a fresh read.`,
    );
  }
  if (starts.length > 1 && edit.replaceAll !== true) {
    return refused(
      "INVALID_EDITS",
      "old-string-ambiguous",
      `oldString matches ${String(starts.length)} places in ${file}; add surrounding lines or set replaceAll.`,
    );
  }
  const replacement = edit.newString.replaceAll("\r\n", "\n");
  // The result is bounded before it is built: a replaced region is at least as long as the needle
  // and a replacement at most as long as its text plus one carriage return per line break.
  const growth = replacement.length + occurrencesOf(replacement, "\n").length - needle.length;
  if (content.length + starts.length * growth > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) {
    return resultTooLarge(file);
  }
  return { status: "applied", content: spliced(content, normalized, starts, needle, replacement) };
}

function resultTooLarge(file: string): Refusal {
  return refused(
    "LIMIT_EXCEEDED",
    "result-too-large",
    `The edits make ${file} ${RESULT_CEILING_MESSAGE}`,
  );
}

function spliced(
  content: string,
  normalized: NormalizedText,
  starts: readonly number[],
  needle: string,
  replacement: string,
): string {
  const majority = majorityLineEnding(content);
  let out = "";
  let cursor = 0;
  for (const start of starts) {
    const from = originalOffset(normalized.collapsed, start);
    const to = originalOffset(normalized.collapsed, start + needle.length);
    out += content.slice(cursor, from);
    out += withRegionEndings(content.slice(from, to), replacement, majority);
    cursor = to;
  }
  return out + content.slice(cursor);
}

interface NormalizedText {
  readonly text: string;
  /** The normalized indexes of the line feeds that were "\r\n" in the original, ascending. */
  readonly collapsed: readonly number[];
}

function normalizeLineEndings(text: string): NormalizedText {
  if (!text.includes("\r\n")) return { text, collapsed: [] };
  const collapsed: number[] = [];
  let out = "";
  let from = 0;
  let at = text.indexOf("\r\n");
  while (at !== -1) {
    out += text.slice(from, at);
    collapsed.push(out.length);
    out += "\n";
    from = at + 2;
    at = text.indexOf("\r\n", from);
  }
  return { text: out + text.slice(from), collapsed };
}

// A normalized offset plus the carriage returns dropped before it: a match that starts on a
// collapsed line feed starts on its carriage return, and one that ends after it includes both.
function originalOffset(collapsed: readonly number[], normalizedOffset: number): number {
  let low = 0;
  let high = collapsed.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((collapsed[mid] ?? Number.POSITIVE_INFINITY) < normalizedOffset) low = mid + 1;
    else high = mid;
  }
  return normalizedOffset + low;
}

function occurrencesOf(haystack: string, needle: string): number[] {
  const starts: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    starts.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return starts;
}

function lineEndingsOf(text: string): string[] {
  const endings: string[] = [];
  let at = text.indexOf("\n");
  while (at !== -1) {
    endings.push(at > 0 && text[at - 1] === "\r" ? "\r\n" : "\n");
    at = text.indexOf("\n", at + 1);
  }
  return endings;
}

function majorityLineEnding(content: string): string {
  const endings = lineEndingsOf(content);
  const crlf = endings.filter((ending) => ending === "\r\n").length;
  return crlf > endings.length - crlf ? "\r\n" : "\n";
}

// The endings of the replacement's lines, chosen by line identity rather than by position: a line
// the replacement shares with the replaced region — in their common leading or trailing run — keeps
// that region line's own ending; a changed line keeps the ending of the region line at its place
// when the line count is unchanged, and an added line takes the file's majority ending (#3873
// review: an inserted line must never move a neighbouring line's ending).
function withRegionEndings(region: string, replacement: string, majority: string): string {
  const parts = replacement.split("\n");
  if (parts.length === 1) return replacement;
  const regionLines = region.replaceAll("\r\n", "\n").split("\n").slice(0, -1);
  const endings = lineEndingsOf(region);
  const lines = parts.slice(0, -1);
  const lead = commonRun(lines, regionLines, (index) => index);
  const trail = commonRun(
    lines.slice(lead),
    regionLines.slice(lead),
    (index, length) => length - 1 - index,
  );
  return lines
    .map(
      (line, index) =>
        line + lineEnding(index, { lines, regionLines, endings, lead, trail, majority }),
    )
    .concat(parts.at(-1) ?? "")
    .join("");
}

interface LineEndingChoice {
  readonly lines: readonly string[];
  readonly regionLines: readonly string[];
  readonly endings: readonly string[];
  readonly lead: number;
  readonly trail: number;
  readonly majority: string;
}

function lineEnding(index: number, choice: LineEndingChoice): string {
  const { lines, regionLines, endings, lead, trail, majority } = choice;
  if (index < lead) return endings[index] ?? majority;
  const fromEnd = lines.length - 1 - index;
  if (fromEnd < trail) return endings[regionLines.length - 1 - fromEnd] ?? majority;
  return lines.length === regionLines.length ? (endings[index] ?? majority) : majority;
}

// The length of the run of equal lines the two lists share, read from the start or from the end.
function commonRun(
  a: readonly string[],
  b: readonly string[],
  at: (index: number, length: number) => number,
): number {
  let run = 0;
  while (run < a.length && run < b.length && a[at(run, a.length)] === b[at(run, b.length)]) {
    run += 1;
  }
  return run;
}

// `undefined` on either side is the absent file: a creation from, or a deletion to, `/dev/null`. An
// empty file on the present side yields a header-only section, which the patch engine applies as-is.
function unifiedDiffSection(
  file: string,
  before: string | undefined,
  after: string | undefined,
): string {
  const oldHeader = before === undefined ? "--- /dev/null" : `--- a/${file}`;
  const newHeader = after === undefined ? "+++ /dev/null" : `+++ b/${file}`;
  const header = `${oldHeader}\n${newHeader}\n`;
  const hunks = unifiedDiffHunks(lineDiffSide(before ?? ""), lineDiffSide(after ?? ""));
  return hunks.length === 0 ? header : `${header}${hunks.join("\n")}\n`;
}

function refused(
  reasonCode: ReplacementRefusalCode,
  refusal: ReplacementRefusal,
  message: string,
): Refusal {
  return { status: "refused", reasonCode, refusal, message };
}
