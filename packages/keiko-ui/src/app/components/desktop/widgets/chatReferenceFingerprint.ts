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

import { useEffect, useState } from "react";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { Chat, ProjectWithAvailability } from "@/lib/types";

import { sharedFetchChats } from "../hooks/useChatSession";
import {
  CHAT_ID_FINGERPRINT_CFG_KEY,
  persistedReferenceEvidence,
  persistedReferenceShape,
} from "../hooks/workspace-persistence";
import type { WindowRenderContext } from "../windows/WindowsRegistry";

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 fingerprint of a chat id, domain-separated so it matches nothing else. */
export async function chatReferenceFingerprint(chatId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`keiko-chat-reference-v1\u0000${chatId}`);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function projectChats(project: ProjectWithAvailability): Promise<readonly Chat[]> {
  try {
    return (await sharedFetchChats(project.path)).chats;
  } catch (error) {
    // i18n-exempt: body-free diagnostic message for the activity log, never rendered
    reportClientDiagnostic(`[keiko] chat reference lookup failed: ${clientErrorSummary(error)}`);
    return [];
  }
}

/** The open chat, among the listed projects' chats, whose id has this fingerprint. */
export async function findChatByFingerprint(
  fingerprint: string,
  projects: readonly ProjectWithAvailability[],
): Promise<Chat | undefined> {
  const chats = (await Promise.all(projects.map(projectChats)))
    .flat()
    .filter((chat) => chat.status !== "closed");
  const fingerprints = await Promise.all(chats.map((chat) => chatReferenceFingerprint(chat.id)));
  return chats.find((_chat, index) => fingerprints[index] === fingerprint);
}

function cfgString(cfg: Record<string, unknown>, key: string): string | undefined {
  const value = cfg[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Records the fingerprint of a bound chat whose id the heuristic flags, so persistence can keep the
 * binding without the id. A reported failure leaves the window as it was: the binding then lasts
 * until the next reload.
 */
export function useChatReferenceFingerprint(
  chatId: string | undefined,
  recorded: string | undefined,
  bound: boolean,
  updateCfg: WindowRenderContext["updateCfg"],
): void {
  useEffect((): (() => void) | undefined => {
    if (!bound || chatId === undefined || !persistedReferenceEvidence(chatId).heuristicFlagged) {
      return undefined;
    }
    let active = true;
    chatReferenceFingerprint(chatId).then(
      (fingerprint): void => {
        if (active && fingerprint !== recorded) {
          updateCfg({ [CHAT_ID_FINGERPRINT_CFG_KEY]: fingerprint });
        }
      },
      (error: unknown): void => {
        // i18n-exempt: body-free diagnostic message for the activity log, never rendered
        reportClientDiagnostic(
          `[keiko] chat reference fingerprint failed: ${clientErrorSummary(error)}`,
        );
      },
    );
    return (): void => {
      active = false;
    };
  }, [bound, chatId, recorded, updateCfg]);
}

export interface ChatReferenceRebind {
  // A redacted chat id with a fingerprint whose lookup has not settled yet.
  readonly pending: boolean;
  // The window found its chat again through the fingerprint.
  readonly restored: boolean;
}

interface ChatReferenceRebindSession {
  readonly loading: boolean;
  readonly projects: readonly ProjectWithAvailability[];
}

function rebindFingerprint(cfg: Record<string, unknown>): string | undefined {
  const chatId = cfgString(cfg, "chatId");
  const fingerprint = cfgString(cfg, CHAT_ID_FINGERPRINT_CFG_KEY);
  if (chatId === undefined || persistedReferenceShape(chatId) !== "redacted") return undefined;
  return fingerprint !== undefined && SHA256_HEX.test(fingerprint) ? fingerprint : undefined;
}

/**
 * Finds a restored window's chat again when persistence redacted its id: the fingerprint is
 * compared with the chats of the window's project, or of every project for a window that has none.
 * While that runs the window is pending; without a match it reports its chat as missing, as before.
 */
export function useChatReferenceRebind(
  cfg: Record<string, unknown>,
  session: ChatReferenceRebindSession,
  updateCfg: WindowRenderContext["updateCfg"],
): ChatReferenceRebind {
  const fingerprint = rebindFingerprint(cfg);
  const projectPath = cfgString(cfg, "projectPath");
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const { loading, projects } = session;
  useEffect((): (() => void) | undefined => {
    if (fingerprint === undefined || loading || settled === fingerprint) return undefined;
    let active = true;
    const candidates =
      projectPath === undefined ? projects : projects.filter((entry) => entry.path === projectPath);
    findChatByFingerprint(fingerprint, candidates).then(
      (match): void => {
        if (!active) return;
        if (match !== undefined) {
          setRestored(true);
          updateCfg({ chatId: match.id });
        }
        setSettled(fingerprint);
      },
      (error: unknown): void => {
        // The lookup itself failed: the window reports its chat as missing instead of waiting.
        // i18n-exempt: body-free diagnostic message for the activity log, never rendered
        reportClientDiagnostic(
          `[keiko] chat reference rebind failed: ${clientErrorSummary(error)}`,
        );
        if (active) setSettled(fingerprint);
      },
    );
    return (): void => {
      active = false;
    };
  }, [fingerprint, loading, projectPath, projects, settled, updateCfg]);
  return { pending: fingerprint !== undefined && settled !== fingerprint, restored };
}
