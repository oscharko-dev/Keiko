// GEN-PERF-CLI-001 — regression guard for CLI lazy loading. The CLI barrel is
// evaluated on every `keiko` invocation, so evaluating it (and dispatching the
// meta commands) must not load any heavy workspace module graph. Each heavy
// package is mocked with a factory whose ONLY job is to record that the module
// was requested: vitest runs mock factories lazily on first import, so the flags
// stay false unless something actually loads the graph. This pins the ~80ms
// startup (measured; ~440-490ms before) structurally rather than by timing.
import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "./runner.js";

const loaded = {
  server: false,
  harness: false,
  workflows: false,
  evaluations: false,
  verification: false,
  evidence: false,
  gateway: false,
  workspace: false,
  sdk: false,
};

vi.mock("@oscharko-dev/keiko-server", () => {
  loaded.server = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-harness", () => {
  loaded.harness = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-workflows", () => {
  loaded.workflows = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-evaluations", () => {
  loaded.evaluations = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-verification", () => {
  loaded.verification = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-evidence", () => {
  loaded.evidence = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-model-gateway", () => {
  loaded.gateway = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-workspace", () => {
  loaded.workspace = true;
  return {};
});
vi.mock("@oscharko-dev/keiko-sdk", () => {
  loaded.sdk = true;
  return { SDK_VERSION: "0.0.0-test" };
});

function makeIo(): { io: CliIo; out: () => string } {
  const chunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        chunks.push(text);
      },
      err: (text: string): void => {
        chunks.push(text);
      },
    },
    out: () => chunks.join(""),
  };
}

describe("GEN-PERF-CLI-001 — CLI barrel loads no heavy module graph", () => {
  it("evaluating the public barrel requests none of the heavy packages", async () => {
    await import("./index.js");
    expect(loaded).toEqual({
      server: false,
      harness: false,
      workflows: false,
      evaluations: false,
      verification: false,
      evidence: false,
      gateway: false,
      workspace: false,
      sdk: false,
    });
  });

  it("dispatching --version and --help stays on the light path", async () => {
    const { runCli } = await import("./runner.js");
    const versionIo = makeIo();
    expect(await Promise.resolve(runCli(["--version"], versionIo.io, {}))).toBe(0);
    expect(versionIo.out()).toContain("keiko ");
    const helpIo = makeIo();
    expect(await Promise.resolve(runCli(["--help"], helpIo.io, {}))).toBe(0);
    const unknownIo = makeIo();
    expect(await Promise.resolve(runCli(["definitely-not-a-command"], unknownIo.io, {}))).toBe(2);
    expect(loaded).toEqual({
      server: false,
      harness: false,
      workflows: false,
      evaluations: false,
      verification: false,
      evidence: false,
      gateway: false,
      workspace: false,
      sdk: false,
    });
  });

  it("dispatching a heavy command loads exactly its graph on demand", async () => {
    const { runCli } = await import("./runner.js");
    const io = makeIo();
    // models list awaits the gateway module; the mock returns {} so the handler
    // throws — the assertion is about WHICH module was requested, not the outcome.
    await Promise.resolve(runCli(["models", "list"], io.io, {})).catch(() => 1);
    expect(loaded.gateway).toBe(true);
    expect(loaded.server).toBe(false);
    expect(loaded.harness).toBe(false);
  });
});
