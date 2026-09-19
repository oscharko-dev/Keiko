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
// the one it named, so such a window is never rebound and reports its chat as missing.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { useEffect, useLayoutEffect, useState } from "react";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { Chat, ProjectWithAvailability } from "@/lib/types";

import { sharedFetchChatsOutcome, type ChatListLoad } from "../hooks/useChatSession";
import {
  CHAT_ID_FINGERPRINT_CFG_KEY,
  persistedReferenceEvidence,
  persistedReferenceShape,
} from "../hooks/workspace-persistence";
import type { WindowRenderContext } from "../windows/WindowsRegistry";

const SHA256_HEX = /^[0-9a-f]{64}$/u;
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
async function projectListing(project: ProjectWithAvailability): Promise<ChatListLoad | undefined> {
  const outcome = await sharedFetchChatsOutcome(project.path);
  if (outcome.ok) return outcome.load;
  const { correlationId, errorClass, errorKind } = outcome.failure;
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] chat reference lookup failed: ${errorClass}`, {
    correlationId,
    errorKind,
  });
  return undefined;
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

/** A window found its chat again through the fingerprint, decided by this chat list load. */
export interface ChatReferenceRestoration {
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

// The projects a lookup searches, or undefined while their answer could still change: the project
// catalog is loading or failed to load, or the window's own project is not listed (#3557 review).
function lookupProjects(
  session: ChatReferenceRebindSession,
  projectPath: string | undefined,
): readonly ProjectWithAvailability[] | undefined {
  if (session.loading) return undefined;
  if (session.projects.length === 0 && session.error !== undefined) return undefined;
  if (projectPath === undefined) return session.projects;
  const own = session.projects.filter((entry) => entry.path === projectPath);
  return own.length === 0 ? undefined : own;
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
  readonly fingerprint: string;
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
  findChatByFingerprint(args.fingerprint, args.projects).then(
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
      args.updateCfg({ chatId: lookup.chat.id });
      args.onSettled({
        chatId: lookup.chat.id,
        restoration: { correlationId: lookup.correlationId },
      });
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
    const searched = lookupProjects({ error, loading, projects }, projectPath);
    if (searched === undefined) return undefined;
    return runRebindLookup({
      fingerprint,
      projects: searched,
      attempt,
      updateCfg,
      onSettled: (binding): void => {
        setRestored(binding);
        setSettled(fingerprint);
      },
      onRetry: (): void => {
        setAttempt((previous) => previous + 1);
      },
    });
  }, [attempt, error, fingerprint, loading, projectPath, projects, settled, updateCfg]);
  return {
    pending: fingerprint !== undefined && settled !== fingerprint,
    restored:
      restored !== undefined && restored.chatId === chatId ? restored.restoration : undefined,
  };
}
