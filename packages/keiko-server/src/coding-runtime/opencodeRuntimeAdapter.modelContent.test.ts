import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ScriptedGovernedTools } from "./opencodeFunctionalHarness/_governedTools.js";
import { decodeModelFacingToolContent } from "./productionOpenCodeBackend.functional/modelFacingToolContent.js";

// #3873: in the live Gemma qualification the model read files through the governed read tool, saw
// their quotes as JSON escapes, and copied `\"` into its patches. These tests execute the generated
// V2 plugin itself, so the model-facing text is asserted exactly as OpenCode returns it to the model.

const FILE_TEXT = 'import { test } from "node:test";\nconst root = "C:\\\\temp";\n\tindented();\n';
const DIGEST = "a".repeat(64);

function facadeAnswering(body: Record<string, unknown>): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
}

function governedTools(fetch: typeof globalThis.fetch): ScriptedGovernedTools {
  return new ScriptedGovernedTools({
    env: {
      KEIKO_CODING_MODE: "supervised-coding",
      KEIKO_TOOL_FACADE_URL: "http://127.0.0.1/api/coding-sidecar/tool",
      KEIKO_TOOL_FACADE_CAPABILITY: "model-content-capability",
      KEIKO_CODING_RUN_ID: "run-model-content",
    },
    pluginVersion: "v2",
    sessionId: "ses_modelcontent",
    broadcast: (): void => undefined,
    fetch,
  });
}

async function modelContent(
  name: string,
  args: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<string> {
  return governedTools(facadeAnswering(body)).execute(
    { id: "call_model_content", name, args },
    new AbortController().signal,
  );
}

describe("the model-facing governed tool result", () => {
  it("presents read text verbatim in a numbered block instead of JSON escapes", async () => {
    const read = {
      text: FILE_TEXT,
      byteCount: Buffer.byteLength(FILE_TEXT, "utf8"),
      digest: DIGEST,
      totalLines: 3,
    };

    const content = await modelContent(
      "keiko_workspace_read",
      { relativePath: "src/a.ts" },
      { status: "completed", read },
    );

    expect(content).toBe(
      `${JSON.stringify({ status: "completed", read: { ...read, text: "<text 1>" } })}\n<text 1>\n${FILE_TEXT}</text 1>`,
    );
    expect(content).not.toContain(String.raw`\"node:test\"`);
  });

  it("keeps a missing final line break visible instead of adding one", async () => {
    const text = 'export const name = "ledger";';
    const read = {
      text,
      byteCount: Buffer.byteLength(text, "utf8"),
      digest: DIGEST,
      totalLines: 1,
    };

    const content = await modelContent(
      "keiko_workspace_read",
      { relativePath: "src/name.ts" },
      { status: "completed", read },
    );

    expect(content.endsWith(`<text 1>\n${text}</text 1>`)).toBe(true);
  });

  it("numbers several blocks in document order", async () => {
    const body = {
      status: "failed",
      reasonCode: "INVALID_EDITS",
      message: 'context mismatch at "src/a.ts" line 2',
      detail: "first line\nsecond line",
    };

    const content = await modelContent(
      "keiko_changeset_edit",
      { changeset: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", files: [] } },
      body,
    );

    expect(content.split("\n")[0]).toBe(
      JSON.stringify({ ...body, message: "<text 1>", detail: "<text 2>" }),
    );
    expect(content).toContain(`<text 1>\n${body.message}</text 1>`);
    expect(content).toContain(`<text 2>\n${body.detail}</text 2>`);
  });

  it("round-trips through the real-binary proofs' decoder without loss", async () => {
    const body = {
      status: "completed",
      read: {
        text: `${FILE_TEXT}last line without break`,
        byteCount: 1,
        digest: DIGEST,
        totalLines: 4,
      },
    };

    const content = await modelContent("keiko_workspace_read", { relativePath: "src/a.ts" }, body);

    expect(decodeModelFacingToolContent(content)).toEqual(body);
  });

  it("keeps a result without escaped strings byte-identical to the facade answer", async () => {
    const body = { status: "failed", reasonCode: "OUT_OF_SCOPE" };

    const content = await modelContent(
      "keiko_workspace_read",
      { relativePath: "../outside.ts" },
      body,
    );

    expect(content).toBe(JSON.stringify(body));
  });
});
