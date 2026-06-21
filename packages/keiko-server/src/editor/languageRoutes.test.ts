import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorLanguage,
  handleEditorLanguageCapabilities,
  type EditorLanguageRouteOptions,
} from "./languageRoutes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProvider(body: unknown, id: string, availability: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.providers)) return false;
  return body.providers.some(
    (provider) => isRecord(provider) && provider.id === id && provider.availability === availability,
  );
}

function schemaVersion(body: unknown): unknown {
  return isRecord(body) ? body.schemaVersion : undefined;
}

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

function deps(redactor: UiHandlerDeps["redactor"] = buildRedactor({})): UiHandlerDeps {
  return { store, redactor } as unknown as UiHandlerDeps;
}

function redactEveryString(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/")) {
      return value;
    }
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map(redactEveryString);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactEveryString(entry)]),
    );
  }
  return value;
}

const stableLanguageOptions: EditorLanguageRouteOptions = { now: () => 0 };

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
    expect(schemaVersion(result.body)).toBe("1");
    expect(hasProvider(result.body, "typescript", "available")).toBe(true);
    expect(hasProvider(result.body, "python-lsp", "unavailable")).toBe(true);
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
      stableLanguageOptions,
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
      stableLanguageOptions,
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
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "formatting" });
    const body = result.body as { result: { edits: { newText: string }[] } };
    expect(body.result.edits.length).toBeGreaterThan(0);
  });

  it("does not redact formatting edits that are applied back to the buffer", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "formatting",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
        options: { tabSize: 2, insertSpaces: true },
      }),
      deps(redactEveryString),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    const body = result.body as { operation: string; result: { edits: { newText: string }[] } };
    expect(body.operation).toBe("formatting");
    expect(body.result.edits.length).toBeGreaterThan(0);
    expect(body.result.edits.map((edit) => edit.newText)).not.toContain("[REDACTED]");
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
      stableLanguageOptions,
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
      stableLanguageOptions,
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
