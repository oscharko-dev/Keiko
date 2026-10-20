import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { dirty, newEntry, type DraftEntry } from "./chat-draft-state";
import type { ChatDraftActions } from "./chat-draft-runtime";
export type { DraftPhase } from "./chat-draft-state";

/** Immediate per-window editing state; private persistence loads on first use. */
export class ChatDraftController {
  private readonly entries = new Map<string, DraftEntry>();
  private actions: Promise<ChatDraftActions> | undefined;
  constructor(
    private readonly changed: () => void,
    private readonly replaced: () => void = () => {},
  ) {}
  entry(chatId: string): DraftEntry {
    let entry = this.entries.get(chatId);
    if (entry === undefined) {
      entry = newEntry();
      this.entries.set(chatId, entry);
    }
    return entry;
  }

  setText(chatId: string, text: string): void {
    const entry = this.entry(chatId);
    if (entry.text === text) {
      // A synchronous publication must acknowledge an already-mutated, uncommitted entry.
      this.changed();
      return;
    }
    entry.text = text;
    entry.edited = true;
    entry.editVersion += 1;
    entry.phase = entry.conflict ? "conflict" : "unsaved";
    this.changed();
    this.schedule(chatId, entry);
  }

  private schedule(chatId: string, entry: DraftEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.save(chatId);
    }, 300);
  }

  private loadActions(): Promise<ChatDraftActions> {
    this.actions ??= import("./chat-draft-runtime").then(
      ({ ChatDraftActions }) =>
        new ChatDraftActions({
          entries: this.entries,
          entry: (chatId): DraftEntry => this.entry(chatId),
          changed: this.changed,
          replaced: this.replaced,
          schedule: (chatId, entry): void => this.schedule(chatId, entry),
          hasUnsaved: (): boolean => this.hasUnsaved(),
        }),
    );
    return this.actions;
  }

  private async run<T>(
    operation: (actions: ChatDraftActions) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await operation(await this.loadActions());
    } catch {
      this.actions = undefined;
      for (const entry of this.entries.values()) entry.phase = "failed";
      this.changed();
      reportClientDiagnostic("Private chat draft runtime could not be loaded.", {
        errorKind: "unavailable",
      });
      return fallback;
    }
  }

  private forEntry(
    chatId: string,
    operation: (actions: ChatDraftActions) => Promise<void>,
  ): Promise<void> {
    const entry = this.entry(chatId);
    return this.run(async (actions) => {
      if (!entry.disposed && this.entries.get(chatId) === entry) await operation(actions);
    }, undefined);
  }

  refresh(chatId: string): Promise<void> {
    return this.forEntry(chatId, (actions) => actions.refresh(chatId));
  }
  save(chatId: string): Promise<void> {
    return this.forEntry(chatId, (actions) => actions.save(chatId));
  }
  keepLocal(chatId: string): Promise<void> {
    return this.forEntry(chatId, (actions) => actions.keepLocal(chatId));
  }
  restoreSaved(chatId: string): Promise<void> {
    const editVersion = this.entry(chatId).editVersion;
    return this.forEntry(chatId, (actions) => actions.restoreSaved(chatId, editVersion));
  }
  prepareClose(): Promise<boolean> {
    if (!this.hasUnsaved()) return Promise.resolve(true);
    return this.run((actions) => actions.prepareClose(), false);
  }

  /** Called only after the owning chat deletion has been confirmed. */
  forget(chatId: string): void {
    const entry = this.entries.get(chatId);
    if (entry === undefined) return;
    entry.disposed = true;
    entry.pending = false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    for (const resolve of entry.idleWaiters.splice(0)) resolve();
    this.entries.delete(chatId);
    this.changed();
  }

  hasUnsaved(): boolean {
    return [...this.entries.values()].some((entry) => dirty(entry) || entry.phase === "saving");
  }

  flush(): void {
    for (const [chatId, entry] of this.entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined;
      void this.save(chatId);
    }
  }
}
