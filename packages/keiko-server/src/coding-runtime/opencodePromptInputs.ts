import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, basename } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isCodingWorkbenchPromptReferencePath,
  type CodingWorkbenchPromptDelivery,
  type CodingWorkbenchPromptReference,
  type CodingWorkbenchRuntimePromptInputs,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type { OpenCodeToolProfile } from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { errorKindOf, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import {
  WorkspaceDescriptorReadError,
  nodeWorkspaceFs,
} from "@oscharko-dev/keiko-workspace/internal/fs";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { createOpenCodeNativeMessageIdMinter } from "./opencodeNativeMessageId.js";
import type { OpenCodeRuntimeAdapter } from "./opencodeRuntimeAdapter.js";
import {
  classifyOpenCodeV2PromptFailure,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * What the prompt of a native OpenCode run may carry besides its text (#3897, ADR-0137 D10): a
 * message that joins the turn that is running (`steer` / `queue`) and workspace files the human
 * referenced with `@`. Both are human-authored intent for the run's own session, so they only need
 * the session's mode-independent boundaries, which this module owns for files: a reference must
 * name a plain, contained, non-sensitive UTF-8 text file inside the run's workspace root, within
 * bounds that keep the model request and the runtime's history reads small.
 */

/** One referenced file's ceiling. The runtime embeds the bytes (base64) in the session's history. */
export const OPENCODE_PROMPT_FILE_MAX_BYTES = 64 * 1024;
/** What one prompt's references may add up to. */
export const OPENCODE_PROMPT_FILES_MAX_BYTES = 3 * OPENCODE_PROMPT_FILE_MAX_BYTES;
/**
 * What all the references of one run may add up to. Every attachment stays in the session's history
 * and the Workbench reads that history back whole, so an unbounded sum would let a long session
 * outgrow the history read instead of being refused at the prompt that crossed the bound.
 */
export const OPENCODE_PROMPT_RUN_FILES_MAX_BYTES = 1024 * 1024;

/**
 * The prompt inputs an OpenCode tool profile can honour. Only the native service governs them: it
 * reads the attachment inside the run's confinement (the credential names are kernel-denied) and
 * runs the steered message under its own agent policy. The mapped profiles answer nothing and the
 * server refuses what they were not offered, exactly like a `plan` request (`openCodeSelectableAgents`).
 */
export function openCodePromptInputs(
  profile: OpenCodeToolProfile,
): CodingWorkbenchRuntimePromptInputs {
  const native = profile === "native";
  return { delivery: native, references: native };
}

/** What a turn asks of the prompt beyond its text; `delivery` absent means an ordinary turn. */
export interface PromptInputsRequest {
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  readonly references?: readonly CodingWorkbenchPromptReference[] | undefined;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
  /**
   * The operator request this prompt belongs to (the dispatcher's single-use request id). A delivery
   * binds its native message id to it, so a retry of the same request resends the same id.
   */
  readonly requestId?: string | undefined;
}

/** One attachment in the runtime's own words: the absolute file URI and the file's name. */
export interface PromptFileAttachment {
  readonly uri: string;
  readonly name: string;
}

/** What the Activity Log may say about a prompt's inputs: a closed word and counts, no path. */
export interface PromptInputsSummary {
  readonly delivery?: CodingWorkbenchPromptDelivery | undefined;
  readonly referenceCount: number;
  /** Request-scoped diagnostic join; never persisted or forwarded to the model. */
  readonly correlationId?: string | undefined;
  /**
   * The operator request, set only on inputs admitted for a request the dispatcher already
   * reserved, so it is always a valid request id; a refusal at admission never names one.
   */
  readonly requestId?: string | undefined;
}

/** Prompt inputs that passed admission and are exactly what the runtime is sent. */
export interface AdmittedPromptInputs extends PromptInputsSummary {
  readonly files: readonly PromptFileAttachment[];
  /** The attached files' size, counted against the run's budget once the prompt is accepted. */
  readonly fileBytes: number;
}

/** Why admission refused; closed, body-free, and the whole of what the Activity Log records. */
export type PromptInputsRefusal =
  | "delivery-unsupported"
  | "references-unsupported"
  | "run-unavailable"
  | "turn-not-running"
  | "reference-invalid"
  | "reference-outside-workspace"
  | "reference-sensitive"
  | "reference-not-file"
  | "reference-not-text"
  | "reference-too-large"
  | "references-prompt-budget"
  | "references-run-budget"
  | "reference-unreadable"
  | "delivery-refused"
  | "delivery-unconfirmed"
  | "request-conflict";

export type PromptInputsAdmission =
  | { readonly ok: true; readonly inputs: AdmittedPromptInputs }
  | { readonly ok: false; readonly reason: PromptInputsRefusal };

interface ResolvedReference {
  readonly real: string;
  readonly attachment: PromptFileAttachment;
  readonly bytes: number;
}

/**
 * A prompt that cannot be admitted. It carries the closed reason and nothing of the path, the name
 * or the underlying failure, so it can be recorded and shown as it is.
 */
class PromptInputsRefused extends Error {
  public constructor(public readonly reason: PromptInputsRefusal) {
    super(`prompt-inputs-${reason}`);
    this.name = "PromptInputsRefused";
  }
}

const DESCRIPTOR_FAILURES: Readonly<Record<string, PromptInputsRefusal>> = {
  "outside-root": "reference-outside-workspace",
  "not-regular": "reference-not-file",
  "hard-link": "reference-not-file",
  "too-large": "reference-too-large",
};

function canonical(path: string): string {
  try {
    return nodeWorkspaceFs.realPath(path);
  } catch {
    throw new PromptInputsRefused("reference-unreadable");
  }
}

/** The path relative to the root as a POSIX string, or undefined when it leaves the root. */
function containedRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(sep).join("/");
}

function readDescriptorText(root: string, real: string): { rawText: string; sizeBytes: number } {
  const read = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
  if (read === undefined) throw new PromptInputsRefused("reference-unreadable");
  try {
    // `reject`: a second hard link may name a file outside the workspace; `complete`: a file above
    // the bound is refused, never silently cut.
    return read(root, real, OPENCODE_PROMPT_FILE_MAX_BYTES, "reject", "complete");
  } catch (error) {
    const known = error instanceof WorkspaceDescriptorReadError ? error.reason : undefined;
    throw new PromptInputsRefused(
      (known === undefined ? undefined : DESCRIPTOR_FAILURES[known]) ?? "reference-unreadable",
    );
  }
}

function readBoundedText(root: string, real: string): ResolvedReference {
  const { rawText, sizeBytes } = readDescriptorText(root, real);
  // A text file is valid UTF-8 without NUL bytes: the model request carries text content only.
  if (rawText.includes("\u0000") || rawText.includes("\uFFFD")) {
    throw new PromptInputsRefused("reference-not-text");
  }
  return {
    real,
    bytes: sizeBytes,
    attachment: { uri: pathToFileURL(real).href, name: basename(real) },
  };
}

/**
 * Resolves one reference against the canonical workspace root. The lexical shape and the sensitive
 * names are judged on the path as written AND on the real path it resolves to, so a link inside the
 * workspace cannot present a credential file under an innocent name; the descriptor read then proves
 * containment, a plain file and the byte bound on the very file it returns.
 */
function resolveReference(
  root: string,
  reference: CodingWorkbenchPromptReference,
): ResolvedReference {
  if (!isCodingWorkbenchPromptReferencePath(reference.path)) {
    throw new PromptInputsRefused("reference-invalid");
  }
  if (isDenied(reference.path)) throw new PromptInputsRefused("reference-sensitive");
  const real = canonical(resolve(root, ...reference.path.split("/")));
  const rel = containedRelative(root, real);
  if (rel === undefined) throw new PromptInputsRefused("reference-outside-workspace");
  if (isDenied(rel)) throw new PromptInputsRefused("reference-sensitive");
  return readBoundedText(root, real);
}

export interface ResolvePromptReferencesInput {
  readonly workspaceRoot: string;
  readonly references: readonly CodingWorkbenchPromptReference[];
  /** What the run's budget still has room for, from the files its earlier prompts attached. */
  readonly remainingRunBytes: number;
}

export type PromptReferencesResolution =
  | { readonly ok: true; readonly files: readonly PromptFileAttachment[]; readonly bytes: number }
  | { readonly ok: false; readonly reason: PromptInputsRefusal };

function admitReferences(
  input: ResolvePromptReferencesInput,
): Extract<PromptReferencesResolution, { readonly ok: true }> {
  const root = canonical(input.workspaceRoot);
  const seen = new Set<string>();
  const files: PromptFileAttachment[] = [];
  let bytes = 0;
  for (const reference of input.references) {
    const resolved = resolveReference(root, reference);
    // The same file under two spellings (a case variant, a link) is attached, and charged, once.
    if (seen.has(resolved.real)) continue;
    seen.add(resolved.real);
    bytes += resolved.bytes;
    if (bytes > OPENCODE_PROMPT_FILES_MAX_BYTES) {
      throw new PromptInputsRefused("references-prompt-budget");
    }
    if (bytes > input.remainingRunBytes) throw new PromptInputsRefused("references-run-budget");
    files.push(resolved.attachment);
  }
  return { ok: true, files, bytes };
}

/**
 * Admits a prompt's references or refuses the whole prompt: the first reference that is not a
 * contained, non-sensitive text file within the bounds ends the resolution, so nothing is sent
 * with some of the files the human asked for missing.
 */
export function resolvePromptReferences(
  input: ResolvePromptReferencesInput,
): PromptReferencesResolution {
  try {
    return admitReferences(input);
  } catch (error) {
    if (error instanceof PromptInputsRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

const PROMPT_INPUTS_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.prompt-inputs.settled",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodePromptInputs.recordPromptInputs",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["accepted", "refused"],
    },
    delivery: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "queue", "steer"],
    },
    referenceCount: { type: "integer", dataClass: "count", required: true },
    attachedBytes: { type: "integer", dataClass: "count", required: false },
    // The operator request a delivery belongs to: the join key between an attempt whose
    // acknowledgement was lost and the retry that resolved it, each under its own correlation id.
    requestId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
    // How the native message id was handled: `bound` minted for this request, `reused` resent from an
    // earlier unconfirmed attempt of it, `unreconciled` accepted under a different id than the one sent.
    inputBinding: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["bound", "reused", "unreconciled"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "delivery-refused",
        "delivery-unconfirmed",
        "delivery-unsupported",
        "reference-invalid",
        "reference-not-file",
        "reference-not-text",
        "reference-outside-workspace",
        "reference-sensitive",
        "reference-too-large",
        "reference-unreadable",
        "references-prompt-budget",
        "references-run-budget",
        "references-unsupported",
        "request-conflict",
        "run-unavailable",
        "turn-not-running",
      ],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-prompt-inputs"],
  proofIds: ["coding-runtime.prompt-inputs.settled.emitted-line"],
  releaseImpact: "patch",
});

/** How a delivery's native message id was handled; the closed `inputBinding` of the line. */
export type PromptInputBinding = "bound" | "reused" | "unreconciled";

export type PromptInputsOutcome =
  | {
      readonly outcome: "accepted";
      readonly attachedBytes: number;
      readonly inputBinding?: PromptInputBinding | undefined;
    }
  | {
      readonly outcome: "refused";
      readonly reason: PromptInputsRefusal;
      readonly inputBinding?: PromptInputBinding | undefined;
      /** Set on a delivery that failed after admission, so the line carries the closed error kind. */
      readonly errorKind?: ActivityLogErrorKind | undefined;
    };

/**
 * One body-free line per prompt that carried inputs: the run, the closed delivery value, how many
 * files were referenced and, for a refusal, the closed reason. A delivery also names its operator
 * request and how its native message id was handled, which is what joins a lost acknowledgement to
 * the retry that resolved it. Paths, names and contents never enter the log.
 */
export function recordPromptInputs(
  activityLog: ServerLogSink | undefined,
  runId: string,
  summary: PromptInputsSummary,
  settled: PromptInputsOutcome,
): void {
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      PROMPT_INPUTS_SETTLED_OPERATION,
      {
        level: settled.outcome === "accepted" ? "info" : "warn",
        correlationId: correlationIdOrUnknown(summary.correlationId ?? runId),
        ...(settled.outcome === "refused" && settled.errorKind !== undefined
          ? { errorKind: settled.errorKind }
          : {}),
      },
      {
        runId,
        outcome: settled.outcome,
        delivery: summary.delivery ?? "none",
        referenceCount: summary.referenceCount,
        ...(summary.requestId === undefined ? {} : { requestId: summary.requestId }),
        ...(settled.inputBinding === undefined ? {} : { inputBinding: settled.inputBinding }),
        ...(settled.outcome === "accepted"
          ? { attachedBytes: settled.attachedBytes }
          : { reason: settled.reason }),
      },
    ),
  );
}

/** The part of a ready run the prompt inputs need; `ReadyRun` of the composition satisfies it. */
export interface PromptInputsRun {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly client: Pick<OpenCodeV2HttpClient, "prompt">;
  readonly runtimeAdapter: Pick<OpenCodeRuntimeAdapter, "turnInFlight">;
  readonly ready: boolean;
  /** What the references of the run's earlier accepted prompts added up to. */
  promptFileBytes?: number | undefined;
}

export interface OpenCodePromptInputsRunPort {
  /** What this composition's tool profile can honour; the readiness read reports the same value. */
  readonly promptInputs: CodingWorkbenchRuntimePromptInputs;
  /**
   * Decides, before anything is reserved or sent, whether the run can take a prompt carrying these
   * inputs: the profile offers them, a delivered message has a turn in flight to join, and every
   * reference is a contained, non-sensitive text file within the bounds. Never throws; a refusal is
   * recorded as one body-free line.
   */
  readonly admitPromptInputs: (
    runId: string,
    request: PromptInputsRequest,
  ) => PromptInputsAdmission;
  /**
   * Sends an admitted `steer` or `queue` message to the session of the turn in flight. It starts no
   * turn, arms nothing and settles nothing: the turn that is running keeps its own settlement, and
   * a failed delivery never cancels it.
   *
   * The message goes out under a native message id bound to the operator request, so `false` is
   * never an unrecoverable answer: when the producer may have accepted the message (the
   * acknowledgement was lost or timed out) a retry of the same request resends the same id and the
   * producer, which stores one input per id, does not hold a second copy.
   */
  readonly deliverPrompt: (
    runId: string,
    text: string,
    inputs: AdmittedPromptInputs,
  ) => Promise<boolean>;
}

export interface OpenCodePromptInputsRunPortDeps {
  readonly readyRun: (runId: string) => PromptInputsRun | undefined;
  readonly capabilities: CodingWorkbenchRuntimePromptInputs;
  readonly activityLog: ServerLogSink | undefined;
  /** The composition's body-free diagnostic for a prompt the runtime did not accept. */
  readonly recordPostFailure: (runId: string, error: unknown) => void;
  /** Mints a native message id; the default is the producer's own ascending layout. */
  readonly mintMessageId?: (() => string) | undefined;
}

function requestSummary(request: PromptInputsRequest): PromptInputsSummary {
  return {
    delivery: request.delivery,
    referenceCount: request.references?.length ?? 0,
    correlationId: request.correlationId,
  };
}

function capabilityRefusal(
  capabilities: CodingWorkbenchRuntimePromptInputs,
  request: PromptInputsRequest,
): PromptInputsRefusal | undefined {
  if (request.delivery !== undefined && !capabilities.delivery) return "delivery-unsupported";
  if ((request.references?.length ?? 0) > 0 && !capabilities.references) {
    return "references-unsupported";
  }
  return undefined;
}

function admittedInputs(
  request: PromptInputsRequest,
  files: readonly PromptFileAttachment[],
  fileBytes: number,
): AdmittedPromptInputs {
  return {
    ...requestSummary(request),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    files,
    fileBytes,
  };
}

function admitForRun(
  run: PromptInputsRun | undefined,
  capabilities: CodingWorkbenchRuntimePromptInputs,
  request: PromptInputsRequest,
): PromptInputsAdmission {
  const unsupported = capabilityRefusal(capabilities, request);
  if (unsupported !== undefined) return { ok: false, reason: unsupported };
  if (run === undefined) return { ok: false, reason: "run-unavailable" };
  if (request.delivery !== undefined && !run.runtimeAdapter.turnInFlight()) {
    return { ok: false, reason: "turn-not-running" };
  }
  const references = request.references ?? [];
  if (references.length === 0) return { ok: true, inputs: admittedInputs(request, [], 0) };
  const resolved = resolvePromptReferences({
    workspaceRoot: run.workspaceRoot,
    references,
    remainingRunBytes: OPENCODE_PROMPT_RUN_FILES_MAX_BYTES - (run.promptFileBytes ?? 0),
  });
  if (!resolved.ok) return resolved;
  return { ok: true, inputs: admittedInputs(request, resolved.files, resolved.bytes) };
}

/**
 * The prompt was accepted by the runtime: its files now count against the run's budget and one
 * body-free line says what was attached. Called by the one place that sent the prompt.
 */
export function acceptPromptInputs(
  activityLog: ServerLogSink | undefined,
  run: Pick<PromptInputsRun, "runId" | "promptFileBytes">,
  inputs: AdmittedPromptInputs,
  inputBinding?: PromptInputBinding,
): void {
  run.promptFileBytes = (run.promptFileBytes ?? 0) + inputs.fileBytes;
  recordPromptInputs(activityLog, run.runId, inputs, {
    outcome: "accepted",
    attachedBytes: inputs.fileBytes,
    inputBinding,
  });
}

/**
 * The most native message ids one run retains. Past it an acknowledged id is forgotten first, then
 * the oldest unresolved one: a retry of a request whose id was forgotten that way is a new input.
 */
export const OPENCODE_NATIVE_INPUT_LEDGER_MAX = 32;

/**
 * One operator request's native message: the id its message was sent under and the digest of what
 * that id stands for. The id is minted once, when the request is first delivered, and kept until the
 * request is known to have been refused by the producer or is forgotten for lack of room, so every
 * retry of the request resends the same id.
 */
interface NativeInputEntry {
  readonly messageId: string;
  readonly fingerprint: string;
  /** The producer's receipt was read; the entry stays only for a commit the dispatcher refused. */
  acknowledged: boolean;
}

/** The operator requests of one run whose native message id is retained, oldest first. */
type NativeInputLedger = Map<string, NativeInputEntry>;

type NativeInputBinding =
  { readonly kind: PromptInputBinding; readonly messageId: string } | { readonly kind: "conflict" };

/**
 * What an id stands for: the delivery, the text and the files. Only the digest is kept, so a request
 * id reused for another message is told apart without the ledger ever holding the message.
 */
function messageFingerprint(text: string, inputs: AdmittedPromptInputs): string {
  return createHash("sha256")
    .update(JSON.stringify([inputs.delivery, text, inputs.files.map((f) => [f.uri, f.name])]))
    .digest("hex");
}

/** Makes room for one more entry: a resolved entry goes before any unresolved one. */
function makeRoom(ledger: NativeInputLedger): void {
  if (ledger.size < OPENCODE_NATIVE_INPUT_LEDGER_MAX) return;
  const resolved = [...ledger].find(([, entry]) => entry.acknowledged);
  const oldest = resolved ?? ledger.entries().next().value;
  if (oldest !== undefined) ledger.delete(oldest[0]);
}

/**
 * Binds the operator request to its native message id. The first delivery of a request mints and
 * retains the id; a later one, a retry after an unconfirmed attempt, reuses it. A request id that
 * comes back with another message is a conflict: the producer would answer it with the receipt of the
 * first message and the new text would silently never be sent. A delivery with no request identity
 * has nothing to retain and always gets a fresh id.
 */
function bindNativeInput(
  ledger: NativeInputLedger,
  mint: () => string,
  text: string,
  inputs: AdmittedPromptInputs,
): NativeInputBinding {
  const { requestId } = inputs;
  if (requestId === undefined) return { kind: "bound", messageId: mint() };
  const fingerprint = messageFingerprint(text, inputs);
  const held = ledger.get(requestId);
  if (held !== undefined) {
    return held.fingerprint === fingerprint
      ? { kind: "reused", messageId: held.messageId }
      : { kind: "conflict" };
  }
  makeRoom(ledger);
  const messageId = mint();
  ledger.set(requestId, { messageId, fingerprint, acknowledged: false });
  return { kind: "bound", messageId };
}

interface DeliveryAttempt {
  readonly run: PromptInputsRun;
  readonly text: string;
  readonly inputs: AdmittedPromptInputs;
  readonly delivery: CodingWorkbenchPromptDelivery;
  readonly binding: Extract<NativeInputBinding, { readonly messageId: string }>;
}

interface DeliveryContext {
  readonly deps: OpenCodePromptInputsRunPortDeps;
  readonly ledgerOf: (run: PromptInputsRun) => NativeInputLedger;
}

function acknowledgeNativeInput(context: DeliveryContext, attempt: DeliveryAttempt): void {
  const requestId = attempt.inputs.requestId;
  const entry = requestId === undefined ? undefined : context.ledgerOf(attempt.run).get(requestId);
  if (entry !== undefined) entry.acknowledged = true;
}

/**
 * The producer did not take the message. What the retry may do depends on what the failure proves
 * about the producer's side: a refusal of a message that went out under a fresh id proves nothing was
 * stored, so the id is forgotten and the retry starts clean; anything else (the connection was lost
 * after the request was sent, the acknowledgement could not be read, or this attempt reused an id an
 * earlier attempt may have stored) leaves the id bound to the request so the retry resends it.
 */
function recordDeliveryFailure(
  context: DeliveryContext,
  attempt: DeliveryAttempt,
  error: unknown,
): boolean {
  const { deps } = context;
  const { run, inputs, binding } = attempt;
  deps.recordPostFailure(run.runId, error);
  const failure = classifyOpenCodeV2PromptFailure(error);
  if (failure === "receipt-mismatch") {
    // The producer holds the message under an id the ledger cannot resend: it was accepted, so
    // reporting it failed would invite a retry that stores a second copy.
    acknowledgeNativeInput(context, attempt);
    acceptPromptInputs(deps.activityLog, run, inputs, "unreconciled");
    return run.ready;
  }
  if (failure === "not-submitted" && binding.kind === "bound" && inputs.requestId !== undefined) {
    context.ledgerOf(run).delete(inputs.requestId);
  }
  recordPromptInputs(deps.activityLog, run.runId, inputs, {
    outcome: "refused",
    reason: failure === "not-submitted" ? "delivery-refused" : "delivery-unconfirmed",
    inputBinding: binding.kind,
    errorKind: activityLogErrorKindOr(errorKindOf(error), "internal"),
  });
  return false;
}

async function sendDelivery(context: DeliveryContext, attempt: DeliveryAttempt): Promise<boolean> {
  const { run, text, inputs, delivery, binding } = attempt;
  try {
    await run.client.prompt(run.sessionId, text, undefined, undefined, {
      id: binding.messageId,
      delivery,
      files: inputs.files,
    });
  } catch (error) {
    return recordDeliveryFailure(context, attempt, error);
  }
  acknowledgeNativeInput(context, attempt);
  acceptPromptInputs(context.deps.activityLog, run, inputs, binding.kind);
  return run.ready;
}

export function createOpenCodePromptInputsRunPort(
  deps: OpenCodePromptInputsRunPortDeps,
): OpenCodePromptInputsRunPort {
  const mint = deps.mintMessageId ?? createOpenCodeNativeMessageIdMinter();
  // Keyed by the run object, which the composition keeps for the run's whole life: the ledger goes
  // with it and no run-teardown hook has to remember it.
  const ledgers = new WeakMap<PromptInputsRun, NativeInputLedger>();
  const ledgerOf = (run: PromptInputsRun): NativeInputLedger => {
    const held = ledgers.get(run);
    if (held !== undefined) return held;
    const created: NativeInputLedger = new Map();
    ledgers.set(run, created);
    return created;
  };
  const context: DeliveryContext = { deps, ledgerOf };
  return {
    promptInputs: deps.capabilities,
    admitPromptInputs: (runId, request): PromptInputsAdmission => {
      const admission = admitForRun(deps.readyRun(runId), deps.capabilities, request);
      if (!admission.ok) {
        recordPromptInputs(deps.activityLog, runId, requestSummary(request), {
          outcome: "refused",
          reason: admission.reason,
        });
      }
      return admission;
    },
    deliverPrompt: async (runId, text, inputs): Promise<boolean> => {
      const run = deps.readyRun(runId);
      const delivery = inputs.delivery;
      if (delivery === undefined) return false;
      if (run?.runtimeAdapter.turnInFlight() !== true) {
        // The turn settled between admission and the send: nothing is sent, nothing is half-done.
        recordPromptInputs(deps.activityLog, runId, inputs, {
          outcome: "refused",
          reason: "turn-not-running",
        });
        return false;
      }
      const binding = bindNativeInput(ledgerOf(run), mint, text, inputs);
      if (binding.kind === "conflict") {
        recordPromptInputs(deps.activityLog, runId, inputs, {
          outcome: "refused",
          reason: "request-conflict",
        });
        return false;
      }
      return sendDelivery(context, { run, text, inputs, delivery, binding });
    },
  };
}
