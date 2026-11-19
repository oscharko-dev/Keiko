// Per-entry availability classification for recursive walks (#4434, #4435).
//
// A recursive walk observes one directory entry at a time. Two classes of per-entry failure are
// local to that entry and must never fail the whole walk:
//   - "vanished": the entry was listed but no longer exists, or a path component stopped being a
//     directory (ENOENT, ENOTDIR, ESTALE). Office lock files and sync clients create and delete
//     such entries constantly; the entry's absence is the current state of the folder.
//   - "unavailable": the entry exists but cannot be inspected (EACCES, EPERM, EBUSY, EIO). On
//     Windows a sharing or lock violation surfaces as EBUSY, a protected file as EACCES/EPERM.
// Every other failure stays with its caller's fail-closed handling: descriptor or memory
// exhaustion (EMFILE, ENFILE, ENOMEM), link loops, identity changes and containment escapes are
// never classified here, so they keep failing the operation.

export type WorkspaceEntryAvailability = "vanished" | "unavailable";

const VANISHED_ENTRY_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ESTALE"]);
const UNAVAILABLE_ENTRY_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EBUSY", "EIO"]);

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Classifies a filesystem failure on one walked entry; `undefined` means the failure is fatal. */
export function workspaceEntryAvailabilityFailure(
  error: unknown,
): WorkspaceEntryAvailability | undefined {
  const code = errorCode(error);
  if (code === undefined) return undefined;
  if (VANISHED_ENTRY_CODES.has(code)) return "vanished";
  if (UNAVAILABLE_ENTRY_CODES.has(code)) return "unavailable";
  return undefined;
}
