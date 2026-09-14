import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { workflowJobs } from "./workflow-script-graph.mjs";

// On #3487 (2026-09-14) Core quality died in `npm run lint` with exit 134: V8 "JavaScript heap out
// of memory" at 7.9 GiB and not one finding. The type-aware ESLint program spans the whole monorepo
// and had outgrown the 8 GiB its script allowed, while the CI step declared a different 6 GiB, so
// neither number described what the lane actually needed.
const HEAP_FLAG = /--max-old-space-size=(\d+)/gu;
// ubuntu-latest runners have 16 GiB; the operating system and npm need room beside ESLint's heap.
const RUNNER_HEAP_LIMIT_MIB = 14336;

function heapCeilings(command) {
  return [...String(command ?? "").matchAll(HEAP_FLAG)].map((match) => Number(match[1]));
}

describe("lint heap ceiling", () => {
  it("gives the repository lint one heap ceiling, in the script and in CI, that fits the runner", () => {
    const script = JSON.parse(readFileSync("package.json", "utf8")).scripts.lint;
    const steps = workflowJobs().flatMap(({ file, name, job }) =>
      (job.steps ?? [])
        .filter((step) => step.run === "npm run lint")
        .map((step) => ({ at: `${file}:${name}`, step })),
    );

    expect(steps.map(({ at }) => at)).toStrictEqual(["ci.yml:core-quality"]);
    const [scriptCeiling, ...otherScriptCeilings] = heapCeilings(script);
    const stepCeilings = heapCeilings(steps[0]?.step.env?.NODE_OPTIONS);

    expect(otherScriptCeilings).toStrictEqual([]);
    expect(stepCeilings).toStrictEqual([scriptCeiling]);
    expect(scriptCeiling).toBeLessThanOrEqual(RUNNER_HEAP_LIMIT_MIB);
    expect(scriptCeiling).toBeGreaterThan(8192);
  });
});
