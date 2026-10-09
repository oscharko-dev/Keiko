import {
  SUPPORT_RETRIEVAL_MISS_FINDING_SCHEMA_VERSION,
  SUPPORT_RETRIEVAL_MISS_REASONS,
  isActivityLogIdentityDigest,
  isActivityLogInstanceId,
  isActivityLogProcessId,
  type SupportRetrievalMissFields,
  type SupportRetrievalMissFinding,
  type SupportRetrievalMissReason,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { groupConnectedContextOmissions } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CANDIDATE_OMISSION_REASONS,
  type CandidateOmissionReason,
} from "@oscharko-dev/keiko-contracts/connected-context";

interface RetrievalLine {
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly pid?: number | undefined;
  readonly instanceId?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

type MutableFields = {
  -readonly [Key in keyof SupportRetrievalMissFields]: SupportRetrievalMissFields[Key];
};
type ObservedFields = {
  readonly [Key in keyof SupportRetrievalMissFields]?: SupportRetrievalMissFields[Key] | undefined;
};
interface QueryObservation {
  readonly queryIdentitySha256?: string;
  readonly fields: MutableFields;
  declaredUnreadInScopeCount: number;
  assessmentOnly: boolean;
  sourceRequired: boolean;
  omissionGroups?: SupportRetrievalMissFinding["omissionGroups"];
}
interface TurnObservation {
  readonly correlationId: string;
  readonly process?: SupportRetrievalMissFinding["process"];
  readonly scopeIdentitySha256?: string;
  readonly queries: Map<string, QueryObservation>;
  answered: boolean;
  closed: boolean;
  ambiguousLifecycle: boolean;
  readonly started: boolean;
}

const COUNT_FIELDS = [
  "declaredUnreadInScopeCount",
  "explicitPathRejectedCount",
  "addressedBasenameDedupDemotedCount",
  "followUpPassCount",
  "selectedFileCount",
] as const;
const REJECTION_REASONS = [
  "outside-scope",
  "denied",
  "missing",
  "ignored",
  "generated",
  "binary",
  "size-exceeded",
  "unsupported-format",
] as const;
const OMISSION_FIELDS = {
  "outside-scope": "omittedOutsideScopeCount",
  binary: "omittedBinaryCount",
  generated: "omittedGeneratedCount",
  ignored: "omittedIgnoredCount",
  "size-exceeded": "omittedSizeExceededCount",
  "near-duplicate": "omittedNearDuplicateCount",
  "low-relevance": "omittedLowRelevanceCount",
  "redacted-only": "omittedRedactedOnlyCount",
  "budget-exhausted": "omittedBudgetExhaustedCount",
  "tool-unavailable": "omittedToolUnavailableCount",
  "unsupported-format": "omittedUnsupportedFormatCount",
  "no-text-layer": "omittedNoTextLayerCount",
  "malformed-document": "omittedMalformedDocumentCount",
  "encrypted-document": "omittedEncryptedDocumentCount",
} as const satisfies Readonly<Record<CandidateOmissionReason, string>>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | undefined {
  return typeof value === "string" ? values.find((candidate) => candidate === value) : undefined;
}

function observedEnums(extra: Readonly<Record<string, unknown>>): ObservedFields {
  return {
    followUpOutcome: enumValue(extra.followUpOutcome, [
      "answered",
      "still-insufficient",
      "budget-refused",
      "elapsed-refused",
      "disabled",
    ]),
    semanticProviderDisposition: enumValue(extra.semanticProviderDisposition, [
      "not-evaluated",
      "unavailable",
      "suppressed",
      "not-used",
      "used",
      "rejected",
    ]),
    retrievalIntent: enumValue(extra.retrievalIntent, [
      "project-metadata",
      "repository-overview",
      "targeted-code-search",
      "diagnostic-search",
      "conversational-follow-up",
      "clarification-needed",
    ]),
    continuityReferentSource: enumValue(extra.continuityReferentSource, [
      "none",
      "previous-user-question",
      "assistant-paths",
      "assistant-declaration",
      "assistant-paths-and-declaration",
    ]),
  };
}

function assignDefined(fields: MutableFields, incoming: ObservedFields): void {
  for (const key of Object.keys(incoming)) {
    const descriptor = Object.getOwnPropertyDescriptor(incoming, key);
    if (descriptor?.value !== undefined)
      Object.defineProperty(fields, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
}

function updateFields(fields: MutableFields, extra: Readonly<Record<string, unknown>>): void {
  for (const key of COUNT_FIELDS) {
    const value = count(extra[key]);
    if (value !== undefined) fields[key] = value;
  }
  if (typeof extra.keepOneFallbackApplied === "boolean")
    fields.keepOneFallbackApplied = extra.keepOneFallbackApplied;
  if (Array.isArray(extra.explicitPathRejectionReasons)) {
    const reasons = extra.explicitPathRejectionReasons.map((value: unknown) =>
      enumValue(value, REJECTION_REASONS),
    );
    if (reasons.length <= 8 && reasons.every((value) => value !== undefined))
      fields.explicitPathRejectionReasons = reasons;
  }
  assignDefined(fields, observedEnums(extra));
}

function omissionGroups(
  extra: Readonly<Record<string, unknown>>,
): SupportRetrievalMissFinding["omissionGroups"] {
  const counts: Record<CandidateOmissionReason, number> = Object.create(null) as Record<
    CandidateOmissionReason,
    number
  >;
  for (const reason of CANDIDATE_OMISSION_REASONS) {
    const value = count(extra[OMISSION_FIELDS[reason]]);
    if (value === undefined) return undefined;
    counts[reason] = value;
  }
  return groupConnectedContextOmissions(counts);
}

function sourceRequired(extra: Readonly<Record<string, unknown>>): boolean {
  return ["explicitPathAnchorCount", "referenceChannelCount", "continuityReferentCount"].some(
    (name) => (count(extra[name]) ?? 0) > 0,
  );
}

function answeredFollowUp(fields: SupportRetrievalMissFields): boolean {
  return (fields.followUpPassCount ?? 0) > 0 && fields.followUpOutcome === "answered";
}

function observeQuery(
  turn: TurnObservation,
  extra: Readonly<Record<string, unknown>>,
  index: number,
): void {
  const queryIdentitySha256 = isActivityLogIdentityDigest(extra.queryIdentitySha256)
    ? extra.queryIdentitySha256
    : undefined;
  const key = queryIdentitySha256 ?? `unknown:${String(index)}`;
  const query = turn.queries.get(key) ?? {
    ...(queryIdentitySha256 === undefined ? {} : { queryIdentitySha256 }),
    fields: {},
    declaredUnreadInScopeCount: 0,
    assessmentOnly: false,
    sourceRequired: false,
  };
  updateFields(query.fields, extra);
  query.sourceRequired ||= sourceRequired(extra);
  query.omissionGroups = omissionGroups(extra) ?? query.omissionGroups;
  query.declaredUnreadInScopeCount = Math.max(
    query.declaredUnreadInScopeCount,
    count(extra.declaredUnreadInScopeCount) ?? 0,
  );
  if (answeredFollowUp(query.fields)) turn.answered = true;
  turn.queries.set(key, query);
}

function turnKey(correlationId: string, line: RetrievalLine, scope: string): string {
  return JSON.stringify([line.correlationId ?? correlationId, line.pid, line.instanceId, scope]);
}

function confirmedAssessment(extra: Readonly<Record<string, unknown>>): boolean {
  return (
    extra.policy === "allowed" &&
    extra.outcome === "assessment-only" &&
    extra.sourceBackedChars === 0 &&
    (count(extra.assessmentChars) ?? 0) > 0
  );
}

function observeAssessment(turn: TurnObservation | undefined, line: RetrievalLine): void {
  const extra = line.extra;
  if (
    turn?.started !== true ||
    turn.ambiguousLifecycle ||
    extra?.phase !== "accepted-final" ||
    turn.process === undefined
  )
    return;
  if (!isActivityLogIdentityDigest(extra.queryIdentitySha256)) return;
  const query = turn.queries.get(extra.queryIdentitySha256);
  if (query === undefined) return;
  query.assessmentOnly = confirmedAssessment(extra);
  turn.closed = true;
}

function createTurn(
  correlationId: string,
  line: RetrievalLine,
  scopeIdentitySha256: string | undefined,
  started: boolean,
): TurnObservation {
  return {
    correlationId: line.correlationId ?? correlationId,
    ...observedProcess(line),
    ...(scopeIdentitySha256 === undefined ? {} : { scopeIdentitySha256 }),
    queries: new Map(),
    answered: false,
    closed: false,
    ambiguousLifecycle: false,
    started,
  };
}

interface TurnCollection {
  readonly turns: TurnObservation[];
  readonly latest: Map<string, TurnObservation>;
  readonly started: Set<string>;
}

function observeLifecycle(
  state: TurnCollection,
  line: RetrievalLine,
  scope: string | undefined,
  key: string,
): boolean {
  if (line.op === "search.connected-context.started") {
    const previous = state.latest.get(key);
    if (previous?.closed === true) state.latest.delete(key);
    else if (previous !== undefined) previous.ambiguousLifecycle = true;
    state.started.add(key);
    return true;
  }
  if (line.op !== "search.answer.assessed") return false;
  if (scope !== undefined) observeAssessment(state.latest.get(key), line);
  return true;
}

function observeTurnLine(
  state: TurnCollection,
  correlationId: string,
  line: RetrievalLine,
  index: number,
): void {
  const scope = line.extra?.scopeIdentitySha256;
  const scopeIdentity = isActivityLogIdentityDigest(scope) ? scope : undefined;
  const key = turnKey(correlationId, line, scopeIdentity ?? `unknown:${String(index)}`);
  if (observeLifecycle(state, line, scopeIdentity, key)) return;
  const extra = retrievalExtra(line);
  if (extra === undefined) return;
  let turn = currentObservationTurn(state, key, line.op);
  if (turn === undefined) {
    turn = createTurn(correlationId, line, scopeIdentity, state.started.has(key));
    state.latest.set(key, turn);
    state.turns.push(turn);
  }
  observeQuery(turn, extra, index);
  if (line.op === "search.connected-context.answer-details") turn.closed = true;
}

function currentObservationTurn(
  state: TurnCollection,
  key: string,
  op: string,
): TurnObservation | undefined {
  const turn = state.latest.get(key);
  if (turn?.closed !== true || !startsSelectionObservation(op)) return turn;
  state.started.delete(key);
  state.latest.delete(key);
  return undefined;
}

function startsSelectionObservation(op: string): boolean {
  return (
    op === "search.connected-context.source-details" ||
    op === "search.connected-context.selection-details" ||
    op === "search.connected-context.completed"
  );
}

function observedTurns(
  correlationId: string,
  lines: readonly RetrievalLine[],
): readonly TurnObservation[] {
  const state: TurnCollection = { turns: [], latest: new Map(), started: new Set() };
  lines.forEach((line, index) => {
    observeTurnLine(state, correlationId, line, index);
  });
  return state.turns;
}

function retrievalExtra(line: RetrievalLine): Readonly<Record<string, unknown>> | undefined {
  if (!line.op.startsWith("search.connected-context.") && !line.op.startsWith("search.citations."))
    return undefined;
  const extra = line.extra;
  if (extra === undefined) return undefined;
  const names = [
    ...COUNT_FIELDS,
    "keepOneFallbackApplied",
    "explicitPathRejectionReasons",
    "followUpOutcome",
    "semanticProviderDisposition",
    "retrievalIntent",
    "continuityReferentSource",
    "explicitPathAnchorCount",
    "referenceChannelCount",
    "continuityReferentCount",
  ];
  return names.some((name) => Object.hasOwn(extra, name)) ? extra : undefined;
}

function observedProcess(line: RetrievalLine): Pick<TurnObservation, "process"> {
  return isActivityLogProcessId(line.pid) && isActivityLogInstanceId(line.instanceId)
    ? { process: { pid: line.pid, instanceId: line.instanceId } }
    : {};
}

function pickFields(
  fields: SupportRetrievalMissFields,
  keys: readonly (keyof SupportRetrievalMissFields)[],
): SupportRetrievalMissFields {
  const picked: MutableFields = {};
  for (const key of keys) {
    if (fields[key] !== undefined)
      Object.defineProperty(picked, key, { value: fields[key], enumerable: true });
  }
  return picked;
}

function basicReasons(fields: SupportRetrievalMissFields): readonly SupportRetrievalMissReason[] {
  const reasons: SupportRetrievalMissReason[] = [];
  if ((fields.explicitPathRejectedCount ?? 0) > 0) reasons.push("explicit-path-rejected");
  if (fields.keepOneFallbackApplied === true) reasons.push("low-confidence-selection");
  if ((fields.addressedBasenameDedupDemotedCount ?? 0) > 0)
    reasons.push("basename-dedup-demoted-explicit");
  if (stillInsufficient(fields)) reasons.push("follow-up-still-insufficient");
  if (overviewOnFollowUp(fields)) reasons.push("intent-overview-on-follow-up");
  return reasons;
}

function stillInsufficient(fields: SupportRetrievalMissFields): boolean {
  return (fields.followUpPassCount ?? 0) > 0 && fields.followUpOutcome === "still-insufficient";
}

function overviewOnFollowUp(fields: SupportRetrievalMissFields): boolean {
  return (
    fields.retrievalIntent === "repository-overview" &&
    fields.continuityReferentSource !== undefined &&
    fields.continuityReferentSource !== "none"
  );
}

function semanticMiss(fields: SupportRetrievalMissFields, actualMiss: boolean): boolean {
  const unavailable =
    fields.semanticProviderDisposition === "unavailable" ||
    fields.semanticProviderDisposition === "rejected";
  const emptyTargeted =
    fields.selectedFileCount === 0 &&
    (fields.retrievalIntent === "targeted-code-search" ||
      fields.retrievalIntent === "diagnostic-search");
  return unavailable && (actualMiss || emptyTargeted);
}

const TRIGGER_FIELDS = {
  "declared-unread-in-scope": ["declaredUnreadInScopeCount"],
  "explicit-path-rejected": ["explicitPathRejectedCount", "explicitPathRejectionReasons"],
  "low-confidence-selection": ["keepOneFallbackApplied"],
  "basename-dedup-demoted-explicit": ["addressedBasenameDedupDemotedCount"],
  "follow-up-still-insufficient": ["followUpPassCount", "followUpOutcome"],
  "semantic-unavailable-with-miss": [
    "semanticProviderDisposition",
    "declaredUnreadInScopeCount",
    "explicitPathRejectedCount",
    "keepOneFallbackApplied",
    "addressedBasenameDedupDemotedCount",
    "followUpPassCount",
    "followUpOutcome",
    "selectedFileCount",
    "retrievalIntent",
  ],
  "intent-overview-on-follow-up": ["retrievalIntent", "continuityReferentSource"],
} as const satisfies Readonly<
  Record<SupportRetrievalMissReason, readonly (keyof SupportRetrievalMissFields)[]>
>;

function incidentalAssessment(
  query: QueryObservation,
  reasons: ReadonlySet<SupportRetrievalMissReason>,
): boolean {
  return (
    query.assessmentOnly &&
    !query.sourceRequired &&
    query.declaredUnreadInScopeCount === 0 &&
    ![...reasons].some((reason) => reason !== "low-confidence-selection")
  );
}

function queryFindings(
  turn: TurnObservation,
  query: QueryObservation,
): readonly SupportRetrievalMissFinding[] {
  const fields = { ...query.fields };
  const reasons = new Set(basicReasons(fields));
  const assessment = incidentalAssessment(query, reasons);
  const unresolved = !turn.answered && query.declaredUnreadInScopeCount > 0;
  if (unresolved) {
    fields.declaredUnreadInScopeCount = query.declaredUnreadInScopeCount;
    reasons.add("declared-unread-in-scope");
  }
  if (assessment) reasons.delete("low-confidence-selection");
  if (semanticMiss(fields, reasons.size > 0) && (!assessment || reasons.size > 0))
    reasons.add("semantic-unavailable-with-miss");
  return SUPPORT_RETRIEVAL_MISS_REASONS.filter((reason) => reasons.has(reason)).map((reason) => ({
    kind: "retrieval-miss",
    schemaVersion: SUPPORT_RETRIEVAL_MISS_FINDING_SCHEMA_VERSION,
    correlationId: turn.correlationId,
    reason,
    ...(turn.process === undefined ? {} : { process: turn.process }),
    ...(turn.scopeIdentitySha256 === undefined
      ? {}
      : { scopeIdentitySha256: turn.scopeIdentitySha256 }),
    ...(query.queryIdentitySha256 === undefined
      ? {}
      : { queryIdentitySha256: query.queryIdentitySha256 }),
    fields: pickFields(fields, TRIGGER_FIELDS[reason]),
    ...(query.omissionGroups === undefined ? {} : { omissionGroups: query.omissionGroups }),
  }));
}

/** Pure derivation from reader-validated timeline records; no registry supplied by a report. */
export function projectRetrievalMisses(
  correlationId: string,
  lines: readonly RetrievalLine[],
): readonly SupportRetrievalMissFinding[] {
  return observedTurns(correlationId, lines).flatMap((turn) =>
    [...turn.queries.values()].flatMap((query) => queryFindings(turn, query)),
  );
}
