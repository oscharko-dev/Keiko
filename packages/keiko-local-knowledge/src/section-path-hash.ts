import { createHash } from "node:crypto";

const SECTION_PATH_HASH_PREFIX = "sha256:";

export function sectionPathHashFromJson(sectionPathJson: string): string {
  const digest = createHash("sha256").update(sectionPathJson, "utf8").digest("base64url");
  return `${SECTION_PATH_HASH_PREFIX}${digest}`;
}

export function sectionPathHash(sectionPath: readonly string[]): string {
  return sectionPathHashFromJson(JSON.stringify(sectionPath));
}
