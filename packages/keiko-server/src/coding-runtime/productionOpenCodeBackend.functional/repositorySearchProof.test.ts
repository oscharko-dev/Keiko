import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { scriptedResponse, type ScriptState } from "./_support.js";
import {
  H1_PROOF_SEARCH_CALL_ID,
  repositorySearchReadHandoff,
  type RepositorySearchConsumptionProof,
} from "./repositorySearchProof.js";

const ROOT = "/private/var/work/ws_1";

// The pinned 2.1.4 `grep` result and environment block, as observed against the staged executable.
function searchResult(...hits: readonly string[]): string {
  return [`Found ${String(hits.length)} matches`, ...hits].join("\n");
}

const USEFUL = `${ROOT}/src/actual-result.ts:\n  Line 7: the useful marker`;

function transcript(content: string, callId = H1_PROOF_SEARCH_CALL_ID): string {
  return JSON.stringify([
    { role: "system", content: `<env>\n  Working directory: ${ROOT}\n</env>` },
    { role: "tool", toolCallId: callId, content },
  ]);
}

describe("real-binary H1 model response boundary", () => {
  it("requests a native literal search before choosing a file to read", () => {
    const script = {
      mode: "productive-search",
      calls: 0,
      old: "export const marker = true;\n",
      next: "export const marker = false;\n",
    } as ScriptState;
    expect(scriptedResponse(script).toolCalls[0]).toMatchObject({
      id: H1_PROOF_SEARCH_CALL_ID,
      name: "grep",
      arguments: { pattern: script.old.trim(), literal: true },
    });
  });

  it("derives the next bounded read from the correlated result rather than a fixture path", () => {
    const evidence: RepositorySearchConsumptionProof[] = [];
    // The handoff is workspace-relative in the host's own separators, as the next read expects.
    expect(
      repositorySearchReadHandoff(
        transcript(searchResult(`${USEFUL}\n`)),
        "useful marker",
        (proof) => {
          evidence.push(proof);
        },
      ),
    ).toEqual({ path: join("src", "actual-result.ts"), offset: 7, limit: 1 });
    expect(evidence).toEqual([
      expect.objectContaining({
        hitCount: 1,
        startLine: 7,
        endLine: 7,
        readTargetDerivedFromResult: true,
      }),
    ]);
    expect(evidence.at(0)?.pathDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.at(0)?.snippetDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("actual-result");
    expect(JSON.stringify(evidence)).not.toContain("useful marker");
  });

  it("reads the first of several matches and counts all of them", () => {
    const second = `${ROOT}/src/other.ts:\n  Line 3: the useful marker again`;
    const evidence: RepositorySearchConsumptionProof[] = [];
    repositorySearchReadHandoff(
      transcript(searchResult(USEFUL, second)),
      "useful marker",
      (proof) => evidence.push(proof),
    );
    expect(evidence).toEqual([expect.objectContaining({ hitCount: 2, startLine: 7 })]);
  });

  it.each([
    [
      "the runtime's failure object",
      '{"error":{"type":"unknown","message":"ripgrep execution failed"},"content":[]}',
    ],
    [
      "a result without the match header",
      `${ROOT}/src/actual-result.ts:\n  Line 7: the useful marker`,
    ],
    ["an empty result", "Found 0 matches"],
    ["a count that disagrees with the listed matches", `Found 2 matches\n${USEFUL}`],
    [
      "a result whose line does not carry the needle",
      searchResult(`${ROOT}/src/a.ts:\n  Line 7: unrelated`),
    ],
    [
      "a result outside the working directory",
      searchResult(`/elsewhere/a.ts:\n  Line 7: the useful marker`),
    ],
    [
      "a result without raw line coordinates",
      searchResult(`${ROOT}/src/a.ts:\n  Line 0: the useful marker`),
    ],
  ])("refuses %s instead of returning a canned read", (_name, content) => {
    expect(() =>
      repositorySearchReadHandoff(transcript(content), "useful marker", undefined),
    ).toThrow(TypeError);
  });

  it("rejects result text without its original tool-call identity", () => {
    const wrong = transcript(searchResult(USEFUL), "unrelated-call");
    expect(() => repositorySearchReadHandoff(wrong, "useful marker", undefined)).toThrow(TypeError);
  });
});
