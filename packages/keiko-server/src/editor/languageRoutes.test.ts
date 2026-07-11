import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "@oscharko-dev/keiko-contracts";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { RouteResult } from "../routes.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorLanguage,
  handleEditorLanguageCapabilities,
  handleEditorLanguageCapabilitiesForRoute,
  handleEditorLanguageSemanticTokens,
  type EditorLanguageRouteOptions,
} from "./languageRoutes.js";
import { createManagedLspActivationStore } from "./lsp/managedLspActivationStore.js";
import { createManagedLspControlService } from "./lsp/managedLspControl.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProvider(body: unknown, id: string, availability: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.providers)) return false;
  return body.providers.some(
    (provider) =>
      isRecord(provider) && provider.id === id && provider.availability === availability,
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

function getContext(path: string): RouteContext {
  return {
    req: Readable.from([]) as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
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

function deps(
  redactor: UiHandlerDeps["redactor"] = buildRedactor({}),
  env: UiHandlerDeps["env"] = {},
): UiHandlerDeps {
  return { store, redactor, env } as unknown as UiHandlerDeps;
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

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  });
}

function positionOf(text: string, needle: string, offset = 0): { line: number; character: number } {
  const index = text.indexOf(needle, offset);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function rangeOf(
  text: string,
  needle: string,
): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  const start = positionOf(text, needle);
  return { start, end: { line: start.line, character: start.character + needle.length } };
}

async function writeProject(files: Readonly<Record<string, string>>): Promise<void> {
  await writeFile(join(root, "tsconfig.json"), tsconfig(), "utf8");
  for (const [relativePath, text] of Object.entries(files)) {
    await writeFile(join(root, relativePath), text, "utf8");
  }
}

function postLanguage(
  body: unknown,
  redactor: UiHandlerDeps["redactor"] = buildRedactor({}),
  options: EditorLanguageRouteOptions = stableLanguageOptions,
): Promise<RouteResult> {
  return handleEditorLanguage(postContext(body), deps(redactor), options);
}

function routeRequestFor(operation: string, decl: string, main: string): unknown {
  if (operation === "definition" || operation === "references" || operation === "renamePrepare") {
    const text = operation === "definition" ? main : decl;
    return {
      operation,
      root,
      document: {
        path: operation === "definition" ? "src/main.ts" : "src/decl.ts",
        languageId: "typescript",
        text,
      },
      position: positionOf(
        text,
        "sharedValue",
        operation === "definition" ? text.indexOf("use") : 0,
      ),
    };
  }
  if (operation === "renameApply") {
    return {
      operation,
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
      newName: "renamedValue",
    };
  }
  if (operation === "codeActions") {
    return {
      operation,
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      range: rangeOf(main, "sharedValue"),
      diagnostics: [],
    };
  }
  return {
    operation,
    root,
    document: { path: "src/main.ts", languageId: "typescript", text: main },
    position: positionOf(main, "sharedValue"),
  };
}

function expectUnknownArray(value: unknown, label: string): readonly unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value as readonly unknown[];
}

function expectNavigationShape(result: Record<string, unknown>): void {
  const locations = expectUnknownArray(result.locations, "locations");
  expect(locations).not.toHaveLength(0);
  if (!isRecord(locations[0])) throw new Error("location must be an object");
  expect(typeof locations[0].path).toBe("string");
}

function expectRenameApplyShape(result: Record<string, unknown>): void {
  const files = expectUnknownArray(result.files, "files");
  if (!isRecord(files[0])) throw new Error("rename file must be an object");
  expect(typeof files[0].path).toBe("string");
  expect(Array.isArray(files[0].edits)).toBe(true);
  expect(typeof files[0].expectedContentHash).toBe("string");
}

function expectRangeShape(value: unknown): void {
  if (!isRecord(value)) throw new Error("range must be an object");
  expect(isRecord(value.start)).toBe(true);
  expect(isRecord(value.end)).toBe(true);
}

function expectLanguageResultShape(body: unknown, operation: string): void {
  expect(body).toMatchObject({ operation });
  if (!isRecord(body) || !isRecord(body.result)) throw new Error("missing result body");
  const result = body.result;
  if (operation === "definition" || operation === "references") {
    expectNavigationShape(result);
    return;
  }
  if (operation === "renamePrepare") {
    expectRangeShape(result.range);
    expect(typeof result.placeholder).toBe("string");
    return;
  }
  if (operation === "renameApply") {
    expectRenameApplyShape(result);
    return;
  }
  if (operation === "signatureHelp") {
    expectUnknownArray(result.signatures, "signatures");
    expect(result.returnedCount).toEqual(expect.any(Number));
  }
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
    expect(schemaVersion(result.body)).toBe("1");
    expect(hasProvider(result.body, "typescript", "available")).toBe(true);
    expect(hasProvider(result.body, "python-lsp", "unavailable")).toBe(true);
  });

  it("overrides host provider descriptors from workspace-aware executable detection", async () => {
    const bin = await mkdtemp(join(tmpdir(), "keiko-route-lsp-bin-"));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);

      const result = await handleEditorLanguageCapabilitiesForRoute(
        getContext(`/api/editor/language/capabilities?root=${encodeURIComponent(root)}`),
        deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
        { hostLanguageCommandRules: [{ executable: "pyright-langserver" }] },
      );

      expect(result.status).toBe(200);
      expect(hasProvider(result.body, "python-lsp", "available")).toBe(true);
      expect(hasProvider(result.body, "go-lsp", "unavailable")).toBe(true);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("reports policy-blocked host providers with a content-free unavailable reason", async () => {
    const result = await handleEditorLanguageCapabilitiesForRoute(
      getContext(`/api/editor/language/capabilities?root=${encodeURIComponent(root)}`),
      deps(buildRedactor({}), { KEIKO_EDITOR_LSP_PYTHON: "1" }),
      { hostLanguageCommandRules: [] },
    );

    expect(result.status).toBe(200);
    const body = result.body as { providers: { id: string; unavailableReason?: string }[] };
    const python = body.providers.find((provider) => provider.id === "python-lsp");
    expect(python?.unavailableReason).toBe(
      "Required host language tool is blocked by host execution policy.",
    );
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("uses canonical workspace activation instead of allowing a legacy env flag to bypass default-off", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-control-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-control-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const context = getContext(
        `/api/editor/language/capabilities?root=${encodeURIComponent(root)}`,
      );
      const controlledDeps = {
        ...deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
        managedLspControl,
      };

      const defaultOff = await handleEditorLanguageCapabilitiesForRoute(context, controlledDeps, {
        hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
      });
      expect(hasProvider(defaultOff.body, "python-lsp", "unavailable")).toBe(true);

      await managedLspControl.mutate({
        action: "activate",
        actorClass: "localHuman",
        expectedRevision: 0,
        idempotencyKey: "activate-python-capabilities",
        language: "python",
        root,
      });
      const activated = await handleEditorLanguageCapabilitiesForRoute(
        context,
        { ...controlledDeps, env: { PATH: bin } },
        { hostLanguageCommandRules: [{ executable: "pyright-langserver" }] },
      );
      expect(hasProvider(activated.body, "python-lsp", "available")).toBe(true);
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/editor/language", () => {
  it("degrades semantic-token requests to syntax highlighting when Rust is not activated", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/lib.rs"), "fn main() {}\n", "utf8");
    const result = await handleEditorLanguageSemanticTokens(
      postContext({
        schemaVersion: "1",
        root,
        document: {
          path: "src/lib.rs",
          languageId: "rust",
          text: "fn main() {}\n",
          version: 2,
        },
      }),
      deps(),
    );

    expect(result).toEqual({ status: 200, body: { schemaVersion: "1", supported: false } });
  });

  it("rejects malformed semantic-token request fields before provider dispatch", async () => {
    const result = await handleEditorLanguageSemanticTokens(
      postContext({
        schemaVersion: "1",
        root,
        document: { path: "../escape.rs", languageId: "rust", text: "x", version: 1 },
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("does not spawn a legacy-env-enabled provider while canonical workspace activation is absent", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-operation-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-operation-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      let spawned = false;
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const result = await handleEditorLanguage(
        postContext({
          operation: "diagnostics",
          root,
          document: { path: "src/a.py", languageId: "python", text: "value = 1\n" },
        }),
        {
          ...deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
          managedLspControl,
        },
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          hostLanguageSpawn: () => {
            spawned = true;
            throw new Error("spawn must remain unreachable");
          },
        },
      );

      expect(result.status).toBe(422);
      expect(spawned).toBe(false);
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

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

  it("serves definition, references, rename, code actions, and signature help for TypeScript", async () => {
    const decl = "export const sharedValue = 1;\n";
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    const overloads =
      "export function choose(value: string): string;\n" +
      "export function choose(value: number): number;\n" +
      "export function choose(value: string | number): string | number { return value; }\n" +
      "export const result = choose(1);\n";
    await writeProject({ "src/decl.ts": decl, "src/main.ts": main, "src/overloads.ts": overloads });

    const definition = await postLanguage({
      operation: "definition",
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      position: positionOf(main, "sharedValue", main.indexOf("use")),
    });
    const references = await postLanguage({
      operation: "references",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
    });
    const renamePrepare = await postLanguage({
      operation: "renamePrepare",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
    });
    const renameApply = await postLanguage({
      operation: "renameApply",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
      newName: "renamedValue",
    });
    const signatureHelp = await postLanguage({
      operation: "signatureHelp",
      root,
      document: { path: "src/overloads.ts", languageId: "typescript", text: overloads },
      position: positionOf(overloads, "1", overloads.indexOf("choose(1")),
    });

    expect(definition).toMatchObject({ status: 200, body: { operation: "definition" } });
    expect(references).toMatchObject({ status: 200, body: { operation: "references" } });
    expect(renamePrepare).toMatchObject({ status: 200, body: { operation: "renamePrepare" } });
    expect(renameApply).toMatchObject({ status: 200, body: { operation: "renameApply" } });
    expect(signatureHelp).toMatchObject({ status: 200, body: { operation: "signatureHelp" } });
    expectLanguageResultShape(definition.body, "definition");
    expectLanguageResultShape(references.body, "references");
    expectLanguageResultShape(renamePrepare.body, "renamePrepare");
    expectLanguageResultShape(renameApply.body, "renameApply");
    expectLanguageResultShape(signatureHelp.body, "signatureHelp");
  });

  it("serves code actions for a TypeScript diagnostic", async () => {
    const main = "export const result = helperValue;\n";
    await writeProject({
      "src/helper.ts": "export const helperValue = 1;\n",
      "src/main.ts": main,
    });

    const result = await postLanguage({
      operation: "codeActions",
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      range: rangeOf(main, "helperValue"),
      diagnostics: [
        {
          range: rangeOf(main, "helperValue"),
          severity: "error",
          message: "Cannot find name 'helperValue'.",
          source: "typescript",
          code: "2304",
        },
      ],
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "codeActions" });
    const body = result.body as { result: { actions: { edits: unknown[] | null }[] } };
    expect(body.result.actions.some((action) => (action.edits?.length ?? 0) > 0)).toBe(true);
  });

  it("redacts code-action display labels without mutating edit text", async () => {
    const main = "export const result = helperValue;\n";
    await writeProject({
      "src/helper.ts": "export const helperValue = 1;\n",
      "src/main.ts": main,
    });

    const result = await postLanguage(
      {
        operation: "codeActions",
        root,
        document: { path: "src/main.ts", languageId: "typescript", text: main },
        range: rangeOf(main, "helperValue"),
        diagnostics: [
          {
            range: rangeOf(main, "helperValue"),
            severity: "error",
            message: "Cannot find name 'helperValue'.",
            source: "typescript",
            code: "2304",
          },
        ],
      },
      redactEveryString,
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      operation: string;
      result: { actions: { title: string; edits: { newText: string }[] | null }[] };
    };
    const action = body.result.actions.find((entry) => (entry.edits?.length ?? 0) > 0);
    expect(body.operation).toBe("codeActions");
    expect(action?.title).toBe("[REDACTED]");
    expect(action?.edits?.map((edit) => edit.newText)).not.toContain("[REDACTED]");
  });

  it("fails closed when TypeScript project discovery exceeds workspace caps", async () => {
    const main = "export const value = 1;\n";
    const files: Record<string, string> = { "src/main.ts": main };
    for (let index = 0; index < 6; index += 1) {
      files[`src/many-${String(index)}.ts`] = "export const value = 1;\n";
    }
    await writeProject(files);

    const result = await postLanguage(
      {
        operation: "diagnostics",
        root,
        document: { path: "src/main.ts", languageId: "typescript", text: main },
      },
      buildRedactor({}),
      {
        ...stableLanguageOptions,
        limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxWorkspaceReadFiles: 2 },
      },
    );

    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ error: { code: "DOCUMENT_TOO_LARGE" } });
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("rejects unadvertised language and operation pairs without echoing content", async () => {
    const result = await postLanguage({
      operation: "renamePrepare",
      root,
      document: { path: "src/a.json", languageId: "json", text: '{"secret":"value"}\n' },
      position: { line: 0, character: 2 },
    });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_OPERATION" } });
    expect(JSON.stringify(result.body)).not.toContain("secret");
  });

  it.each([
    ["definition", true],
    ["references", true],
    ["renamePrepare", true],
    ["renameApply", false],
    ["codeActions", false],
    ["signatureHelp", true],
  ] as const)("routes redaction for %s", async (operation, shouldRedact) => {
    const decl = "export const sharedValue = 1;\n";
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    await writeProject({ "src/decl.ts": decl, "src/main.ts": main });
    const request = routeRequestFor(operation, decl, main);

    const result = await postLanguage(request, redactEveryString);

    expect(result.status).toBe(200);
    const body = result.body as { operation?: string };
    expect(body.operation).toBe(shouldRedact ? "[REDACTED]" : operation);
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
