import { createHash } from "node:crypto";

// Preserve provider identity without regex backtracking on long slash runs.
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

export function normalizedEndpointFingerprint(baseUrl: string): string {
  return createHash("sha256")
    .update(stripTrailingSlashes(baseUrl.trim()))
    .digest("hex")
    .slice(0, 16);
}
