import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflowPath = join(repositoryRoot, ".github/workflows/keiko-for-quality.yml");
const workflow = readFileSync(workflowPath, "utf8");
const releaseSha = "f6aa08d66c13de0a49a91ea8810600100ca8770d";

function stepSource(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  expect(start, `${name} step`).toBeGreaterThanOrEqual(0);
  const remainder = workflow.slice(start + marker.length);
  const nextStep = remainder.indexOf("\n      - name: ");
  const nextJob = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  const offsets = [nextStep, nextJob].filter((offset) => offset >= 0);
  const nextOffset = offsets.length === 0 ? remainder.length : Math.min(...offsets);
  return workflow.slice(start, start + marker.length + nextOffset);
}

function jobSource(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
  const remainder = workflow.slice(start + marker.length);
  const nextOffset = remainder.search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  const end = nextOffset === -1 ? workflow.length : start + marker.length + nextOffset;
  return workflow.slice(start, end);
}

function runScript(name) {
  const step = stepSource(name);
  const marker = /^( +)run: \|\n/mu.exec(step);
  expect(marker, `${name} run block`).not.toBeNull();
  const scriptIndent = (marker?.[1].length ?? 0) + 2;
  const scriptStart = (marker?.index ?? 0) + (marker?.[0].length ?? 0);
  const lines = step.slice(scriptStart).split("\n");
  const end = lines.findIndex(
    (line) => line.length > 0 && (line.match(/^ */u)?.[0].length ?? 0) < scriptIndent,
  );
  return lines
    .slice(0, end === -1 ? undefined : end)
    .map((line) => line.slice(Math.min(scriptIndent, line.length)))
    .join("\n");
}

function runCurrentHeadGate({ currentHead, failFetch = 0, initialHead }) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-current-head-"));
  const fetchCountPath = join(directory, "fetch-count");
  const countPath = join(directory, "rev-parse-count");
  const outputPath = join(directory, "output");
  const script = runScript("Debounce superseded pull-request heads");
  const harness = `
sleep() { :; }
git() {
  if [ "$1" = "fetch" ]; then
    FETCH_COUNT="$(cat "\${FETCH_COUNT_PATH}" 2>/dev/null || printf '0')"
    FETCH_COUNT="$((FETCH_COUNT + 1))"
    printf '%s\n' "\${FETCH_COUNT}" > "\${FETCH_COUNT_PATH}"
    if [ "\${FETCH_COUNT}" = "\${FAIL_FETCH}" ]; then return 1; fi
    return 0
  fi
  if [ "$1" = "rev-parse" ]; then
    COUNT="$(cat "\${COUNT_PATH}" 2>/dev/null || printf '0')"
    if [ "\${COUNT}" = "0" ]; then printf '%s\\n' "\${INITIAL_HEAD}"; else printf '%s\\n' "\${CURRENT_HEAD}"; fi
    printf '%s\\n' "$((COUNT + 1))" > "\${COUNT_PATH}"
    return 0
  fi
  return 1
}
${script}
`;
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      COUNT_PATH: countPath,
      CURRENT_HEAD: currentHead ?? initialHead,
      EXPECTED_HEAD: "a".repeat(40),
      FAIL_FETCH: String(failFetch),
      FETCH_COUNT_PATH: fetchCountPath,
      GITHUB_OUTPUT: outputPath,
      INITIAL_HEAD: initialHead,
      PR_NUMBER: "3092",
    },
  });
  try {
    const output = result.status === 0 ? readFileSync(outputPath, "utf8") : "";
    return { output, status: result.status, stderr: result.stderr };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runReviewHeadGate(currentHead, { failFetch = false } = {}) {
  const script = runScript("Fetch candidate head as Git objects");
  const harness = `
git() {
  if [ "$1" = "fetch" ]; then [ "\${FAIL_FETCH}" != "true" ]; return; fi
  if [ "$1" = "rev-parse" ]; then printf '%s\\n' "\${CURRENT_HEAD}"; return 0; fi
  return 1
}
${script}
`;
  return spawnSync("bash", ["-euo", "pipefail", "-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      CURRENT_HEAD: currentHead,
      EXPECTED_HEAD: "a".repeat(40),
      FAIL_FETCH: String(failFetch),
      PR_NUMBER: "3092",
    },
  });
}

describe("Keiko for Quality production workflow", () => {
  it("pins both action identities to the signed v0.24.0 release", () => {
    expect(stepSource("Derive store identity")).toMatch(
      new RegExp(`^ {10}ACTION_PIN: "${releaseSha}" # v0\\.24\\.0`, "mu"),
    );
    expect(stepSource("Review")).toMatch(
      new RegExp(`^ {8}uses: oscharko-dev/Keiko-for-Quality@${releaseSha} # v0\\.24\\.0$`, "mu"),
    );
    expect(workflow.match(new RegExp(releaseSha, "gu"))).toHaveLength(2);
  });

  it("waits before secrets or paid work and rechecks the live pull-request head", () => {
    const debounceJobPosition = workflow.indexOf("  debounce:\n");
    const debouncePosition = workflow.indexOf(
      "      - name: Debounce superseded pull-request heads",
    );
    const reviewJobPosition = workflow.indexOf("  review:\n");
    const secretPosition = workflow.indexOf(
      "      - name: Assert store signing key is provisioned",
    );
    const reviewPosition = workflow.indexOf("      - name: Review");

    expect(debounceJobPosition).toBeGreaterThanOrEqual(0);
    expect(debouncePosition).toBeGreaterThan(debounceJobPosition);
    expect(reviewJobPosition).toBeGreaterThan(debouncePosition);
    expect(secretPosition).toBeGreaterThan(debouncePosition);
    expect(reviewPosition).toBeGreaterThan(secretPosition);

    const debounce = jobSource("debounce");
    expect(debounce).toContain("sleep 120");
    expect(debounce).toContain('origin "pull/${PR_NUMBER}/head"');
    expect(debounce).not.toContain("secrets.");
    expect(debounce).not.toContain("environment:");
    expect(debounce).not.toContain("Keiko-for-Quality@");
    expect(runScript("Debounce superseded pull-request heads")).not.toContain("${{");
    expect(runCurrentHeadGate({ initialHead: "a".repeat(40) })).toMatchObject({
      output: "current=true\n",
      status: 0,
    });
    expect(runCurrentHeadGate({ initialHead: "b".repeat(40) })).toMatchObject({
      output: "current=false\n",
      status: 0,
    });
    expect(
      runCurrentHeadGate({ currentHead: "b".repeat(40), initialHead: "a".repeat(40) }),
    ).toMatchObject({ output: "current=false\n", status: 0 });
    expect(runCurrentHeadGate({ failFetch: 1, initialHead: "a".repeat(40) }).status).not.toBe(0);
    expect(runCurrentHeadGate({ failFetch: 2, initialHead: "a".repeat(40) }).status).not.toBe(0);
  });

  it("prevents the secret-bearing review job from starting for a superseded head", () => {
    const reviewJob = jobSource("review");
    expect(reviewJob).toContain("needs: debounce");
    expect(reviewJob).toContain("needs.debounce.outputs.current == 'true'");
    expect(reviewJob).toContain("environment: keiko-for-quality");
    expect(reviewJob).toContain("secrets.KEIKO_QUALITY_MODEL_TOKEN");

    const fetchStep = stepSource("Fetch candidate head as Git objects");
    expect(fetchStep).toContain("EXPECTED_HEAD: ${{ github.event.pull_request.head.sha }}");
    expect(fetchStep).toContain("pull-request head changed after debounce");
    expect(workflow.indexOf("Fetch candidate head as Git objects")).toBeLessThan(
      workflow.indexOf("Assert store signing key is provisioned"),
    );
    expect(runReviewHeadGate("a".repeat(40)).status).toBe(0);
    expect(runReviewHeadGate("b".repeat(40)).status).not.toBe(0);
    expect(runReviewHeadGate("").status).not.toBe(0);
    expect(runReviewHeadGate("not-a-sha").status).not.toBe(0);
    expect(runReviewHeadGate('$(printf "hostile")').status).not.toBe(0);
    expect(runReviewHeadGate("a".repeat(40), { failFetch: true }).status).not.toBe(0);
  });
});
