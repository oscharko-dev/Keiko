import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy browser-only modules: `monaco-editor` cannot be imported in Node (it imports CSS),
// and the loader's CDN config must not run for real. The keiko-editor helpers stay real — they are
// pure and node-safe — so this exercises the host's actual wiring decisions.
const config = vi.fn();
vi.mock("@monaco-editor/react", () => ({ loader: { config } }));
vi.mock("monaco-editor", () => ({ editor: {} }));

interface MutableScope {
  Worker?: unknown;
  MonacoEnvironment?: unknown;
}

const scope = globalThis as unknown as MutableScope;

beforeEach(() => {
  vi.resetModules();
  config.mockClear();
  delete scope.Worker;
  delete scope.MonacoEnvironment;
});

afterEach(() => {
  delete scope.Worker;
  delete scope.MonacoEnvironment;
});

describe("ensureMonacoRuntime", () => {
  it("reports an unsupported runtime and configures nothing when Web Workers are unavailable", async () => {
    // jsdom has no Worker constructor by default — the real unsupported path.
    const { ensureMonacoRuntime } = await import("./editorMonacoRuntime");
    const status = ensureMonacoRuntime();
    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.reason).toBe("web-workers-unavailable");
    }
    expect(config).not.toHaveBeenCalled();
    expect(scope.MonacoEnvironment).toBeUndefined();
  });

  it("installs the worker environment and configures the no-CDN loader exactly once when supported", async () => {
    scope.Worker = class {};
    const { ensureMonacoRuntime } = await import("./editorMonacoRuntime");

    const first = ensureMonacoRuntime();
    expect(first.supported).toBe(true);
    expect(config).toHaveBeenCalledTimes(1);
    expect(scope.MonacoEnvironment).toBeDefined();

    // Idempotent: a second call neither reconfigures the loader nor reinstalls the environment.
    const second = ensureMonacoRuntime();
    expect(second.supported).toBe(true);
    expect(config).toHaveBeenCalledTimes(1);
  });
});
