// Strict free-form identity-field guard for managed task workspaces
// (Issue #449 / PR #1587 security follow-up — LOW, defense in depth).
//
// `requestedBy` and `taskId` are length-bounded but otherwise free-form. They flow into the advisory
// lock `owner` (locks.ts makeWorkspaceLock), the active-pointer `setBy` (lifecycle.ts setActiveImpl),
// the persisted WorkspaceInstance, and the content-free lifecycle evidence — all of which may later be
// surfaced to an operator. There is no injection sink in the server layer today, so this is a
// fail-closed hardening: a C0/C1/DEL control, a zero-width, or a bidirectional-override
// ("Trojan-source") code point in an identity field signals a bug or a spoofing attempt (a forged
// operator name on an audit line, a reordered task id), never legitimate input.
//
// We REJECT rather than strip. `taskId` is the idempotency key — it is hashed raw into the workspace
// id, the task branch, and the managed worktree path (naming.ts) — and `requestedBy` is compared by
// equality for advisory-lock ownership. Silently stripping would change the derived identity and could
// collapse two distinct actors to the same owner string; rejecting keeps the persisted identity
// faithful to the caller's input.
//
// The unsafe character set IS the canonical `stripUnsafeFormatChars` primitive (keiko-contracts
// text-safety), reused so the security-critical Unicode ranges live in exactly one place, made
// STRICTER: identity fields are single-line tokens, so the TAB/LF/CR that text-safety deliberately
// preserves for multi-line evidence are forbidden here too (they would otherwise enable log-line
// spoofing in an operator audit view).

import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { TaskWorkspaceError } from "./errors.js";

// True when `value` carries any control (C0/C1/DEL, incl. TAB/LF/CR), zero-width, BOM, or
// bidirectional-override code point. Pure; no allocation on the common (clean) path.
export function containsUnsafeFieldChars(value: string): boolean {
  // stripUnsafeFormatChars removes C0/C1/DEL (except TAB/LF/CR) + bidi/zero-width/BOM and returns the
  // SAME reference when nothing was removed, so a reference inequality means an unsafe code point was
  // present. The TAB/LF/CR that text-safety preserves are caught explicitly to keep identity fields
  // strictly single-line.
  if (stripUnsafeFormatChars(value) !== value) return true;
  return /[\t\n\r]/u.test(value);
}

// Throws INVALID_REQUEST when a free-form identity field carries a forbidden code point. `field` names
// the offending field in the reason list WITHOUT echoing its (untrusted) value.
export function assertSafeFieldValue(value: string, field: string): void {
  if (containsUnsafeFieldChars(value)) {
    throw new TaskWorkspaceError("INVALID_REQUEST", "field contains forbidden characters", [field]);
  }
}
