import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeReviewFindingFingerprint } from "./review-finding-fingerprint.js";

const REPORT = { file: "src/settle.ts", category: "correctness" } as const;
const EXCERPT = "if (verdict === undefined) {\n  return complete;\n}";

describe("computeReviewFindingFingerprint", () => {
  it("is a 64-hex SHA-256 digest pinned across platforms", () => {
    // Pinned value: a change here changes every stored finding identity and must be deliberate.
    expect(computeReviewFindingFingerprint(REPORT, EXCERPT)).toBe(
      "8d3aa7d668d902594fb76bc046fa5cf8398fbac1c9002fbfad97c4722efd294d",
    );
  });

  it("is identical in a separate process", () => {
    const moduleUrl = new URL("../dist/review-finding-fingerprint.js", import.meta.url);
    const script = `import(${JSON.stringify(moduleUrl.href)}).then((m) => process.stdout.write(m.computeReviewFindingFingerprint(${JSON.stringify(REPORT)}, ${JSON.stringify(EXCERPT)})))`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(computeReviewFindingFingerprint(REPORT, EXCERPT));
  });

  it("is unchanged when the same defect moves lines, is re-indented or the title is reworded", () => {
    const original = computeReviewFindingFingerprint(REPORT, EXCERPT);
    const reindented = "\n\t\tif (verdict === undefined) {\r\n\t\t\treturn complete;\r\n\t\t}\n";
    expect(computeReviewFindingFingerprint(REPORT, reindented)).toBe(original);
    // Line numbers and prose are not inputs at all: a report at other lines with another title
    // carries the same file and category.
    const moved = { ...REPORT, startLine: 400, endLine: 402, title: "Completely different words" };
    expect(computeReviewFindingFingerprint(moved, EXCERPT)).toBe(original);
  });

  it("changes when the defect excerpt, the category or the file changes", () => {
    const original = computeReviewFindingFingerprint(REPORT, EXCERPT);
    expect(computeReviewFindingFingerprint(REPORT, EXCERPT.replace("===", "!=="))).not.toBe(
      original,
    );
    expect(
      computeReviewFindingFingerprint({ ...REPORT, category: "reliability" }, EXCERPT),
    ).not.toBe(original);
    expect(
      computeReviewFindingFingerprint({ ...REPORT, file: "src/settle2.ts" }, EXCERPT),
    ).not.toBe(original);
  });
});
