import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLifecycleCli } from "./lifecycle.js";
import {
  currentNodeSupport,
  declaredNodeRange,
  nodeSupportOf,
  unsupportedNodeNotice,
} from "./node-support.js";

// npm only warns about `engines`, so a plain installation ran on Node.js 24 without a word. The
// range comes from the package's own manifest; the verdict is a closed value, never a refusal.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageWithRange(range: unknown): {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-node-support-"));
  roots.push(root);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", engines: { node: range } }),
  );
  return { root, env: { KEIKO_CLI_BIN_PATH: join(root, "dist", "cli", "index.js") } };
}

describe("nodeSupportOf", () => {
  const range = ">=26.13.1 <27";

  it.each([
    ["v26.13.1", "supported"],
    ["v26.20.0", "supported"],
    ["v26.13.0", "unsupported"],
    ["v24.13.0", "unsupported"],
    ["v27.0.0", "unsupported"],
    ["v27.0.0-nightly2026", "unsupported"],
  ])("judges %s as %s", (version, expected) => {
    expect(nodeSupportOf(version, range)).toBe(expected);
  });

  it("answers unknown instead of guessing when a version or range cannot be read", () => {
    expect(nodeSupportOf("v24.13.0", undefined)).toBe("unknown");
    expect(nodeSupportOf("not-a-version", range)).toBe("unknown");
    expect(nodeSupportOf("v24.13.0", "^26")).toBe("unknown");
    expect(nodeSupportOf("v24.13.0", "")).toBe("unknown");
  });

  it("reads alternatives: one satisfied clause is enough", () => {
    expect(nodeSupportOf("v22.1.0", ">=26.13.1 <27 || >=22 <23")).toBe("supported");
    expect(nodeSupportOf("v24.1.0", ">=26.13.1 <27 || >=22 <23")).toBe("unsupported");
  });
});

describe("the declared range", () => {
  it("is read from the package's own manifest, not restated", () => {
    const { env } = packageWithRange(">=99.1.0 <100");
    expect(declaredNodeRange(env)).toBe(">=99.1.0 <100");
    expect(currentNodeSupport(env, "v99.1.0")).toBe("supported");
    expect(currentNodeSupport(env, "v24.13.0")).toBe("unsupported");
  });

  it("is unknown without a bin path, a manifest or a string range", () => {
    expect(declaredNodeRange({})).toBeUndefined();
    expect(
      declaredNodeRange({ KEIKO_CLI_BIN_PATH: "/nonexistent/dist/cli/index.js" }),
    ).toBeUndefined();
    expect(declaredNodeRange(packageWithRange(26).env)).toBeUndefined();
  });

  it("is the range the repository's own package declares", () => {
    const env = { KEIKO_CLI_BIN_PATH: join(process.cwd(), "dist", "cli", "index.js") };
    expect(declaredNodeRange(env)).toMatch(/^>=\d+\.\d+\.\d+ <\d+$/u);
  });
});

describe("unsupportedNodeNotice", () => {
  it("names the running and the required version in one plain line for an unsupported Node.js", () => {
    const { env } = packageWithRange(">=26.13.1 <27");
    const notice = unsupportedNodeNotice(env, "v24.13.0");
    expect(notice).toBe(
      "keiko start: this Keiko requires Node.js >=26.13.1 <27, but runs on Node.js v24.13.0. This combination is not supported; install a supported Node.js.\n",
    );
    expect(notice?.trimEnd().split("\n")).toHaveLength(1);
  });

  it("is silent for a supported or an unjudgeable Node.js", () => {
    const { env } = packageWithRange(">=26.13.1 <27");
    expect(unsupportedNodeNotice(env, "v26.13.1")).toBeUndefined();
    expect(unsupportedNodeNotice({}, "v24.13.0")).toBeUndefined();
  });
});

describe("keiko start on an unsupported Node.js", () => {
  async function start(
    nodeVersion: string,
  ): Promise<{ readonly err: string; readonly spawned: number }> {
    const { root, env } = packageWithRange(">=26.13.1 <27");
    let err = "";
    const spawnFn = vi.fn(() => {
      throw new Error("stop after the start was observed");
    });
    await runLifecycleCli(
      "start",
      [],
      {
        out: (): void => undefined,
        err: (text): void => {
          err += text;
        },
      },
      env,
      {
        cwd: root,
        nodeVersion,
        isPortAvailable: () => Promise.resolve(true),
        sleep: () => Promise.resolve(),
        platform: () => "linux",
        openExternal: vi.fn(),
        spawnFn,
      },
    ).catch(() => 1);
    return { err, spawned: spawnFn.mock.calls.length };
  }

  it("says so once and still starts: the notice never refuses", async () => {
    const result = await start("v24.13.0");
    expect(result.err.match(/not supported/gu)).toHaveLength(1);
    expect(result.err).toContain("Node.js v24.13.0");
    expect(result.err).toContain(">=26.13.1 <27");
    expect(result.spawned).toBeGreaterThan(0);
  });

  it("prints nothing for a supported Node.js", async () => {
    const result = await start("v26.14.0");
    expect(result.err).not.toContain("not supported");
  });
});
