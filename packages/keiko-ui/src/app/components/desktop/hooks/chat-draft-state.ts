import type { ChatDraft } from "@oscharko-dev/keiko-contracts/bff-wire";

export type DraftPhase =
  "loading" | "saved" | "unsaved" | "saving" | "unavailable" | "failed" | "conflict";
export interface DraftEntry {
  text: string;
  disposed: boolean;
  conflict: boolean;
  base: ChatDraft | undefined;
  edited: boolean;
  editVersion: number;
  phase: DraftPhase;
  pending: boolean;
  refreshQueued: boolean;
  readonly idleWaiters: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function newEntry(): DraftEntry {
  return {
    text: "",
    disposed: false,
    conflict: false,
    base: undefined,
    edited: false,
    editVersion: 0,
    phase: "loading",
    pending: false,
    refreshQueued: false,
    idleWaiters: [],
    timer: undefined,
  };
}
export function dirty(entry: DraftEntry): boolean {
  return !entry.disposed && entry.edited && entry.text !== entry.base?.text;
}
