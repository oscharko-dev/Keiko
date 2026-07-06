// Shared request guards for the governed local Git delivery execution routes (Issue #475, Epic #470).
//
// The #473 action-sheet route established the BFF request-hardening shape (bounded body read, allowed-
// key whitelist, credential-shape scan, unsafe-format-char scan, content-free error envelope). The
// #475 execution routes (branch / staging / commit) share that exact discipline; this module is the
// single home for those guards so the new routes never duplicate the boundary logic.
//
// CSRF + JSON content-type are enforced CENTRALLY by server.ts for POST, so they are NOT re-checked
// here — these guards run AFTER that central gate.

import type { IncomingMessage } from "node:http";
import { containsForbiddenSecretShape } from "../qualityIntelligence/connectorErrors.js";

export const GIT_DELIVERY_MAX_BODY_BYTES = 64 * 1024;

export class GitDeliveryBodyTooLargeError extends Error {
  public constructor() {
    super("Request body exceeds the git-delivery route cap");
    this.name = "GitDeliveryBodyTooLargeError";
  }
}

export const readGitDeliveryBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > GIT_DELIVERY_MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new GitDeliveryBodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOnlyAllowedKeys = (
  obj: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
};

export const scanForbiddenStrings = (value: unknown): boolean => {
  if (typeof value === "string") return containsForbiddenSecretShape(value);
  if (Array.isArray(value)) return value.some(scanForbiddenStrings);
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) {
      if (scanForbiddenStrings(v)) return true;
    }
    return false;
  }
  return false;
};

// Zero-width, bidi-control, and BOM format characters. Branch names / refs / pathspecs in these
// content-free requests never legitimately contain them; a U+202E override or zero-width char would
// spoof the displayed action target (Trojan-Source). Reject fail-closed at the boundary.
export const GIT_DELIVERY_UNSAFE_FORMAT_CHAR = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]",
  "u",
);

export const scanUnsafeFormatChars = (value: unknown): boolean => {
  if (typeof value === "string") return GIT_DELIVERY_UNSAFE_FORMAT_CHAR.test(value);
  if (Array.isArray(value)) return value.some(scanUnsafeFormatChars);
  if (isPlainObject(value)) return Object.values(value).some(scanUnsafeFormatChars);
  return false;
};

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// C0 control characters (incl. TAB/LF/CR/NUL) and DEL. A pathspec in these content-free requests never
// legitimately contains them; rejecting fail-closed keeps the pathspec guard symmetric with the
// network-ref REF_CONTROL_CHAR guard (syncRoutes.ts). Pathspecs are already literalized as
// :(literal)<value> after a "--" sentinel at the adapter, so this is defence-in-depth, not a live fix.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
export const GIT_DELIVERY_PATHSPEC_CONTROL_CHAR = new RegExp("[\\u0000-\\u001f\\u007f]");

// A staged/unstaged pathspec must be a relative path that cannot escape the repository working tree:
// no absolute path, no leading "-" (flag injection — also guarded at the adapter), no ".." traversal
// segment, and no NUL / C0 control / DEL char. Defence-in-depth above git's own working-tree containment.
export const isContainedPathspec = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (GIT_DELIVERY_PATHSPEC_CONTROL_CHAR.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false; // Windows drive-qualified
  const segments = value.split(/[\\/]+/);
  return !segments.includes("..");
};
