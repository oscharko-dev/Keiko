import type { ChatDraft } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { readChatDraft, writeChatDraft } from "@/lib/chat-draft-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";

import { dirty, type DraftEntry, type DraftPhase } from "./chat-draft-state";

function reportFailure(error: unknown): void {
  reportClientDiagnostic("Private chat draft request failed.", {
    correlationId: correlationIdOf(error),
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
  });
}
function failurePhase(error: unknown): DraftPhase {
  if (error instanceof ApiError && error.status === 409) return "conflict";
  if (error instanceof ApiError && error.status === 404) return "unavailable";
  return "failed";
}

function canSave(chatId: string, entry: DraftEntry): boolean {
  return chatId !== "" && !entry.pending && !entry.conflict && entry.phase === "unsaved";
}

export interface DraftRuntimeState {
  readonly entries: ReadonlyMap<string, DraftEntry>;
  readonly entry: (chatId: string) => DraftEntry;
  readonly changed: () => void;
  readonly replaced: () => void;
  readonly schedule: (chatId: string, entry: DraftEntry) => void;
  readonly hasUnsaved: () => boolean;
}

export class ChatDraftActions {
  constructor(private readonly state: DraftRuntimeState) {}
  private applyRead(entry: DraftEntry, remote: ChatDraft): void {
    const previousText = entry.text;
    if (!dirty(entry)) {
      entry.text = remote.text;
      entry.edited = false;
      entry.conflict = false;
      entry.phase = "saved";
    } else if (entry.text === remote.text) {
      entry.phase = "saved";
      entry.edited = false;
      entry.conflict = false;
    } else if (entry.conflict || remote.text !== (entry.base?.text ?? "")) {
      entry.conflict = true;
      entry.phase = "conflict";
    } else {
      entry.phase = "unsaved";
    }
    entry.base = remote;
    if (entry.text !== previousText) this.state.replaced();
  }

  async refresh(chatId: string): Promise<void> {
    const entry = this.state.entry(chatId);
    if (entry.pending) {
      entry.refreshQueued = true;
      return;
    }
    entry.pending = true;
    this.state.changed();
    try {
      const remote = await readChatDraft(chatId);
      if (!entry.disposed) this.applyRead(entry, remote);
    } catch (error) {
      if (entry.disposed) return;
      entry.phase = failurePhase(error);
      entry.conflict ||= entry.phase === "conflict";
      reportFailure(error);
    } finally {
      this.settled(chatId, entry);
    }
  }

  private settled(chatId: string, entry: DraftEntry): void {
    if (entry.disposed) return;
    entry.pending = false;
    for (const resolve of entry.idleWaiters.splice(0)) resolve();
    this.state.changed();
    if (entry.refreshQueued) {
      entry.refreshQueued = false;
      void this.refresh(chatId);
    } else if (entry.phase === "unsaved") {
      this.state.schedule(chatId, entry);
    }
  }

  async save(chatId: string): Promise<void> {
    const entry = this.state.entry(chatId);
    if (!canSave(chatId, entry)) return;
    if (entry.base === undefined) {
      await this.refresh(chatId);
      return;
    }
    if (!dirty(entry)) {
      entry.phase = "saved";
      this.state.changed();
      return;
    }
    entry.pending = true;
    entry.phase = "saving";
    this.state.changed();
    try {
      const saved = await writeChatDraft(chatId, {
        text: entry.text,
        expectedRevision: entry.base.revision,
      });
      if (entry.disposed) return;
      entry.base = saved;
      entry.phase = dirty(entry) ? "unsaved" : "saved";
    } catch (error) {
      if (entry.disposed) return;
      entry.phase = failurePhase(error);
      entry.conflict ||= entry.phase === "conflict";
      reportFailure(error);
    } finally {
      this.settled(chatId, entry);
    }
  }

  /** Explicit conflict resolution: refresh authority/revision, then CAS the still-current local text. */
  async keepLocal(chatId: string): Promise<void> {
    const entry = this.state.entry(chatId);
    if (entry.pending) return;
    entry.pending = true;
    this.state.changed();
    try {
      const remote = await readChatDraft(chatId);
      if (entry.disposed) return;
      entry.base = remote;
      entry.conflict = false;
      entry.phase = "unsaved";
    } catch (error) {
      if (entry.disposed) return;
      entry.phase = failurePhase(error);
      entry.conflict ||= entry.phase === "conflict";
      reportFailure(error);
    } finally {
      this.settled(chatId, entry);
    }
    await this.save(chatId);
  }

  async restoreSaved(chatId: string, editVersion: number): Promise<void> {
    const entry = this.state.entry(chatId);
    if (entry.pending) return;
    entry.pending = true;
    this.state.changed();
    try {
      const remote = await readChatDraft(chatId);
      if (entry.disposed) return;
      // Do not erase typing that happened after the explicit replacement click.
      if (entry.editVersion === editVersion) {
        if (entry.text !== remote.text) this.state.replaced();
        entry.text = remote.text;
        entry.edited = false;
        entry.conflict = false;
        entry.phase = "saved";
      } else {
        entry.conflict = true;
        entry.phase = "conflict";
      }
      entry.base = remote;
    } catch (error) {
      if (entry.disposed) return;
      entry.phase = failurePhase(error);
      entry.conflict ||= entry.phase === "conflict";
      reportFailure(error);
    } finally {
      this.settled(chatId, entry);
    }
  }

  private async waitUntilIdle(entry: DraftEntry): Promise<void> {
    while (entry.pending) {
      await new Promise<void>((resolve) => {
        entry.idleWaiters.push(resolve);
      });
    }
  }

  private async settleForClose(chatId: string, entry: DraftEntry): Promise<boolean> {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    await this.waitUntilIdle(entry);
    while (dirty(entry) && entry.phase === "unsaved") {
      await this.save(chatId);
      await this.waitUntilIdle(entry);
      if (chatId === "") return false;
    }
    return !dirty(entry);
  }

  async prepareClose(): Promise<boolean> {
    do {
      const outcomes = await Promise.all(
        [...this.state.entries].map(([chatId, entry]) => this.settleForClose(chatId, entry)),
      );
      if (!outcomes.every(Boolean)) return false;
      // Typing or chat navigation may have changed entries while another save was pending.
    } while (this.state.hasUnsaved());
    return true;
  }
}
