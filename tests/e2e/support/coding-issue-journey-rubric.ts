import { createHash } from "node:crypto";

function sectionCriteria(lines: readonly string[], heading: string): readonly string[] {
  const starts = lines.flatMap((line, index) =>
    line === heading || line.startsWith(`${heading} — `) ? [index + 1] : [],
  );
  if (starts.length !== 1)
    throw new TypeError("frozen rubric criterion section is missing or repeated");
  const criteria: string[] = [];
  for (const line of lines.slice(starts[0])) {
    if (/^#{1,3} /u.test(line)) break;
    if (!line.startsWith("- ")) continue;
    const match = /^- `([a-z][a-z0-9-]{1,79})`: \S/u.exec(line);
    if (match?.[1] === undefined) throw new TypeError("frozen rubric criterion id is invalid");
    criteria.push(match[1]);
  }
  if (criteria.length === 0) throw new TypeError("frozen rubric criterion section is empty");
  return criteria;
}

/** The frozen rubric owns the inventory; the reviewer only supplies an outcome for every item. */
export function requiredIndependentReviewCriteria(
  bytes: Uint8Array,
  issueNumber: number,
  rubricDigest: string,
): readonly string[] {
  if (createHash("sha256").update(bytes).digest("hex") !== rubricDigest) {
    throw new TypeError("independent review frozen rubric digest does not match");
  }
  const lines = Buffer.from(bytes).toString("utf8").split(/\r?\n/u);
  const criteria = [
    ...sectionCriteria(lines, "## Common independent review criteria"),
    ...sectionCriteria(lines, `### Issue #${String(issueNumber)}`),
  ];
  if (criteria.length > 32 || new Set(criteria).size !== criteria.length) {
    throw new TypeError("frozen rubric criterion inventory is duplicate or oversized");
  }
  return criteria;
}
