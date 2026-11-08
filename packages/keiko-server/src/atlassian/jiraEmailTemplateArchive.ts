import { createHash } from "node:crypto";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { readBoundedOoxmlPackage } from "@oscharko-dev/keiko-local-knowledge";
import type { JiraEmailTemplateEntry, JiraEmailTemplateObservation, JiraEmailTemplatePack } from "@oscharko-dev/keiko-connectors";
import { admitJiraEmailTemplateParts } from "./jiraAttachmentContentPolicy.js";

// Existing attachment inflation ceiling and content-scan deadline; no larger archive budget.
const INFLATED_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 15000;
type Inspection = JiraEmailTemplateObservation<JiraEmailTemplatePack> & { readonly contentRefusal?: "unscannable" | "contains-credential" };
const malformed = (): JiraEmailTemplateObservation<never> => ({ ok: false, reason: "malformed-payload" });
function digest(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function portablePart(part: string): boolean {
  if (part.endsWith(".") || part.endsWith(" ") || /[<>:"|?*%\p{Cc}\p{Surrogate}]/u.test(part)) return false;
  return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part);
}
function portableName(name: string): string | undefined {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!isPortableWorkspaceRelativePath(path) || path.length > 1024) return undefined;
  if (path.normalize("NFC") !== path || path.normalize("NFKC") !== path) return undefined;
  return path.split("/").every(portablePart) ? path : undefined;
}
function pathKinds(parts: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, boolean> | undefined {
  const known = new Map<string, boolean>();
  for (const [name, bytes] of parts) {
    const path = portableName(name);
    if (path === undefined) return undefined;
    const key = path.toUpperCase().toLowerCase();
    const directory = name.endsWith("/");
    if (known.has(key) || (directory && bytes.byteLength !== 0)) return undefined;
    known.set(key, directory);
  }
  return known;
}
function noFileParents(kinds: ReadonlyMap<string, boolean>): boolean {
  for (const path of kinds.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++) {
      if (kinds.get(segments.slice(0, index).join("/")) === false) return false;
    }
  }
  return true;
}
function entries(parts: ReadonlyMap<string, Uint8Array>): readonly JiraEmailTemplateEntry[] | undefined {
  const kinds = pathKinds(parts);
  if (kinds === undefined || !noFileParents(kinds)) return undefined;
  return [...parts].sort(([left], [right]) => compareStrings(left, right)).map(([path, bytes]) => ({ path, sizeBytes: bytes.byteLength, sha256: digest(bytes) }));
}
/** Native ZIPs are fully inspected in memory. No files, URLs, template evaluation or output text. */
export async function inspectJiraEmailTemplateArchive(
  bytes: Uint8Array,
  options: { readonly secrets: readonly string[]; readonly signal?: AbortSignal; readonly now?: () => number },
): Promise<Inspection> {
  const now = options.now ?? Date.now;
  const deadlineAt = now() + TIMEOUT_MS;
  const read = await readBoundedOoxmlPackage(bytes, { maxInputBytes: JIRA_ATTACHMENT_MAX_BYTES,
    maxEntries: TOOL_CATALOG_LIMITS.maxArrayItems, maxInflatedBytes: INFLATED_BYTES, timeoutMs: TIMEOUT_MS,
    now, rejectNonRegularEntries: true, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!read.ok) return { ok: false, reason: archiveFailure(read.reason) };
  const admitted = await admitJiraEmailTemplateParts(bytes, read.parts, options.secrets,
    { now, deadlineAt, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!admitted.ok) {
    switch (admitted.refusal) {
      case "cancelled":
      case "bounds-exceeded":
        return { ok: false, reason: admitted.refusal };
      case "contains-credential":
        return { ok: false, reason: "field-validation", contentRefusal: admitted.refusal,
          detail: { fieldId: "source", validation: "invalid-field", messages: [
            "The email-template archive contains credential material and cannot be exposed or uploaded. Remove the credential and review a new archive.",
          ] } };
      case "unscannable":
        return { ok: false, reason: "field-validation", contentRefusal: admitted.refusal,
          detail: { fieldId: "source", validation: "invalid-field", messages: [
            "Every email-template archive entry must be fully scannable by the existing content policy. Unsupported or unreadable content was refused.",
          ] } };
    }
  }
  const projected = entries(read.parts);
  if (projected === undefined) return malformed();
  if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
  if (now() >= deadlineAt) return { ok: false, reason: "bounds-exceeded" };
  return { ok: true, value: { archiveBytes: bytes.byteLength, archiveSha256: digest(bytes),
    manifestSha256: digest(JSON.stringify(projected)), entries: projected } };
}
function archiveFailure(reason: "oversized" | "budget" | "cancelled" | "malformed"): "bounds-exceeded" | "cancelled" | "malformed-payload" {
  if (reason === "cancelled") return "cancelled";
  return reason === "malformed" ? "malformed-payload" : "bounds-exceeded";
}
