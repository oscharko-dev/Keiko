import {
  CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT,
  CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TURNS,
  CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_PLAN_STEP_STATES,
  stripUnsafeFormatChars,
  unavailableCodingSafeActivityFeed,
  validateCodingSafeActivityFeed,
  type CodingSafeActivityFeed,
  type CodingSafeActivityMessageRole,
  type CodingSafeActivityPlanStepState,
  type CodingSafeActivityTextSegment,
  type CodingSafeActivityTool,
  type CodingSafeActivityToolState,
  type UnavailableCodingSafeActivityFeed,
} from "@oscharko-dev/keiko-contracts";

import { emitServerDiagnostic, type ServerDiagnosticSink } from "../diagnostics-log.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SUBSCRIBERS = 32;
const DEFAULT_MAX_SIGNAL_IDENTITIES = 32_768;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface SignalBase {
  readonly occurredAt: string;
  /** Optional upstream identity used to make replayed history idempotent. */
  readonly signalId?: string | undefined;
}

/** Raw plan-step input; the projection strips, clips, and bounds it before publication. */
export interface CodingSafeActivityPlanStepInput {
  readonly text: string;
  readonly state: CodingSafeActivityPlanStepState;
}

export type CodingSafeActivitySignal =
  | (SignalBase & {
      readonly kind: "message";
      readonly messageId: string;
      readonly role: CodingSafeActivityMessageRole;
      readonly parentMessageId?: string | undefined;
    })
  | (SignalBase & {
      readonly kind: "text";
      readonly messageId: string;
      readonly text: string;
    })
  | (SignalBase & {
      readonly kind: "tool";
      readonly messageId?: string | undefined;
      readonly callId: string;
      readonly tool?: string | undefined;
      readonly state: CodingSafeActivityToolState;
    })
  | (SignalBase & {
      readonly kind: "plan";
      readonly anchorMessageId: string;
      readonly steps: readonly CodingSafeActivityPlanStepInput[];
    });

export type CodingSafeActivityPurgeReason =
  "stop" | "takeover" | "shutdown" | "workspace-switch" | "expiry";
export type CodingSafeActivityDropReason =
  | "validation-rejected"
  | "redactor-collapsed"
  | "projection-rejected"
  | "capacity-rejected"
  | "subscriber-rejected";

export interface CodingSafeActivityContent {
  readonly kind: "safe-activity";
  readonly feed: CodingSafeActivityFeed;
}

export interface CodingSafeActivityProjectionLimits {
  readonly maxTurns?: number | undefined;
  readonly maxMessagesPerTurn?: number | undefined;
  readonly maxSegmentsPerMessage?: number | undefined;
  readonly maxToolsPerTurn?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly maxTurnBytes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxPlanSteps?: number | undefined;
  readonly maxPlanStepChars?: number | undefined;
  readonly maxPlanBytes?: number | undefined;
}

export interface CodingSafeActivityOpenInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly authorityExpiresAt: string;
  readonly workspaceIsCurrent: () => boolean;
}

export interface CodingSafeActivityProjectionOptions {
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly limits?: CodingSafeActivityProjectionLimits | undefined;
  readonly maxDroppedEventCount?: number | undefined;
  readonly maxSubscribers?: number | undefined;
  readonly maxSignalIdentities?: number | undefined;
}

export interface CodingSafeActivitySubscription {
  readonly admitted: boolean;
  readonly detach: () => void;
}

export interface CodingSafeActivityProjection {
  readonly open: (input: CodingSafeActivityOpenInput) => void;
  readonly ingest: (runId: string, signal: CodingSafeActivitySignal) => boolean;
  readonly recordDrop: (runId: string, reason: CodingSafeActivityDropReason) => void;
  readonly recordDrops: (
    runId: string,
    reason: CodingSafeActivityDropReason,
    count: number,
  ) => void;
  readonly purge: (runId: string, reason: CodingSafeActivityPurgeReason) => void;
  readonly purgeAll: (reason: CodingSafeActivityPurgeReason) => void;
  readonly markUnavailable: (runId: string) => void;
  readonly currentContent: () => CodingSafeActivityContent | null;
  readonly subscribeContent: (
    listener: (content: CodingSafeActivityContent | null) => void,
  ) => CodingSafeActivitySubscription;
}

interface MutableMessage {
  messageId: string;
  role: CodingSafeActivityMessageRole;
  occurredAt: string;
  segments: CodingSafeActivityTextSegment[];
  truncated: boolean;
}

interface MutableTurn {
  turnId: string;
  messages: MutableMessage[];
  tools: CodingSafeActivityTool[];
  truncated: boolean;
}

interface MutablePlanStep {
  text: string;
  state: CodingSafeActivityPlanStepState;
  truncated: boolean;
}

interface MutablePlan {
  revision: number;
  anchorMessageId: string;
  updatedAt: string;
  steps: MutablePlanStep[];
  truncated: boolean;
}

interface MutableFeed {
  schemaVersion: "1";
  availability: "available";
  runId: string;
  updatedAt: string;
  turns: MutableTurn[];
  plan?: MutablePlan;
  truncated: boolean;
  droppedEventCount: number;
}

interface ProjectionEntry {
  readonly runId: string;
  readonly workspaceId: string;
  readonly workspaceIsCurrent: () => boolean;
  readonly expiresAtMs: number;
  readonly signalIds: Set<string>;
  readonly messageTurns: Map<string, string>;
  feed: StoredFeed;
}

type StoredFeed = MutableFeed | UnavailableCodingSafeActivityFeed;

interface ResolvedLimits {
  readonly maxTurns: number;
  readonly maxMessagesPerTurn: number;
  readonly maxSegmentsPerMessage: number;
  readonly maxToolsPerTurn: number;
  readonly maxMessageBytes: number;
  readonly maxTurnBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPlanSteps: number;
  readonly maxPlanStepChars: number;
  readonly maxPlanBytes: number;
}

class SafeActivityProjection implements CodingSafeActivityProjection {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly diagnostics: ServerDiagnosticSink | undefined;
  private readonly limits: ResolvedLimits;
  private readonly maxDroppedEventCount: number;
  private readonly maxSubscribers: number;
  private readonly maxSignalIdentities: number;
  private readonly subscribers = new Set<(content: CodingSafeActivityContent | null) => void>();
  private entry: ProjectionEntry | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEmittedDropCount = 0;

  public constructor(options: CodingSafeActivityProjectionOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = positive(options.ttlMs, DEFAULT_TTL_MS);
    this.diagnostics = options.diagnostics;
    this.limits = resolvedLimits(options.limits);
    this.maxDroppedEventCount = boundedCounterLimit(options.maxDroppedEventCount);
    this.maxSubscribers = positive(options.maxSubscribers, DEFAULT_MAX_SUBSCRIBERS);
    this.maxSignalIdentities = capped(options.maxSignalIdentities, DEFAULT_MAX_SIGNAL_IDENTITIES);
  }

  public open(input: CodingSafeActivityOpenInput): void {
    const now = this.now();
    const authorityExpiry = Date.parse(input.authorityExpiresAt);
    const expiresAtMs = Math.min(now + this.ttlMs, authorityExpiry);
    this.entry = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      workspaceIsCurrent: input.workspaceIsCurrent,
      expiresAtMs,
      signalIds: new Set(),
      messageTurns: new Map(),
      feed: emptyFeed(input.runId, instant(now)),
    };
    if (!validOpenInput(input, expiresAtMs, now)) this.expireCurrent("expiry");
    else {
      this.lastEmittedDropCount = 0;
      this.scheduleExpiry(this.entry);
      this.notify();
    }
  }

  public ingest(runId: string, signal: CodingSafeActivitySignal): boolean {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available") return false;
    const rejected = signalDropReason(signal);
    if (rejected !== undefined) return this.reject(runId, rejected);
    if (signal.signalId !== undefined && entry.signalIds.has(signal.signalId)) return true;
    const priorFeed = structuredClone(entry.feed);
    const priorMessageTurns = new Map(entry.messageTurns);
    const accepted = applySignal(entry, signal, this.limits);
    if (!accepted) return this.reject(runId, "projection-rejected");
    if (signal.signalId !== undefined) {
      rememberBoundedIdentity(entry.signalIds, signal.signalId, this.maxSignalIdentities);
    }
    entry.feed.updatedAt = signal.occurredAt;
    enforceFeedBounds(entry, this.limits);
    if (!validateCodingSafeActivityFeed(entry.feed).ok) {
      entry.feed = priorFeed;
      replaceMap(entry.messageTurns, priorMessageTurns);
      return this.reject(runId, "capacity-rejected");
    }
    this.notify();
    return true;
  }

  public recordDrop(runId: string, reason: CodingSafeActivityDropReason): void {
    this.recordDrops(runId, reason, 1);
  }

  public recordDrops(runId: string, reason: CodingSafeActivityDropReason, count: number): void {
    const entry = this.liveEntry(runId);
    if (entry?.feed.availability !== "available") return;
    const increment = boundedDropIncrement(count, this.maxDroppedEventCount);
    const previous = entry.feed.droppedEventCount;
    const next = Math.min(this.maxDroppedEventCount, previous + increment);
    if (next === previous) return;
    entry.feed = withDroppedCount(entry.feed, next, instant(this.now()));
    this.notify();
    this.emitDropMilestones(reason, previous, next);
  }

  public purge(runId: string, reason: CodingSafeActivityPurgeReason): void {
    if (this.entry?.runId !== runId) return;
    this.expireCurrent(reason);
  }

  public purgeAll(reason: CodingSafeActivityPurgeReason): void {
    if (this.entry !== undefined) this.expireCurrent(reason);
  }

  public markUnavailable(runId: string): void {
    const dropped = this.entry?.runId === runId ? this.entry.feed.droppedEventCount : 0;
    const feed = {
      ...unavailableCodingSafeActivityFeed(runId, instant(this.now())),
      droppedEventCount: dropped,
    };
    this.entry = {
      runId,
      workspaceId: "unavailable",
      workspaceIsCurrent: (): boolean => true,
      expiresAtMs: this.now() + this.ttlMs,
      signalIds: new Set(),
      messageTurns: new Map(),
      feed,
    };
    this.scheduleExpiry(this.entry);
    this.notify();
  }

  public currentContent(): CodingSafeActivityContent | null {
    const entry = this.liveEntry();
    if (entry === undefined || !validateCodingSafeActivityFeed(entry.feed).ok) return null;
    return { kind: "safe-activity", feed: cloneFeed(entry.feed) };
  }

  public subscribeContent(
    listener: (content: CodingSafeActivityContent | null) => void,
  ): CodingSafeActivitySubscription {
    if (this.subscribers.size >= this.maxSubscribers) {
      this.recordDrop(this.entry?.runId ?? "unavailable", "subscriber-rejected");
      return { admitted: false, detach: (): void => undefined };
    }
    this.subscribers.add(listener);
    return {
      admitted: true,
      detach: (): void => void this.subscribers.delete(listener),
    };
  }

  private liveEntry(runId?: string): ProjectionEntry | undefined {
    const entry = this.entry;
    if (entry === undefined || (runId !== undefined && entry.runId !== runId)) return undefined;
    if (entry.feed.availability === "unavailable") return entry;
    if (this.now() >= entry.expiresAtMs) {
      this.expireCurrent("expiry");
      return undefined;
    }
    if (!safeWorkspaceCheck(entry.workspaceIsCurrent)) {
      this.expireCurrent("workspace-switch");
      return undefined;
    }
    return entry;
  }

  private reject(runId: string, reason: CodingSafeActivityDropReason): false {
    this.recordDrop(runId, reason);
    return false;
  }

  private expireCurrent(_reason: CodingSafeActivityPurgeReason): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.entry = undefined;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    this.notifySubscribers(subscribers, null);
  }

  private notify(): void {
    const content = this.currentContentWithoutExpiry();
    this.notifySubscribers([...this.subscribers], content);
  }

  private notifySubscribers(
    subscribers: readonly ((content: CodingSafeActivityContent | null) => void)[],
    content: CodingSafeActivityContent | null,
  ): void {
    for (const subscriber of subscribers) {
      try {
        subscriber(content);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private emitDropMilestones(
    reason: CodingSafeActivityDropReason,
    previous: number,
    next: number,
  ): void {
    for (let milestone = 1; milestone <= next; milestone *= 2) {
      if (milestone <= previous || milestone <= this.lastEmittedDropCount) continue;
      this.lastEmittedDropCount = milestone;
      emitDropDiagnostic(this.diagnostics, this.now, reason, milestone);
    }
  }

  private currentContentWithoutExpiry(): CodingSafeActivityContent | null {
    const feed = this.entry?.feed;
    return feed !== undefined && validateCodingSafeActivityFeed(feed).ok
      ? { kind: "safe-activity", feed: cloneFeed(feed) }
      : null;
  }

  private scheduleExpiry(entry: ProjectionEntry): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    const delay = Math.max(0, entry.expiresAtMs - this.now());
    this.expiryTimer = setTimeout(() => {
      if (this.entry === entry) this.expireCurrent("expiry");
    }, delay);
    this.expiryTimer.unref();
  }
}

export function createCodingSafeActivityProjection(
  options: CodingSafeActivityProjectionOptions = {},
): CodingSafeActivityProjection {
  return new SafeActivityProjection(options);
}

function resolvedLimits(input: CodingSafeActivityProjectionLimits = {}): ResolvedLimits {
  return {
    maxTurns: capped(input.maxTurns, CODING_SAFE_ACTIVITY_MAX_TURNS),
    maxMessagesPerTurn: capped(
      input.maxMessagesPerTurn,
      CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
    ),
    maxSegmentsPerMessage: capped(
      input.maxSegmentsPerMessage,
      CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
    ),
    maxToolsPerTurn: capped(input.maxToolsPerTurn, CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN),
    maxMessageBytes: capped(input.maxMessageBytes, CODING_SAFE_ACTIVITY_MAX_MESSAGE_UTF8_BYTES),
    maxTurnBytes: capped(input.maxTurnBytes, CODING_SAFE_ACTIVITY_MAX_TURN_UTF8_BYTES),
    maxTotalBytes: capped(input.maxTotalBytes, CODING_SAFE_ACTIVITY_MAX_UTF8_BYTES),
    maxPlanSteps: capped(input.maxPlanSteps, CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS),
    maxPlanStepChars: capped(input.maxPlanStepChars, CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS),
    maxPlanBytes: capped(input.maxPlanBytes, CODING_SAFE_ACTIVITY_MAX_PLAN_UTF8_BYTES),
  };
}

function emptyFeed(runId: string, updatedAt: string): MutableFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId,
    updatedAt,
    turns: [],
    truncated: false,
    droppedEventCount: 0,
  };
}

function applySignal(
  entry: ProjectionEntry,
  signal: CodingSafeActivitySignal,
  limits: ResolvedLimits,
): boolean {
  if (entry.feed.availability !== "available") return false;
  if (signal.kind === "message") return applyMessage(entry, signal, limits);
  if (signal.kind === "text") return applyText(entry, signal, limits);
  if (signal.kind === "plan") return applyPlan(entry, signal, limits);
  return applyTool(entry, signal, limits);
}

function applyMessage(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
  limits: ResolvedLimits,
): boolean {
  if (entry.feed.availability !== "available") return false;
  const knownTurn = entry.messageTurns.get(signal.messageId);
  if (knownTurn !== undefined) return true;
  const turn = turnForMessage(entry, signal);
  if (turn === undefined) return false;
  if (turn.messages.length >= limits.maxMessagesPerTurn) {
    turn.truncated = true;
    return true;
  }
  turn.messages.push(newMessage(signal));
  entry.messageTurns.set(signal.messageId, turn.turnId);
  enforceTurnCount(entry, limits.maxTurns);
  return true;
}

function turnForMessage(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): MutableTurn | undefined {
  if (entry.feed.availability !== "available") return undefined;
  if (signal.role === "user") {
    const turn: MutableTurn = {
      turnId: signal.messageId,
      messages: [],
      tools: [],
      truncated: false,
    };
    entry.feed.turns.push(turn);
    return turn;
  }
  const parentTurnId =
    signal.parentMessageId === undefined
      ? undefined
      : entry.messageTurns.get(signal.parentMessageId);
  return parentTurnId === undefined
    ? undefined
    : entry.feed.turns.find(({ turnId }) => turnId === parentTurnId);
}

function newMessage(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): MutableMessage {
  return {
    messageId: signal.messageId,
    role: signal.role,
    occurredAt: signal.occurredAt,
    segments: [],
    truncated: false,
  };
}

function applyText(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "text" }>,
  limits: ResolvedLimits,
): boolean {
  const located = locateMessage(entry, signal.messageId);
  if (located === undefined) return false;
  const { message, turn } = located;
  if (message.truncated) return true;
  if (message.segments.length >= limits.maxSegmentsPerMessage) {
    markMessageTruncated(message, turn);
    return true;
  }
  const cleaned = stripUnsafeFormatChars(signal.text);
  const clipped = clipTextForMessage(message, cleaned, limits.maxMessageBytes);
  if (clipped.text.length > 0) {
    message.segments.push({ kind: "text", text: clipped.text, truncated: clipped.truncated });
  }
  if (clipped.truncated) markMessageTruncated(message, turn);
  return true;
}

function applyTool(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
  limits: ResolvedLimits,
): boolean {
  const located = locateToolTurn(entry, signal);
  if (located === undefined) return false;
  const existingIndex = located.turn.tools.findIndex(({ callId }) => callId === signal.callId);
  const existing = located.turn.tools[existingIndex];
  if (existing !== undefined) {
    if (!allowedToolTransition(existing.state, signal.state)) return false;
    located.turn.tools[existingIndex] = {
      ...existing,
      state: signal.state,
      occurredAt: signal.occurredAt,
    };
    return true;
  }
  if (signal.tool === undefined) return false;
  if (located.turn.tools.length >= limits.maxToolsPerTurn) {
    located.turn.truncated = true;
    return true;
  }
  located.turn.tools.push({
    callId: signal.callId,
    tool: signal.tool,
    state: signal.state,
    occurredAt: signal.occurredAt,
  });
  return true;
}

/** Replaces the whole snapshot; the upstream plan tool always writes the full step list. */
function applyPlan(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "plan" }>,
  limits: ResolvedLimits,
): boolean {
  if (entry.feed.availability !== "available") return false;
  const plan: MutablePlan = {
    revision: Math.min(Number.MAX_SAFE_INTEGER, (entry.feed.plan?.revision ?? 0) + 1),
    anchorMessageId: signal.anchorMessageId,
    updatedAt: signal.occurredAt,
    steps: [],
    truncated: false,
  };
  for (const step of signal.steps) {
    if (plan.steps.length >= limits.maxPlanSteps) {
      plan.truncated = true;
      break;
    }
    const cleaned = stripUnsafeFormatChars(step.text);
    if (cleaned.length === 0) {
      plan.truncated = true;
      continue;
    }
    const characters = boundedCharacters(cleaned, limits.maxPlanStepChars);
    const text = characters.join("");
    plan.steps.push({ text, state: step.state, truncated: text !== cleaned });
  }
  shrinkPlan(plan, limits.maxPlanBytes);
  entry.feed.plan = plan;
  return true;
}

function shrinkPlan(plan: MutablePlan, maxBytes: number): void {
  while (bytes(plan) > maxBytes && plan.steps.length > 0) {
    plan.steps.pop();
    plan.truncated = true;
  }
}

function locateToolTurn(
  entry: ProjectionEntry,
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): { readonly turn: MutableTurn } | undefined {
  const existing =
    entry.feed.availability === "available"
      ? entry.feed.turns.find(({ tools }) => tools.some(({ callId }) => callId === signal.callId))
      : undefined;
  if (existing !== undefined) return { turn: existing };
  if (signal.messageId === undefined) return undefined;
  const located = locateMessage(entry, signal.messageId);
  return located === undefined ? undefined : { turn: located.turn };
}

function locateMessage(
  entry: ProjectionEntry,
  messageId: string,
): { readonly message: MutableMessage; readonly turn: MutableTurn } | undefined {
  if (entry.feed.availability !== "available") return undefined;
  const turnId = entry.messageTurns.get(messageId);
  const turn = entry.feed.turns.find((candidate) => candidate.turnId === turnId);
  const message = turn?.messages.find((candidate) => candidate.messageId === messageId);
  return turn === undefined || message === undefined ? undefined : { turn, message };
}

function enforceFeedBounds(entry: ProjectionEntry, limits: ResolvedLimits): void {
  if (entry.feed.availability !== "available") return;
  for (const turn of entry.feed.turns) shrinkTurn(entry, turn, limits.maxTurnBytes);
  while (bytes(entry.feed) > limits.maxTotalBytes && entry.feed.turns.length > 0) {
    const removed = entry.feed.turns.shift();
    if (removed !== undefined) releaseTurn(entry, removed);
    entry.feed.truncated = true;
  }
}

function shrinkTurn(entry: ProjectionEntry, turn: MutableTurn, maxBytes: number): void {
  while (bytes(turn) > maxBytes && turn.messages.length > 0) {
    const message = turn.messages[0];
    if (message !== undefined && message.segments.length > 0) message.segments.shift();
    else {
      const removed = turn.messages.shift();
      if (removed !== undefined) entry.messageTurns.delete(removed.messageId);
    }
    turn.truncated = true;
  }
  while (bytes(turn) > maxBytes && turn.tools.length > 0) {
    turn.tools.shift();
    turn.truncated = true;
  }
}

function enforceTurnCount(entry: ProjectionEntry, maxTurns: number): void {
  if (entry.feed.availability !== "available") return;
  while (entry.feed.turns.length > maxTurns) {
    const removed = entry.feed.turns.shift();
    if (removed !== undefined) releaseTurn(entry, removed);
    entry.feed.truncated = true;
  }
}

function releaseTurn(entry: ProjectionEntry, turn: MutableTurn): void {
  for (const message of turn.messages) entry.messageTurns.delete(message.messageId);
}

function markMessageTruncated(message: MutableMessage, turn: MutableTurn): void {
  message.truncated = true;
  turn.truncated = true;
}

function clipTextForMessage(
  message: MutableMessage,
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const characters = boundedCharacters(value, CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS);
  const bounded = characters.join("");
  if (bounded === value && candidateMessageBytes(message, bounded, false) <= maxBytes) {
    return { text: bounded, truncated: false };
  }
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (candidateMessageBytes(message, candidate, true) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: characters.slice(0, low).join(""), truncated: true };
}

function boundedCharacters(value: string, maxChars: number): readonly string[] {
  const characters: string[] = [];
  let usedChars = 0;
  for (const character of value) {
    if (usedChars + character.length > maxChars) break;
    characters.push(character);
    usedChars += character.length;
  }
  return characters;
}

function candidateMessageBytes(message: MutableMessage, text: string, truncated: boolean): number {
  const segment: CodingSafeActivityTextSegment = { kind: "text", text, truncated };
  return bytes({ ...message, segments: [...message.segments, segment], truncated });
}

function allowedToolTransition(
  from: CodingSafeActivityToolState,
  to: CodingSafeActivityToolState,
): boolean {
  if (from === to) return true;
  if (from === "pending") return to !== "pending";
  if (from === "running") return !["pending", "running"].includes(to);
  return false;
}

function validSignal(signal: CodingSafeActivitySignal): boolean {
  if (!validSignalBase(signal)) return false;
  if (signal.kind === "message") return validMessageSignal(signal);
  if (signal.kind === "text") return validTextSignal(signal);
  if (signal.kind === "plan") return validPlanSignal(signal);
  return validToolSignal(signal);
}

function validSignalBase(signal: CodingSafeActivitySignal): boolean {
  return (
    exactSignalKeys(signal) &&
    strictInstant(signal.occurredAt) &&
    (signal.signalId === undefined || safeId(signal.signalId))
  );
}

function validMessageSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "message" }>,
): boolean {
  return (
    safeId(signal.messageId) &&
    (signal.parentMessageId === undefined || safeId(signal.parentMessageId))
  );
}

function validTextSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "text" }>,
): boolean {
  return safeId(signal.messageId) && typeof signal.text === "string" && signal.text.length > 0;
}

function validToolSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "tool" }>,
): boolean {
  return (
    (signal.messageId === undefined || safeId(signal.messageId)) &&
    safeId(signal.callId) &&
    (signal.tool === undefined || safeId(signal.tool))
  );
}

function validPlanSignal(
  signal: Extract<CodingSafeActivitySignal, { readonly kind: "plan" }>,
): boolean {
  return (
    safeId(signal.anchorMessageId) &&
    Array.isArray(signal.steps) &&
    signal.steps.every((step) => validPlanStepInput(step))
  );
}

function validPlanStepInput(step: unknown): boolean {
  if (typeof step !== "object" || step === null || Array.isArray(step)) return false;
  const candidate = step as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) => key === "text" || key === "state") &&
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    (CODING_SAFE_ACTIVITY_PLAN_STEP_STATES as readonly unknown[]).includes(candidate.state)
  );
}

function signalDropReason(
  signal: CodingSafeActivitySignal,
): CodingSafeActivityDropReason | undefined {
  if (!validSignal(signal)) return "validation-rejected";
  if (signal.kind === "text" && stripUnsafeFormatChars(signal.text).length === 0) {
    return "redactor-collapsed";
  }
  return signal.kind === "plan" && signal.steps.length > 0 && planCollapses(signal.steps)
    ? "redactor-collapsed"
    : undefined;
}

function planCollapses(steps: readonly CodingSafeActivityPlanStepInput[]): boolean {
  return steps.every((step) => stripUnsafeFormatChars(step.text).length === 0);
}

function validOpenInput(
  input: CodingSafeActivityOpenInput,
  expiresAtMs: number,
  now: number,
): boolean {
  return (
    safeId(input.runId) &&
    safeId(input.workspaceId) &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > now
  );
}

function strictInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function exactSignalKeys(signal: CodingSafeActivitySignal): boolean {
  const common = ["kind", "occurredAt", "signalId"];
  const allowed =
    signal.kind === "message"
      ? [...common, "messageId", "role", "parentMessageId"]
      : signal.kind === "text"
        ? [...common, "messageId", "text"]
        : signal.kind === "plan"
          ? [...common, "anchorMessageId", "steps"]
          : [...common, "messageId", "callId", "tool", "state"];
  return Object.keys(signal).every((key) => allowed.includes(key));
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function rememberBoundedIdentity(identities: Set<string>, identity: string, max: number): void {
  identities.delete(identity);
  identities.add(identity);
  while (identities.size > max) {
    const oldest = identities.values().next().value;
    if (oldest === undefined) return;
    identities.delete(oldest);
  }
}

function withDroppedCount(
  feed: StoredFeed,
  droppedEventCount: number,
  updatedAt: string,
): StoredFeed {
  return {
    ...feed,
    updatedAt,
    droppedEventCount,
  };
}

function emitDropDiagnostic(
  sink: ServerDiagnosticSink | undefined,
  now: () => number,
  reason: CodingSafeActivityDropReason,
  count: number,
): void {
  emitServerDiagnostic(sink, {
    correlationId: `safe-activity-drop-${String(count)}`,
    timestamp: instant(now()),
    operation: "coding-runtime.safe-activity",
    source: "opencode.safe-activity",
    errorClass: "SafeActivityProjectionDrop",
    message: `Safe-activity event dropped (${reason}); bounded count ${String(count)}.`,
    code: "CODING_SAFE_ACTIVITY_EVENT_DROPPED",
    occurrenceCount: count,
  });
}

function boundedDropIncrement(count: number, maximum: number): number {
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, maximum) : 0;
}

function cloneFeed(feed: CodingSafeActivityFeed): CodingSafeActivityFeed {
  return structuredClone(feed);
}

function safeWorkspaceCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function boundedCounterLimit(value: number | undefined): number {
  return capped(value, CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function capped(value: number | undefined, cap: number): number {
  return Math.min(cap, positive(value, cap));
}

function instant(value: number): string {
  return new Date(value).toISOString();
}

function bytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8");
}
