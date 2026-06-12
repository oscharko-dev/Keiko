import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentCli } from "./run.js";
import type { CliIo } from "./runner.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

// This file deliberately does NOT mock node:fs (unlike tests/harness/cli-run.test.ts) so the real
// node evidence store runs end-to-end — proving the CLI threads KEIKO_EVIDENCE_DIR and --evidence-dir
// through to the resolved write location (C4). Every write targets an os-mkdtemp dir cleaned up in
// afterEach; nothing lands in the repository tree.

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

function response(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "--- a/file\n+++ b/file\n+// dry-run proposed change\n",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "test-run",
      promptTokens: 0,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function testModel(): ModelPort {
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> =>
      Promise.resolve(response(request.modelId)),
  };
}

describe("keiko run — evidence dir resolution end-to-end (C4)", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-cli-evdir-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes to $KEIKO_EVIDENCE_DIR when --evidence-dir is absent", async () => {
    const c = capture();
    const dir = freshDir();
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--model", "test-model"],
      c.io,
      {
        KEIKO_EVIDENCE_DIR: dir,
      },
      { model: testModel() },
    );
    expect(code).toBe(0);
    expect(readdirSync(dir).some((n) => n.endsWith(".json"))).toBe(true);
  });

  it("lets --evidence-dir override $KEIKO_EVIDENCE_DIR", async () => {
    const c = capture();
    const envDir = freshDir();
    const flagDir = freshDir();
    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--evidence-dir", flagDir, "--model", "test-model"],
      c.io,
      { KEIKO_EVIDENCE_DIR: envDir },
      { model: testModel() },
    );
    expect(code).toBe(0);
    expect(readdirSync(flagDir).some((n) => n.endsWith(".json"))).toBe(true);
    expect(readdirSync(envDir)).toHaveLength(0);
  });
});
