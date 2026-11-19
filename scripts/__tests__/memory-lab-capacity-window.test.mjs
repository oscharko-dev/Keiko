import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qualifyCapacity } from "../testing/memory-lab/capacity-window.mjs";

const MODEL = "qwen3-embedding-8b";
const LOCAL = "http://127.0.0.1:1";
let subject;
let head;
let gatewayPath;

function writeGateway(baseUrl) {
  writeFileSync(
    gatewayPath,
    JSON.stringify({
      providers: [
        {
          modelId: MODEL,
          apiKey: randomUUID(),
          baseUrl,
          capability: {
            kind: "embedding",
            contextWindow: 8192,
            maxInputTokens: 8192,
            maxOutputTokens: 0,
            toolCalling: false,
            structuredOutput: false,
            streaming: false,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "low",
            latencyClass: "fast",
            knownLimitations: [],
          },
        },
      ],
    }),
  );
}

function syntheticEmbedding(request) {
  const vector = new Float32Array(4096);
  vector[request.input.includes("Kilimanjaro") ? 1 : 0] = 1;
  return Promise.resolve({ ok: true, value: { modelId: MODEL, vector } });
}

beforeEach(() => {
  subject = mkdtempSync(join(tmpdir(), "keiko-capacity-subject-"));
  const git = (...args) => execFileSync("git", args, { cwd: subject, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Memory QA",
    "-c",
    "user.email=qa@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "synthetic test subject",
  );
  head = git("rev-parse", "HEAD");
  copyFileSync(resolve("tsconfig.base.json"), join(subject, "tsconfig.base.json"));
  symlinkSync(resolve("packages"), join(subject, "packages"), "junction");
  symlinkSync(resolve("node_modules"), join(subject, "node_modules"), "junction");
  gatewayPath = join(subject, "gateway.json");
  writeGateway(LOCAL);
});
afterEach(() => rmSync(subject, { recursive: true, force: true }));

describe("the capacity qualification", () => {
  it("scores the sparse control, empty predictions and every dense probe without network access", async () => {
    const result = await qualifyCapacity({
      subject,
      head,
      gatewayPath,
      testAdapter: syntheticEmbedding,
    });
    expect(result.measurement).toBe("injected-smoke");
    expect(result.dimensions).toEqual([4096]);
    expect(result.rows).toHaveLength(27);
    const keys = result.rows.map((row) => [row.condition, row.repetition, row.probe].join("/"));
    expect(new Set(keys).size).toBe(27);
    expect(result.rows.filter((row) => row.condition === "sparse")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ probe: "lexical", matched: 1 }),
        expect.objectContaining({ probe: "paraphrase", matched: 1 }),
        expect.objectContaining({ probe: "far", matched: 0 }),
      ]),
    );
    for (const row of result.rows) {
      expect(row.unexpected).toBe(0);
      expect(row.expected).toBe(row.probe === "far" ? 0 : 1);
      expect(row.matchedIdDigests).toHaveLength(row.matched);
    }
    expect(JSON.stringify(result)).not.toContain("depot code");
  });

  it("refuses a different revision or a nonlocal provider before invoking the adapter", async () => {
    const testAdapter = vi.fn(syntheticEmbedding);
    await expect(
      qualifyCapacity({ subject, head: "wrong", gatewayPath, testAdapter }),
    ).rejects.toThrow();
    writeGateway("https://example.invalid");
    await expect(qualifyCapacity({ subject, head, gatewayPath, testAdapter })).rejects.toThrow(
      /loopback/i,
    );
    expect(testAdapter).not.toHaveBeenCalled();
  });
});
