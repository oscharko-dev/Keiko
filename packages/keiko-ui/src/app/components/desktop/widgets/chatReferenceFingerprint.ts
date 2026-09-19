"use client";

// Keeps a chat window's binding when its chat id cannot be persisted (#3557 review).
//
// Workspace persistence runs every value through the shared secret-shape heuristic, with no
// exemption. For about 2 in 10,000 random UUIDs that heuristic reads the digits across the last
// hyphen as a card number, so such a chat id is persisted as the redaction marker. The server no
// longer issues such ids, but an older chat can still carry one. For it, the window records a
// one-way fingerprint of the id, which persistence keeps and nothing can expand back into the id.
// On restore, the window finds its chat again by comparing that fingerprint with the chats the
// server lists: the server is the proof that the id is real, and the id never reaches storage.
//
// A redaction marker without a fingerprint identifies nothing: no listed chat can be proven to be
// the one it named, so such a window is never rebound on its own. It reports its chat as missing and
// offers the chats it may have named, those whose ids persistence redacts; only the person chooses.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { Chat, ProjectWithAvailability } from "@/lib/types";

import {
  ChatListLoadError,
  sharedFetchChatsWithEvidence,
  type ChatListLoad,
} from "../hooks/useChatSession";
import {
  CHAT_ID_FINGERPRINT_CFG_KEY,
  persistedReferenceEvidence,
  persistedReferenceShape,
} from "../hooks/workspace-persistence";
import type { WindowRenderContext } from "../windows/WindowsRegistry";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA256_HEX_LENGTH = 64;
const MIN_CHOICE_REFERENCE_LENGTH = 6;
const MAX_REBIND_RETRY_DELAY_MS = 30_000;
const FINGERPRINT_DOMAIN = "keiko-chat-reference-v1";
const FINGERPRINT_SEPARATOR = String.fromCharCode(0);

/**
 * The SHA-256 fingerprint of a chat id, domain-separated so it matches nothing else. Synchronous,
 * so a window records it in the same commit that shows the id.
 */
export function chatReferenceFingerprint(chatId: string): string {
  const input = `${FINGERPRINT_DOMAIN}${FINGERPRINT_SEPARATOR}${chatId}`;
  return bytesToHex(sha256(utf8ToBytes(input)));
}

// `unavailable`: a list that could hold the chat could not be read, so nothing is decided yet.
export type ChatReferenceLookup =
  | {
      readonly status: "found";
      readonly chat: Chat;
      // The chat list load whose answer decided the match.
      readonly correlationId: string;
    }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

// A failed load is reported under the id it was sent with and its closed class, so its failure
// joins the list load's own timeline (#3557 review).
function reportListingFailure(error: unknown): void {
  const failed = error instanceof ChatListLoadError ? error : undefined;
  const errorClass = failed?.errorClass ?? clientErrorSummary(error);
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] chat reference lookup failed: ${errorClass}`, {
    correlationId: failed?.correlationId,
    errorKind: failed?.errorKind ?? "unknown",
  });
}

async function projectListing(project: ProjectWithAvailability): Promise<ChatListLoad | undefined> {
  try {
    return await sharedFetchChatsWithEvidence(project.path);
  } catch (error) {
    reportListingFailure(error);
    return undefined;
  }
}

/** The open chat, among the listed projects' chats, whose id has this fingerprint. */
export async function findChatByFingerprint(
  fingerprint: string,
  projects: readonly ProjectWithAvailability[],
): Promise<ChatReferenceLookup> {
  const read = await Promise.all(projects.map(projectListing));
  for (const listing of read) {
    const chat = listing?.chats.find(
      (candidate) =>
        candidate.status !== "closed" && chatReferenceFingerprint(candidate.id) === fingerprint,
    );
    if (listing !== undefined && chat !== undefined) {
      return { status: "found", chat, correlationId: listing.correlationId };
    }
  }
  return read.includes(undefined) ? { status: "unavailable" } : { status: "absent" };
}

function cfgString(cfg: Record<string, unknown>, key: string): string | undefined {
  const value = cfg[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Records the fingerprint of a chat id the heuristic flags, in the same commit that shows the id:
 * a layout effect runs before the browser can dispatch the page-hide event that flushes the
 * workspace, so the id is never persisted redacted without its fingerprint.
 */
export function useChatReferenceFingerprint(
  chatId: string | undefined,
  recorded: string | undefined,
  updateCfg: WindowRenderContext["updateCfg"],
): void {
  useLayoutEffect((): void => {
    if (chatId === undefined || !persistedReferenceEvidence(chatId).heuristicFlagged) return;
    const fingerprint = chatReferenceFingerprint(chatId);
    if (fingerprint !== recorded) updateCfg({ [CHAT_ID_FINGERPRINT_CFG_KEY]: fingerprint });
  }, [chatId, recorded, updateCfg]);
}

/**
 * How a window found its chat again after persistence redacted its id (through the fingerprint, or
 * because the person chose it), and the chat list load that decided it.
 */
export interface ChatReferenceRestoration {
  readonly shape: "fingerprint" | "user-selected";
  readonly correlationId: string;
}

export interface ChatReferenceRebind {
  // A redacted chat id whose lookup has not settled yet.
  readonly pending: boolean;
  // Set while the window stays bound to the chat it found again.
  readonly restored: ChatReferenceRestoration | undefined;
}

interface ChatReferenceRebindSession {
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly projects: readonly ProjectWithAvailability[];
}

// The window's fingerprint when its chat id was redacted. Without one, or with a malformed one
// (persistence keeps only a digest, so it cannot come from storage), the window is not rebound.
function rebindFingerprint(cfg: Record<string, unknown>): string | undefined {
  const chatId = cfgString(cfg, "chatId");
  if (chatId === undefined || persistedReferenceShape(chatId) !== "redacted") return undefined;
  const fingerprint = cfgString(cfg, CHAT_ID_FINGERPRINT_CFG_KEY);
  return fingerprint !== undefined && SHA256_HEX.test(fingerprint) ? fingerprint : undefined;
}

// What the project catalog lets a lookup do (#3557 review). While it loads, the window waits. When
// it failed, or it lacks the window's own project, the window shows that the way it does for any
// chat (the session error, or its missing project) instead of waiting forever, and nothing is
// settled: the lookup runs as soon as the catalog changes.
type LookupScope =
  | { readonly kind: "wait" }
  | { readonly kind: "handover" }
  | { readonly kind: "lookup"; readonly projects: readonly ProjectWithAvailability[] };

function lookupScope(
  session: ChatReferenceRebindSession,
  projectPath: string | undefined,
): LookupScope {
  if (session.loading) return { kind: "wait" };
  if (session.projects.length === 0 && session.error !== undefined) return { kind: "handover" };
  if (projectPath === undefined) return { kind: "lookup", projects: session.projects };
  const own = session.projects.filter((entry) => entry.path === projectPath);
  return own.length === 0 ? { kind: "handover" } : { kind: "lookup", projects: own };
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_REBIND_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

// The restoration and the chat it bound the window to: it applies only while the window stays there.
interface RestoredBinding {
  readonly chatId: string;
  readonly restoration: ChatReferenceRestoration;
}

interface RetryingLookupArgs<T> {
  // Resolves undefined while a list the lookup needs cannot be read.
  readonly lookup: () => Promise<T | undefined>;
  readonly attempt: number;
  readonly onSettled: (value: T) => void;
  readonly onRetry: () => void;
}

function reportRebindFailure(error: unknown): void {
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] chat reference rebind failed: ${clientErrorSummary(error)}`);
}

// Runs one lookup and returns its cleanup. A list that could not be read schedules the next attempt
// after a bounded backoff instead of settling.
function runRetryingLookup<T>(args: RetryingLookupArgs<T>): () => void {
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const scheduleRetry = (): void => {
    retry = setTimeout((): void => {
      if (active) args.onRetry();
    }, retryDelayMs(args.attempt));
  };
  args.lookup().then(
    (value): void => {
      if (!active) return;
      if (value === undefined) scheduleRetry();
      else args.onSettled(value);
    },
    (error: unknown): void => {
      reportRebindFailure(error);
      if (active) scheduleRetry();
    },
  );
  return (): void => {
    active = false;
    if (retry !== undefined) clearTimeout(retry);
  };
}

type SettledChatReferenceLookup = Exclude<ChatReferenceLookup, { readonly status: "unavailable" }>;

async function settledFingerprintLookup(
  fingerprint: string,
  projects: readonly ProjectWithAvailability[],
): Promise<SettledChatReferenceLookup | undefined> {
  const lookup = await findChatByFingerprint(fingerprint, projects);
  return lookup.status === "unavailable" ? undefined : lookup;
}

function fingerprintBinding(lookup: SettledChatReferenceLookup): RestoredBinding | undefined {
  if (lookup.status === "absent") return undefined;
  return {
    chatId: lookup.chat.id,
    restoration: { shape: "fingerprint", correlationId: lookup.correlationId },
  };
}

/**
 * Finds a restored window's chat again through the fingerprint of its redacted id, among the chats
 * of the window's project, or of every project for a window that has none. The window stays pending
 * while the project catalog cannot answer yet, and while a list cannot be read: the lookup runs
 * again after a bounded backoff, and at once when the catalog changes. Without a match the window
 * reports its chat as missing, as before.
 */
export function useChatReferenceRebind(
  cfg: Record<string, unknown>,
  session: ChatReferenceRebindSession,
  updateCfg: WindowRenderContext["updateCfg"],
): ChatReferenceRebind {
  const fingerprint = rebindFingerprint(cfg);
  const chatId = cfgString(cfg, "chatId");
  const projectPath = cfgString(cfg, "projectPath");
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState<RestoredBinding | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const { error, loading, projects } = session;
  useEffect((): (() => void) | undefined => {
    if (fingerprint === undefined || settled === fingerprint) return undefined;
    const scope = lookupScope({ error, loading, projects }, projectPath);
    if (scope.kind !== "lookup") return undefined;
    return runRetryingLookup({
      lookup: () => settledFingerprintLookup(fingerprint, scope.projects),
      attempt,
      onSettled: (lookup): void => {
        const binding = fingerprintBinding(lookup);
        if (binding !== undefined) updateCfg({ chatId: binding.chatId });
        setRestored(binding);
        setSettled(fingerprint);
      },
      onRetry: (): void => {
        setAttempt((previous) => previous + 1);
      },
    });
  }, [attempt, error, fingerprint, loading, projectPath, projects, settled, updateCfg]);
  const handedOver = lookupScope({ error, loading, projects }, projectPath).kind === "handover";
  return {
    pending: fingerprint !== undefined && settled !== fingerprint && !handedOver,
    restored:
      restored !== undefined && restored.chatId === chatId ? restored.restoration : undefined,
  };
}

interface ListedChat {
  readonly chat: Chat;
  readonly correlationId: string;
}

// A candidate scan that read every list it needed.
interface RedactedChatCandidateScan {
  // Open chats whose ids persistence redacts, the most recently active first.
  readonly candidates: readonly ListedChat[];
  // The chat list loads whose answers decided the scan.
  readonly correlationIds: readonly string[];
}

function redactedChatsOf(listing: ChatListLoad): readonly ListedChat[] {
  return listing.chats
    .filter(
      (chat) => chat.status !== "closed" && persistedReferenceEvidence(chat.id).heuristicFlagged,
    )
    .map((chat) => ({ chat, correlationId: listing.correlationId }));
}

// Open chats whose ids persistence redacts: the only chats a redaction marker without a fingerprint
// can have named. While a list that could hold one cannot be read, the scan is undecided rather than
// an empty offer, and runs again (#3557 review).
async function findRedactedChatCandidates(
  projects: readonly ProjectWithAvailability[],
): Promise<RedactedChatCandidateScan | undefined> {
  const read = await Promise.all(projects.map(projectListing));
  const listings = read.filter((listing): listing is ChatListLoad => listing !== undefined);
  if (listings.length !== read.length) return undefined;
  return {
    candidates: listings
      .flatMap(redactedChatsOf)
      .sort((left, right) => right.chat.updatedAt - left.chat.updatedAt),
    correlationIds: listings.map((listing) => listing.correlationId),
  };
}

function unidentifiedReference(cfg: Record<string, unknown>): boolean {
  const chatId = cfgString(cfg, "chatId");
  if (chatId === undefined || persistedReferenceShape(chatId) !== "redacted") return false;
  return cfgString(cfg, CHAT_ID_FINGERPRINT_CFG_KEY) === undefined;
}

// Scans the window's project, or every project for a window that has none, once the catalog can
// answer; a list that could not be read is scanned again after a bounded backoff, and at once when
// the catalog changes.
function useRedactedChatCandidateScan(
  unidentified: boolean,
  projectPath: string | undefined,
  session: ChatReferenceRebindSession,
): RedactedChatCandidateScan | undefined {
  const [scan, setScan] = useState<RedactedChatCandidateScan | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const { error, loading, projects } = session;
  useEffect((): (() => void) | undefined => {
    if (!unidentified) return undefined;
    const scope = lookupScope({ error, loading, projects }, projectPath);
    if (scope.kind !== "lookup") return undefined;
    return runRetryingLookup({
      lookup: () => findRedactedChatCandidates(scope.projects),
      attempt,
      onSettled: setScan,
      onRetry: (): void => {
        setAttempt((previous) => previous + 1);
      },
    });
  }, [attempt, error, loading, projectPath, projects, unidentified]);
  return scan;
}

const CANDIDATES_OFFERED_DIAGNOSTIC = "[keiko] chat window offered conversations to choose from";

// The offer is reported under the list loads that decided it, with how many chats it holds, zero
// included, so the recovery state is reconstructable from the log (#3557 review). Only a redaction
// marker offers, and the marker itself is never heuristic-flagged; no chat id is ever sent.
function reportCandidatesOffered(scan: RedactedChatCandidateScan, windowId: string): void {
  const [correlationId, ...related] = scan.correlationIds;
  const loads = scan.correlationIds.length;
  const candidateCount = scan.candidates.length;
  reportClientDiagnostic(
    `${CANDIDATES_OFFERED_DIAGNOSTIC} (candidates=${String(candidateCount)})`,
    {
      correlationId,
      bindingReport: {
        surface: "chat-window",
        outcome: "candidates-offered",
        referenceShape: "redacted",
        heuristicFlagged: false,
        windowRef: windowId,
        candidateCount,
        ...(related.length === 0 ? {} : { relatedCorrelationIds: related }),
        ...(loads === 0 ? {} : { decidingLoadCount: loads }),
      },
    },
  );
}

// Each scan is reported once, however often the window renders.
function useCandidatesOfferedEvidence(
  scan: RedactedChatCandidateScan | undefined,
  windowId: string,
): void {
  const reportedRef = useRef(new WeakSet<RedactedChatCandidateScan>());
  useEffect((): void => {
    if (scan === undefined || reportedRef.current.has(scan)) return;
    reportedRef.current.add(scan);
    reportCandidatesOffered(scan, windowId);
  }, [scan, windowId]);
}

/** An offered chat and the label its button shows. */
export interface ChatChoiceOffer {
  readonly chat: Chat;
  readonly label: string;
}

// The shortest prefixes, six characters or more, that tell these fingerprints apart. Two distinct
// chat ids never share a fingerprint, so the whole fingerprint always does.
function distinctPrefixes(fingerprints: readonly string[]): readonly string[] {
  const prefixes = (length: number): readonly string[] =>
    fingerprints.map((fingerprint) => fingerprint.slice(0, length));
  let length = MIN_CHOICE_REFERENCE_LENGTH;
  while (length < SHA256_HEX_LENGTH && new Set(prefixes(length)).size < fingerprints.length) {
    length += 1;
  }
  return prefixes(length);
}

/**
 * The reference each offer shows beside its label (#3557 review). An offer whose label reads like
 * another's (one title, last active in one second) shows the start of its chat's fingerprint, the
 * one-way form the window persists, long enough to tell the two apart; any other offer shows none.
 * No two offers ever read alike, and none shows a chat id.
 */
export function chatChoiceReferences(
  offers: readonly ChatChoiceOffer[],
): readonly (string | undefined)[] {
  const alike = offers.filter((offer) =>
    offers.some((other) => other !== offer && other.label === offer.label),
  );
  const prefixes = distinctPrefixes(alike.map((offer) => chatReferenceFingerprint(offer.chat.id)));
  return offers.map((offer) => {
    const index = alike.indexOf(offer);
    return index === -1 ? undefined : prefixes[index];
  });
}

/** The chats a window whose redacted id carries no fingerprint may have shown, to choose from. */
export interface RedactedChatChoice {
  readonly candidates: readonly Chat[];
  readonly choose: (chat: Chat) => void;
}

export interface RedactedChatChoiceState {
  readonly choice: RedactedChatChoice | undefined;
  // Set while the window stays bound to the chat the person chose.
  readonly restored: ChatReferenceRestoration | undefined;
}

/**
 * Offers a window whose chat id persistence redacted without a fingerprint (a snapshot an older
 * build wrote) the listed chats it may have named, and binds it only to the one the person chooses
 * (#3557 review): nothing in such a snapshot proves which chat it was, so the window never guesses.
 */
export function useRedactedChatChoice(
  cfg: Record<string, unknown>,
  session: ChatReferenceRebindSession,
  ctx: Pick<WindowRenderContext, "updateCfg" | "windowId">,
): RedactedChatChoiceState {
  const unidentified = unidentifiedReference(cfg);
  const chatId = cfgString(cfg, "chatId");
  const scan = useRedactedChatCandidateScan(unidentified, cfgString(cfg, "projectPath"), session);
  useCandidatesOfferedEvidence(unidentified ? scan : undefined, ctx.windowId);
  const [chosen, setChosen] = useState<RestoredBinding | undefined>(undefined);
  const { updateCfg } = ctx;
  const choose = useCallback(
    (chat: Chat): void => {
      const listed = scan?.candidates.find((candidate) => candidate.chat.id === chat.id);
      if (listed === undefined) return;
      const restoration = { shape: "user-selected", correlationId: listed.correlationId } as const;
      setChosen({ chatId: chat.id, restoration });
      updateCfg({ chatId: chat.id });
    },
    [scan, updateCfg],
  );
  const candidates = unidentified ? (scan?.candidates ?? []) : [];
  return {
    choice:
      candidates.length > 0
        ? { candidates: candidates.map((candidate) => candidate.chat), choose }
        : undefined,
    restored: chosen !== undefined && chosen.chatId === chatId ? chosen.restoration : undefined,
  };
}
