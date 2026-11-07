import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { workflowJobs } from "./workflow-script-graph.mjs";

// On #3487 (2026-09-14) Core quality died in `npm run lint` with exit 134: V8 "JavaScript heap out
// of memory" at 7.9 GiB and not one finding. The type-aware ESLint program spans the whole monorepo
// and had outgrown the 8 GiB its script allowed, while the CI step declared a different 6 GiB, so
// neither number described what the lane actually needed.
const HEAP_FLAG = /--max-old-space-size=(\d+)/gu;
// On 2026-09-13 the full lint peaked at 8,947,433,472 B resident against the 8192 MiB ceiling; the
// ceiling keeps a quarter of headroom above that measurement.
const MEASURED_LINT_PEAK_MIB = 8533;
// ubuntu-latest runners have 16 GiB; the operating system and npm need room beside ESLint's heap.
const RUNNER_HEAP_LIMIT_MIB = 14336;

function heapCeilings(command) {
  return [...String(command ?? "").matchAll(HEAP_FLAG)].map((match) => Number(match[1]));
}

describe("lint heap ceiling", () => {
  it("gives the repository lint one heap ceiling, in the script and in CI, that fits the runner", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    // #3991 (owner decision 2026-11-07): `lint` runs the policy qualification and then the typed
    // tail, `lint:typed`. Core quality runs only that tail; the hosted policy job runs the rest.
    const script = scripts["lint:typed"];
    const steps = workflowJobs().flatMap(({ file, name, job }) =>
      (job.steps ?? [])
        .filter((step) => step.run === "npm run lint:typed")
        .map((step) => ({ at: `${file}:${name}`, step })),
    );
    const fullLint = workflowJobs().flatMap(({ job }) =>
      (job.steps ?? []).filter((step) => step.run === "npm run lint"),
    );

    expect(steps.map(({ at }) => at)).toStrictEqual(["ci.yml:core-quality"]);
    expect(fullLint).toStrictEqual([]);
    const [scriptCeiling, ...otherScriptCeilings] = heapCeilings(script);
    const stepCeilings = heapCeilings(steps[0]?.step.env?.NODE_OPTIONS);

    expect(scripts.lint).toMatch(/^npm run build:packages && /u);
    expect(scripts.lint).toMatch(/ && npm run lint:typed$/u);
    expect(heapCeilings(scripts.lint)).toStrictEqual([]);
    // #4182 (2026-11-02): one `eslint .` outgrew this ceiling (heap out of memory at 11.9 GiB). The
    // ceiling now applies to each partition of scripts/lint-repository.mjs, never to the whole tree.
    expect(script).toMatch(/^node --max-old-space-size=\d+ scripts\/lint-repository\.mjs && /u);
    expect(script).not.toContain("eslint.js .");
    expect(otherScriptCeilings).toStrictEqual([]);
    expect(stepCeilings).toStrictEqual([scriptCeiling]);
    expect(scriptCeiling).toBeLessThanOrEqual(RUNNER_HEAP_LIMIT_MIB);
    expect(scriptCeiling).toBeGreaterThan(MEASURED_LINT_PEAK_MIB * 1.25);
  });
});
