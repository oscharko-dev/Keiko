import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EDITOR_RUNTIME_UNSUPPORTED_REASONS,
  configureMonacoLoader,
  describeEditorRuntimeError,
  detectEditorRuntimeSupport,
  editorRuntimeLoadFailure,
  isMonacoLoaderConfigured,
  probeEditorRuntime,
  type MonacoLoaderLike,
} from "./runtime.js";

const monacoDir = dirname(fileURLToPath(import.meta.url));

describe("configureMonacoLoader", () => {
  it("configures the loader with the local monaco instance and records that it ran (no CDN loader)", () => {
    // Module-level flag starts false; this is the first test in the file to call configureMonacoLoader.
    expect(isMonacoLoaderConfigured()).toBe(false);
    const received: { monaco: unknown }[] = [];
    const loader: MonacoLoaderLike = {
      config: (options) => received.push(options),
    };
    const monacoInstance = { editor: {} };
    configureMonacoLoader(loader, monacoInstance);
    expect(received).toHaveLength(1);
    expect(received[0]?.monaco).toBe(monacoInstance);
    // The host can now assert this before mounting the editor, guarding the no-CDN invariant.
    expect(isMonacoLoaderConfigured()).toBe(true);
  });
});

describe("detectEditorRuntimeSupport", () => {
  it("reports supported when workers and the URL API are present", () => {
    expect(detectEditorRuntimeSupport({ hasWorker: true, hasUrl: true })).toEqual({
      supported: true,
    });
  });

  it("reports an actionable unsupported state when Web Workers are unavailable", () => {
    const status = detectEditorRuntimeSupport({ hasWorker: false, hasUrl: true });
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("web-workers-unavailable");
      expect(status.message).toMatch(/Web Workers/);
    }
  });

  it("reports the URL-API reason only after workers are confirmed", () => {
    const status = detectEditorRuntimeSupport({ hasWorker: true, hasUrl: false });
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("url-api-unavailable");
    }
  });

  it("prioritises the worker reason when both are missing", () => {
    const status = detectEditorRuntimeSupport({ hasWorker: false, hasUrl: false });
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("web-workers-unavailable");
    }
  });
});

describe("probeEditorRuntime", () => {
  class WorkerStub {
    public readonly kind = "worker";
  }

  it("detects present capabilities from the injected scope", () => {
    expect(probeEditorRuntime({ Worker: WorkerStub, URL })).toEqual({
      hasWorker: true,
      hasUrl: true,
    });
  });

  it("rejects non-constructor runtime globals", () => {
    expect(probeEditorRuntime({ Worker: {}, URL })).toEqual({
      hasWorker: false,
      hasUrl: true,
    });
    expect(probeEditorRuntime({ Worker: () => undefined, URL: {} })).toEqual({
      hasWorker: false,
      hasUrl: false,
    });
  });

  it("detects absent capabilities from an empty scope", () => {
    expect(probeEditorRuntime({})).toEqual({ hasWorker: false, hasUrl: false });
  });
});

describe("editorRuntimeLoadFailure", () => {
  it("returns a controlled error state that never mentions a CDN fallback", () => {
    const status = editorRuntimeLoadFailure();
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("monaco-runtime-load-failed");
      expect(status.message).toMatch(/never falls back to a third-party CDN/);
    }
  });
});

describe("describeEditorRuntimeError", () => {
  it("gives a non-empty, actionable message for every reason", () => {
    for (const reason of EDITOR_RUNTIME_UNSUPPORTED_REASONS) {
      const message = describeEditorRuntimeError(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).toContain("editor");
    }
  });
});

/** Remove block/JSDoc comments so the scan inspects code, not documentation prose (which may name
 * the CDN seam the runtime deliberately avoids). Real CDN URLs would live in string literals/code. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("no-CDN invariant across the Monaco runtime (Issue #1193 AC, ADR-0042 D3)", () => {
  it("contains no CDN host in any runtime source module", () => {
    const sources = readdirSync(monacoDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const code = stripBlockComments(readFileSync(resolve(monacoDir, name), "utf8"));
      expect(code, `${name} must not reference a CDN host`).not.toMatch(
        /jsdelivr|unpkg|cdnjs|cdn\.|https?:\/\//,
      );
    }
  });
});
