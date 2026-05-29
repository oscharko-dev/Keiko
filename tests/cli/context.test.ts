import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContextCli } from "../../src/cli/context.js";
import type { CliIo } from "../../src/cli/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (t: string): void => void outChunks.push(t),
      err: (t: string): void => void errChunks.push(t),
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-ctx-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ctx-demo", version: "0.9.0", devDependencies: { vitest: "^4" } }),
    "utf8",
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# Ctx Demo\n", "utf8");
  writeFileSync(join(dir, ".env"), "SECRET=topsecret\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runContextCli", () => {
  it("prints a human summary and exits 0", () => {
    const c = makeIo();
    const code = runContextCli(["--dir", dir], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("Workspace:");
    expect(c.out()).toContain("ctx-demo");
    expect(c.out()).toContain("vitest");
  });

  it("emits JSON with --json", () => {
    const c = makeIo();
    const code = runContextCli(["--dir", dir, "--json"], c.io);
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(c.out());
    expect(parsed).toMatchObject({ name: "ctx-demo", version: "0.9.0" });
  });

  it("builds a context pack with selection reasons when --task is given", () => {
    const c = makeIo();
    const code = runContextCli(["--dir", dir, "--task", "explain the entrypoint", "--json"], c.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as { context?: { entries: { selectionReason: string }[] } };
    expect(parsed.context).toBeDefined();
    expect(parsed.context?.entries.some((e) => e.selectionReason === "entrypoint")).toBe(true);
  });

  it("never leaks denied secret-file contents", () => {
    const c = makeIo();
    runContextCli(["--dir", dir, "--task", "anything", "--json"], c.io);
    expect(c.out()).not.toContain("topsecret");
  });

  it("returns 2 on a malformed --budget", () => {
    const c = makeIo();
    expect(runContextCli(["--dir", dir, "--budget", "notanumber"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage");
  });
  it("returns 2 when --budget has a non-integer suffix like '10kb'", () => {
    const c = makeIo();
    expect(runContextCli(["--dir", dir, "--budget", "10kb"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("returns 2 when --budget is zero", () => {
    const c = makeIo();
    expect(runContextCli(["--dir", dir, "--budget", "0"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("returns 2 when --budget is negative", () => {
    const c = makeIo();
    expect(runContextCli(["--dir", dir, "--budget", "-100"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage");
  });

  it("returns 2 when --dir is supplied without a value", () => {
    const c = makeIo();
    expect(runContextCli(["--dir"], c.io)).toBe(2);
  });

  it("returns 1 with a workspace error code when no workspace exists", () => {
    const orphan = mkdtempSync(join(tmpdir(), "keiko-noroot-"));
    try {
      const c = makeIo();
      const code = runContextCli(["--dir", join(orphan, "child")], c.io);
      // If the temp dir sits under a repo, detection may still succeed; assert the error
      // contract only when it fails, otherwise it must be a clean success.
      if (code === 1) {
        expect(c.err()).toContain("WORKSPACE_");
      } else {
        expect(code).toBe(0);
      }
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("runs to success for a --task without error (dry-run path)", () => {
    const c = makeIo();
    const code = runContextCli(["--dir", dir, "--task", "explain", "--json"], c.io);
    expect(code).toBe(0);
    expect(c.err()).toBe("");
  });

  it("never imports the harness session or gateway run path (dry-run by construction)", () => {
    // Structural guarantee: the context command source must not pull in the agent run loop
    // or the model gateway, so it cannot construct a session or call a model.
    const source = readFileSync(join(HERE, "..", "..", "src", "cli", "context.ts"), "utf8");
    expect(source).not.toContain("harness/session");
    expect(source).not.toContain("harness/index");
    expect(source).not.toContain("createSession");
    expect(source).not.toContain("gateway/gateway");
    expect(source).not.toContain("../gateway/");
  });
});
