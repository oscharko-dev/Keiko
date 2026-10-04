import { createHash } from "node:crypto";
export {
  SupportReportError,
  reportObject,
  reportKeys,
  reportCount,
  canonicalSupportJson,
  parseCanonicalSupportJson,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

export function supportReportDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
