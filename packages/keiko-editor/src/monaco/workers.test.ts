import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultMonacoWorkerFactories } from "./worker-entries.js";
import {
  MONACO_WORKER_ENTRIES,
  MONACO_WORKER_MODULES,
  createMonacoEnvironment,
  installMonacoEnvironment,
  monacoWorkerEntryForLabel,
  type MonacoEnvironmentLike,
  type MonacoWorkerFactories,
} from "./workers.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

describe("monacoWorkerEntryForLabel", () => {
  it("routes Monaco language labels to the governed editor-only worker", () => {
    expect(monacoWorkerEntryForLabel("typescript")).toBe("editor");
    expect(monacoWorkerEntryForLabel("javascript")).toBe("editor");
    expect(monacoWorkerEntryForLabel("json")).toBe("editor");
    expect(monacoWorkerEntryForLabel("css")).toBe("editor");
    expect(monacoWorkerEntryForLabel("scss")).toBe("editor");
    expect(monacoWorkerEntryForLabel("less")).toBe("editor");
    expect(monacoWorkerEntryForLabel("html")).toBe("editor");
    expect(monacoWorkerEntryForLabel("handlebars")).toBe("editor");
    expect(monacoWorkerEntryForLabel("razor")).toBe("editor");
  });

  it("falls back to the editor worker for the base service and unknown labels", () => {
    expect(monacoWorkerEntryForLabel("editorWorkerService")).toBe("editor");
    expect(monacoWorkerEntryForLabel("editor")).toBe("editor");
    expect(monacoWorkerEntryForLabel("unknown-future-label")).toBe("editor");
    expect(monacoWorkerEntryForLabel("")).toBe("editor");
  });
});

describe("MONACO_WORKER_MODULES", () => {
  it("names a local same-origin module for every worker entry", () => {
    expect(Object.keys(MONACO_WORKER_MODULES).sort()).toEqual([...MONACO_WORKER_ENTRIES].sort());
    for (const specifier of Object.values(MONACO_WORKER_MODULES)) {
      expect(specifier).toMatch(/^monaco-editor\/esm\/vs\/.*\.worker\.js$/);
    }
  });

  it("points at no CDN host (no-CDN invariant, ADR-0042 D3)", () => {
    for (const specifier of Object.values(MONACO_WORKER_MODULES)) {
      expect(specifier).not.toMatch(/^https?:/);
      expect(specifier).not.toMatch(/jsdelivr|unpkg|cdnjs|cdn\./);
    }
  });

  it("resolves every worker module from the installed monaco-editor package (verified in build)", () => {
    for (const specifier of Object.values(MONACO_WORKER_MODULES)) {
      const resolved = require.resolve(specifier);
      expect(resolved).toContain("node_modules/monaco-editor/esm/vs/");
    }
  });
});

describe("createMonacoEnvironment", () => {
  function taggedFactories(): {
    factories: MonacoWorkerFactories;
    calls: string[];
  } {
    const calls: string[] = [];
    const make = (tag: string): (() => Worker) => {
      return () => {
        calls.push(tag);
        return { tag } as unknown as Worker;
      };
    };
    return {
      calls,
      factories: {
        editor: make("editor"),
      },
    };
  }

  it("dispatches getWorker to the editor-only factory for every label", () => {
    const { factories, calls } = taggedFactories();
    const environment = createMonacoEnvironment(factories);
    expect((environment.getWorker("1", "typescript") as unknown as { tag: string }).tag).toBe(
      "editor",
    );
    expect((environment.getWorker("2", "json") as unknown as { tag: string }).tag).toBe("editor");
    expect((environment.getWorker("3", "scss") as unknown as { tag: string }).tag).toBe("editor");
    expect((environment.getWorker("4", "razor") as unknown as { tag: string }).tag).toBe("editor");
    expect(
      (environment.getWorker("5", "editorWorkerService") as unknown as { tag: string }).tag,
    ).toBe("editor");
    expect(calls).toEqual(["editor", "editor", "editor", "editor", "editor"]);
  });
});

describe("installMonacoEnvironment", () => {
  it("assigns the environment onto the injected global scope", () => {
    const environment: MonacoEnvironmentLike = { getWorker: () => ({}) as unknown as Worker };
    const scope: { MonacoEnvironment?: MonacoEnvironmentLike } = {};
    installMonacoEnvironment(scope, environment);
    expect(scope.MonacoEnvironment).toBe(environment);
  });
});

describe("defaultMonacoWorkerFactories", () => {
  it("provides a deferred constructor for every worker entry", () => {
    expect(Object.keys(defaultMonacoWorkerFactories).sort()).toEqual(
      [...MONACO_WORKER_ENTRIES].sort(),
    );
    for (const factory of Object.values(defaultMonacoWorkerFactories)) {
      expect(typeof factory).toBe("function");
    }
  });

  it("ships the local editor worker used by the default factory, never a CDN", () => {
    const source = readFileSync(resolve(here, "worker-entries.ts"), "utf8");
    for (const specifier of Object.values(MONACO_WORKER_MODULES)) {
      expect(source).toContain(specifier);
    }
    for (const disallowed of [
      "monaco-editor/esm/vs/language/typescript/ts.worker.js",
      "monaco-editor/esm/vs/language/json/json.worker.js",
      "monaco-editor/esm/vs/language/css/css.worker.js",
      "monaco-editor/esm/vs/language/html/html.worker.js",
    ]) {
      expect(source).not.toContain(disallowed);
    }
    expect(source).not.toMatch(/jsdelivr|unpkg|cdnjs|cdn\./);
    expect(source).toContain("import.meta.url");
    expect(source).toContain('type: "module"');
  });
});
