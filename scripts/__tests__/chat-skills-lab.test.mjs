import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  requestObservation,
  responseObservation,
  workingDiffDigest,
  digest,
} from "../testing/chat-skills-lab/runtime.mjs";
import {
  extractGeneratedTest,
  containerArguments,
} from "../testing/chat-skills-lab/verify-tests.mjs";
import { SUMMARY_SYSTEM_PROMPT } from "../../packages/keiko-server/dist/chat-compaction-model-summary.js";
import { PROMPT_COMPACTION_SYSTEM } from "../../packages/keiko-server/dist/chat-prompt-compaction.js";

const scope = {
  question: "Review the boundary",
  skillBody: "# Synthetic method\nCheck the boundary.",
  source: "Synthetic source",
  compactionPrompts: new Set([SUMMARY_SYSTEM_PROMPT, PROMPT_COMPACTION_SYSTEM]),
};
describe("private Chat skill qualification observations", () => {
  it("observes each requested source witness independently without retaining its text", () => {
    const markers = ["Synthetic API One", "Synthetic API Two"];
    const observed = requestObservation(
      { messages: [{ role: "user", content: markers[0] }] },
      4,
      "wire",
      { ...scope, sourceWitnesses: markers },
    );
    expect(observed.sourceWitnesses).toEqual([
      { digest: digest(markers[0]), present: true },
      { digest: digest(markers[1]), present: false },
    ]);
    for (const marker of markers) expect(JSON.stringify(observed)).not.toContain(marker);
  });
  it("observes a bounded complete toolchain-and-requirement inventory without retaining text", () => {
    const markers = Array.from(
      { length: 32 },
      (_unused, index) => `Synthetic source span ${index}.`,
    );
    const observed = requestObservation(
      { messages: [{ role: "user", content: markers.join("\n") }] },
      4,
      "wire",
      { ...scope, sourceWitnesses: markers },
    );
    expect(observed.sourceWitnesses).toHaveLength(32);
    expect(observed.sourceWitnesses.every((witness) => witness.present)).toBe(true);
    for (const marker of markers) expect(JSON.stringify(observed)).not.toContain(marker);
  });
  it.each([[""], [0], ["x".repeat(4097)], Array(33).fill("marker")])(
    "rejects an invalid or oversized source-witness list",
    (...sourceWitnesses) => {
      expect(() =>
        requestObservation({ messages: [] }, 4, "wire", { ...scope, sourceWitnesses }),
      ).toThrow("source-witness-list-invalid");
    },
  );
  it("rejects missing source-witness slots instead of emitting absent observations", () => {
    expect(() =>
      requestObservation({ messages: [] }, 4, "wire", { ...scope, sourceWitnesses: Array(1) }),
    ).toThrow("source-witness-list-invalid");
  });
  it("hashes a large release diff completely without retaining it in an error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-lab-provenance-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
      git("init");
      git(
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "Synthetic base",
      );
      writeFileSync(join(cwd, "release.txt"), "Synthetic release row.\n".repeat(100_000));
      git("add", "release.txt");
      const expected = digest(execFileSync("git", ["diff", "HEAD"], { cwd, maxBuffer: 8_000_000 }));
      await expect(workingDiffDigest(cwd)).resolves.toBe(expected);
      await expect(workingDiffDigest(join(cwd, "missing"))).rejects.toThrow(
        "source-diff-unavailable",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("distinguishes real synthesis from summaries containing the same question without losing physical attempts", () => {
    const body = "Synthetic request bytes";
    for (const system of scope.compactionPrompts) {
      const result = requestObservation(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: scope.question },
          ],
        },
        body.length,
        body,
        scope,
      );
      expect(result).toMatchObject({
        operation: "compaction",
        caseRequest: false,
        skillOccurrences: 0,
      });
    }
    const result = requestObservation(
      {
        messages: [
          { role: "system", content: scope.skillBody },
          { role: "user", content: scope.question },
        ],
      },
      body.length,
      body,
      scope,
    );
    expect(result).toMatchObject({
      operation: "conversation",
      caseRequest: true,
      skillOccurrences: 1,
    });
  });
  it("retains final SSE usage and refuses malformed provider data", () => {
    const raw =
      'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":11}}\n\ndata: [DONE]\n';
    expect(responseObservation(raw)).toMatchObject({
      finishReason: "stop",
      usage: { prompt_tokens: 7, completion_tokens: 11 },
      responseKind: "complete",
    });
    expect(() => responseObservation("not-json")).toThrow();
  });
  it("refuses ambiguous generated files and retains the offline, read-only execution boundary", () => {
    const code = "```tsx\nexport const value = 1;\n```";
    expect(extractGeneratedTest(code)).toBe("export const value = 1;\n");
    expect(() => extractGeneratedTest(code + code)).toThrow("one-complete-test-file-required");
    const args = containerArguments("/synthetic/input", "/synthetic/deps", "synthetic-container");
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=1g",
        "--cpus=2",
      ]),
    );
    expect(args).toContain(
      "type=bind,source=/synthetic/deps,target=/opt/qualification/node_modules,readonly",
    );
    expect(args).toContain("type=bind,source=/synthetic/input,target=/input,readonly");
  });
});
