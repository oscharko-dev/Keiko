import { createHash } from "node:crypto";

function normalizeMemoryBodyForSuppression(body: string): string {
  return body
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function memoryBodySuppressionHash(body: string): string {
  const normalized = normalizeMemoryBodyForSuppression(body);
  return `sha256:v1:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}
