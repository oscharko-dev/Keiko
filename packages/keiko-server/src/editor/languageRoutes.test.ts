import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import { handleEditorLanguage, handleEditorLanguageCapabilities } from "./languageRoutes.js";

function rawPostContext(raw: string): RouteContext {
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/language"),
  };
}

function postContext(body: unknown): RouteContext {
  return rawPostContext(JSON.stringify(body));
}

function postContextWithResponseClose(body: unknown, writableEnded: boolean): RouteContext {
  const ctx = postContext(body);
  const res = {
    writableEnded,
    on(event: string, listener: () => void) {
      if (event === "close") {
        listener();
      }
      return res;
    },
  } as unknown as ServerResponse;
  return { ...ctx, res };
}

let root: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return { store, redactor: buildRedactor({}) } as unknown as UiHandlerDeps;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-ls-route-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/editor/language/capabilities", () => {
  it("advertises the registered providers", () => {
    const result = handleEditorLanguageCapabilities();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schemaVersion: "1",
      providers: [{ id: "typescript" }],
    });
  });
});

describe("POST /api/editor/language", () => {
  it("returns diagnostics for an overlay with a type error", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x: number = 'no';\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "diagnostics" });
    const body = result.body as { result: { diagnostics: unknown[] } };
    expect(body.result.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns completion items", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "completion",
        root,
        document: {
          path: "src/a.ts",
          languageId: "typescript",
          text: "const value = { alpha: 1 };\nvalue.\n",
        },
        position: { line: 1, character: 6 },
      }),
      deps(),
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: { items: { label: string }[] } };
    expect(body.result.items.map((item) => item.label)).toContain("alpha");
  });

  it("returns formatting edits for a poorly spaced overlay", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "formatting",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
        options: { tabSize: 2, insertSpaces: true },
      }),
      deps(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "formatting" });
    const body = result.body as { result: { edits: { newText: string }[] } };
    expect(body.result.edits.length).toBeGreaterThan(0);
  });

  it("cancels analysis when the response closes before finishing", async () => {
    const result = await handleEditorLanguage(
      postContextWithResponseClose(
        {
          operation: "diagnostics",
          root,
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
        },
        false,
      ),
      deps(),
    );
    expect(result.status).toBe(499);
    expect(result.body).toMatchObject({ error: { code: "CANCELLED" } });
  });

  it("does not cancel analysis for a response close after completion", async () => {
    const result = await handleEditorLanguage(
      postContextWithResponseClose(
        {
          operation: "diagnostics",
          root,
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
        },
        true,
      ),
      deps(),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "diagnostics" });
  });

  it("rejects a malformed request with 400 INVALID_REQUEST", async () => {
    const result = await handleEditorLanguage(postContext({ operation: "rename" }), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a body that is not valid JSON with 400 BAD_REQUEST", async () => {
    const result = await handleEditorLanguage(rawPostContext("{ not json"), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects an unsupported language with 422", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "src/a.py", languageId: "python", text: "x = 1" },
      }),
      deps(),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_LANGUAGE" } });
  });

  it("denies an overlay path that escapes the workspace root", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "../escape.ts", languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("denies an absolute overlay path", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "/etc/passwd", languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("denies an overlay path with a deny-listed segment inside the root", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: ".git/config.ts", languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("rejects an empty root before resolving", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root: "",
        document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});
