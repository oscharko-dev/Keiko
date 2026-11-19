// Windows system noise pruned by recursive discovery (#4437). This is NOT a security tier: the
// always-on deny list (ignore.ts) stays the only boundary, and nothing here can admit a path the deny
// list refuses. These names belong to the operating system, not to the person, so a walk over a
// connected user profile or a whole drive spends its time on documents instead. The walk prunes them
// only while descending; an explicitly selected path is a human decision and is never pruned. Every
// pruned entry is counted and disclosed as `ignored`, with its own system-noise count.
//
// `AppData` is deliberately absent (owner decision 2026-11-17): it stays searchable, and the UI
// shows a sensitive-data notice instead. Installed-software folders (`Program Files`, `ProgramData`)
// are absent for the same reason: they can hold configuration a person searches for.
//
// The list is documented in ADR-0022 (connected-context privacy); keep both in step.

/** Names the operating system creates in any folder or at the root of every volume. */
const ANY_DEPTH_SYSTEM_NOISE_NAMES: ReadonlySet<string> = new Set([
  // Recycle bins (Vista and later, then XP/2000 on NTFS and FAT volumes).
  "$recycle.bin",
  "recycler",
  "recycled",
  // Volume shadow copies, restore points and indexer state; never readable by the person.
  "system volume information",
  // Explorer view state and thumbnail caches.
  "desktop.ini",
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
]);

/**
 * Registry hive files of a user profile (`NTUSER.DAT`, `ntuser.dat.LOG1`, `ntuser.ini`, the
 * `NTUSER.DAT{guid}.TM.blf` transaction logs). Always locked while the person is signed in.
 */
const ANY_DEPTH_SYSTEM_NOISE_PREFIX = "ntuser.";

/** Names that are system noise only directly below a connected drive root (`C:\`). */
const DRIVE_ROOT_SYSTEM_NOISE_NAMES: ReadonlySet<string> = new Set([
  "windows",
  "windows.old",
  "$windows.~bt",
  "$windows.~ws",
  "$winreagent",
  "$getcurrent",
  "$sysreset",
  "config.msi",
  "perflogs",
  "recovery",
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "dumpstack.log",
  "dumpstack.log.tmp",
]);

// `C:`, `C:\` or `C:/`, optionally as a `\\?\` extended-length path. A UNC share root is not a
// drive root: its top level belongs to whoever shares it.
const WINDOWS_DRIVE_ROOT = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]?$/u;

/** True when `absolutePath` names the root of a Windows drive. Pure string syntax, any platform. */
export function isWindowsDriveRoot(absolutePath: string): boolean {
  return WINDOWS_DRIVE_ROOT.test(absolutePath);
}

export interface SystemNoiseEntryContext {
  /** The entry sits directly below a connected drive root. */
  readonly atDriveRoot: boolean;
}

/**
 * True when a directory entry named `name` is Windows system noise. Matching is case-insensitive,
 * as on Windows. Only the entry's own name is examined, never its parent path.
 */
export function isSystemNoiseEntry(name: string, context: SystemNoiseEntryContext): boolean {
  const lower = name.toLowerCase();
  if (ANY_DEPTH_SYSTEM_NOISE_NAMES.has(lower) || lower.startsWith(ANY_DEPTH_SYSTEM_NOISE_PREFIX)) {
    return true;
  }
  return context.atDriveRoot && DRIVE_ROOT_SYSTEM_NOISE_NAMES.has(lower);
}
