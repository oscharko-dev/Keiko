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
// A snapshot an older build wrote holds the redaction marker without a fingerprint. A redacted
// reference can only have named a chat whose id persistence redacts, so when exactly one listed
// chat has such an id, the window binds to it; with none, or with several, it reports its chat as
// missing rather than guess.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { useEffect, useLayoutEffect, useState } from "react";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import type { Chat, ProjectWithAvailability } from "@/lib/types";

import { sharedFetchChats } from "../hooks/useChatSession";
import {
  CHAT_ID_FINGERPRINT_CFG_KEY,
  persistedReferenceEvidence,
  persistedReferenceShape,
} from "../hooks/workspace-persistence";
import type { WindowRenderContext } from "../windows/WindowsRegistry";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_REBIND_RETRY_DELAY_MS = 30_000;
const SOLE_CANDIDATE_KEY = "sole-candidate";

/**
 * The SHA-256 fingerprint of a chat id, domain-separated so it matches nothing else. Synchronous,
 * so a window records it in the same commit that shows the id.
 */
export function chatReferenceFingerprint(chatId: string): string {
  return bytesToHex(sha256(utf8ToBytes(`keiko-chat-reference-v1\u0000${chatId}`)));
}

/** How a redacted reference is found again: through its fingerprint, or as the sole candidate. */
export type ChatReferenceTarget =
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "sole-candidate" };

type ChatReferenceShape = ChatReferenceTarget["kind"];

// `unavailable`: a list that could hold the chat could not be read, so nothing is decided yet.
export type ChatReferenceLookup =
  | {
      readonly status: "found";
      readonly chat: Chat;
      readonly shape: ChatReferenceShape;
      // The chat list loads whose answer decided the match.
      readonly correlationIds: readonly string[];
    }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

interface ChatListing {
  readonly chats: readonly Chat[];
  readonly correlationId: string;
}

async function projectListing(project: ProjectWithAvailability): Promise<ChatListing | undefined> {
  try {
    return await sharedFetchChats(project.path);
  } catch (error) {
    // i18n-exempt: body-free diagnostic message for the activity log, never rendered
    reportClientDiagnostic(`[keiko] chat reference lookup failed: ${clientErrorSummary(error)}`, {
      correlationId: correlationIdOf(error),
    });
    return undefined;
  }
}

interface ListedChat {
  readonly chat: Chat;
  readonly correlationId: string;
}

function openChats(listings: readonly ChatListing[]): readonly ListedChat[] {
  return listings.flatMap((listing) =>
    listing.chats
      .filter((chat) => chat.status !== "closed")
      .map((chat) => ({ chat, correlationId: listing.correlationId })),
  );
}

function fingerprintMatch(
  fingerprint: string,
  listings: readonly ChatListing[],
  complete: boolean,
): ChatReferenceLookup {
  const match = openChats(listings).find(
    (listed) => chatReferenceFingerprint(listed.chat.id) === fingerprint,
  );
  if (match !== undefined) {
    const { chat, correlationId } = match;
    return { status: "found", chat, shape: "fingerprint", correlationIds: [correlationId] };
  }
  return complete ? { status: "absent" } : { status: "unavailable" };
}

// Uniqueness is only known once every list that could hold a second candidate has been read, so
// every one of those loads decided the match.
function soleCandidate(listings: readonly ChatListing[], complete: boolean): ChatReferenceLookup {
  if (!complete) return { status: "unavailable" };
  const candidates = openChats(listings).filter(
    (listed) => persistedReferenceEvidence(listed.chat.id).heuristicFlagged,
  );
  const [only] = candidates;
  if (candidates.length !== 1 || only === undefined) return { status: "absent" };
  const correlationIds = listings.map((listing) => listing.correlationId);
  return { status: "found", chat: only.chat, shape: "sole-candidate", correlationIds };
}

/** The open chat, among the listed projects' chats, that a redacted reference named. */
export async function findRestoredChat(
  target: ChatReferenceTarget,
  projects: readonly ProjectWithAvailability[],
): Promise<ChatReferenceLookup> {
  const read = await Promise.all(projects.map(projectListing));
  const listings = read.filter((listing): listing is ChatListing => listing !== undefined);
  const complete = listings.length === read.length;
  return target.kind === "fingerprint"
    ? fingerprintMatch(target.fingerprint, listings, complete)
    : soleCandidate(listings, complete);
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

/** How the window found its chat again, and the chat list loads that decided it. */
export interface ChatReferenceRestoration {
  readonly shape: ChatReferenceShape;
  readonly correlationIds: readonly string[];
}

export interface ChatReferenceRebind {
  // A redacted chat id whose lookup has not settled yet.
  readonly pending: boolean;
  // Set while the window stays bound to the chat it found again.
  readonly restored: ChatReferenceRestoration | undefined;
}

interface ChatReferenceRebindSession {
  readonly loading: boolean;
  readonly projects: readonly ProjectWithAvailability[];
}

// A malformed fingerprint cannot come from storage (persistence keeps only a digest), so a window
// holding one is left as it is. The key is the fingerprint itself or the sole-candidate marker.
function rebindKey(cfg: Record<string, unknown>): string | undefined {
  const chatId = cfgString(cfg, "chatId");
  if (chatId === undefined || persistedReferenceShape(chatId) !== "redacted") return undefined;
  const fingerprint = cfgString(cfg, CHAT_ID_FINGERPRINT_CFG_KEY);
  if (fingerprint === undefined) return SOLE_CANDIDATE_KEY;
  return SHA256_HEX.test(fingerprint) ? fingerprint : undefined;
}

function rebindTarget(key: string): ChatReferenceTarget {
  return key === SOLE_CANDIDATE_KEY
    ? { kind: "sole-candidate" }
    : { kind: "fingerprint", fingerprint: key };
}

function retryDelayMs(attempt: number): number {
  return Math.min(MAX_REBIND_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

// The restoration and the chat it bound the window to: it applies only while the window stays there.
interface RestoredBinding {
  readonly chatId: string;
  readonly restoration: ChatReferenceRestoration;
}

interface RebindLookupArgs {
  readonly key: string;
  readonly projects: readonly ProjectWithAvailability[];
  readonly attempt: number;
  readonly updateCfg: WindowRenderContext["updateCfg"];
  readonly onSettled: (restored: RestoredBinding | undefined) => void;
  readonly onRetry: () => void;
}

function reportRebindFailure(error: unknown): void {
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] chat reference rebind failed: ${clientErrorSummary(error)}`);
}

// Runs one lookup and returns its cleanup. A found chat rebinds the window; a list that could not
// be read schedules the next attempt instead of settling.
function runRebindLookup(args: RebindLookupArgs): () => void {
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const scheduleRetry = (): void => {
    retry = setTimeout((): void => {
      if (active) args.onRetry();
    }, retryDelayMs(args.attempt));
  };
  findRestoredChat(rebindTarget(args.key), args.projects).then(
    (lookup): void => {
      if (!active) return;
      if (lookup.status === "unavailable") {
        scheduleRetry();
        return;
      }
      if (lookup.status === "absent") {
        args.onSettled(undefined);
        return;
      }
      const { chat, correlationIds, shape } = lookup;
      args.updateCfg({ chatId: chat.id });
      args.onSettled({ chatId: chat.id, restoration: { shape, correlationIds } });
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

/**
 * Finds a restored window's chat again when persistence redacted its id, among the chats of the
 * window's project, or of every project for a window that has none. While that runs the window is
 * pending. A list that cannot be read decides nothing: the lookup runs again after a bounded
 * backoff, and at once when the listed projects change. Without a match the window reports its
 * chat as missing, as before.
 */
export function useChatReferenceRebind(
  cfg: Record<string, unknown>,
  session: ChatReferenceRebindSession,
  updateCfg: WindowRenderContext["updateCfg"],
): ChatReferenceRebind {
  const key = rebindKey(cfg);
  const chatId = cfgString(cfg, "chatId");
  const projectPath = cfgString(cfg, "projectPath");
  const [settledKey, setSettledKey] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState<RestoredBinding | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const { loading, projects } = session;
  useEffect((): (() => void) | undefined => {
    if (key === undefined || loading || settledKey === key) return undefined;
    return runRebindLookup({
      key,
      projects:
        projectPath === undefined
          ? projects
          : projects.filter((entry) => entry.path === projectPath),
      attempt,
      updateCfg,
      onSettled: (binding): void => {
        setRestored(binding);
        setSettledKey(key);
      },
      onRetry: (): void => {
        setAttempt((previous) => previous + 1);
      },
    });
  }, [attempt, key, loading, projectPath, projects, settledKey, updateCfg]);
  return {
    pending: key !== undefined && settledKey !== key,
    restored:
      restored !== undefined && restored.chatId === chatId ? restored.restoration : undefined,
  };
}
