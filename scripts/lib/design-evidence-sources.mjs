import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sourcePaths from "../../docs/design-system/evidence/1300/source-inputs.json" with { type: "json" };

export function designEvidenceSourceHashes(root) {
  return sourcePaths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex"),
  }));
}
