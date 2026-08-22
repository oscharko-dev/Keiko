// Tests for the stack-frame and cause-chain reducer (ADR-0173 D3). Four properties are
// load-bearing:
//
//   * a real dist-anchored frame (dev checkout, Windows path, portable install, or a resolved
//     workspace symlink) survives with no absolute prefix and no username;
//   * anything outside a known workspace root (node_modules, node:internal, an eval site, a
//     traversal segment, an oversized relative path) is DROPPED entirely, never partially redacted;
//   * a hostile `.stack`/`.cause` (a throwing accessor, a cycle, a multi-megabyte value) never
//     throws and never costs more than the stated bound;
//   * `PACKAGE_DIR_NAMES` is exactly the real `packages/*` directory listing, derived and never
//     restated (the same drift-test discipline `route-template.test.ts` applies to route literals).

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FRAME_SHAPE_PATTERN,
  PACKAGE_DIR_NAMES,
  causeChain,
  keikoStackFrames,
} from "./stack-frames.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en-US"));
}

function realPackageDirNames(): ReadonlySet<string> {
  return new Set(
    readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function stackOf(lines: readonly string[]): { readonly stack: string } {
  return { stack: ["Error: boom", ...lines].join("\n") };
}

describe("PACKAGE_DIR_NAMES drift", () => {
  // Derived from the real directory listing, never restated: a hard-coded expectation would move
  // together with the constant it is supposed to be checking and could never fail.
  it("matches the real packages/* directory listing exactly", () => {
    expect(sorted(PACKAGE_DIR_NAMES)).toEqual(sorted(realPackageDirNames()));
  });
});

describe("keikoStackFrames", () => {
  it("reduces a dev-checkout production frame to its dist-anchored form only", () => {
    const error = stackOf([
      "    at Object.handler (file:///Users/someone/app/packages/keiko-server/dist/observability/server-log.js:128:18)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "    at async Object.<anonymous> (/Users/someone/app/node_modules/some-lib/index.js:10:4)",
    ]);

    const frames = keikoStackFrames(error);

    expect(frames).toEqual(["packages/keiko-server/dist/observability/server-log.js:128:18"]);
    for (const frame of frames) expect(frame).not.toContain("someone");
  });

  it("reduces a Windows-shaped frame, normalising backslashes to forward slashes", () => {
    const error = stackOf([
      "    at run (C:\\Users\\x\\keiko\\packages\\keiko-cli\\dist\\ui.js:10:5)",
    ]);

    expect(keikoStackFrames(error)).toEqual(["packages/keiko-cli/dist/ui.js:10:5"]);
  });

  it("reduces a vitest (unbundled, src) frame", () => {
    const error = stackOf([
      "    at Object.<anonymous> (/Users/dev/keiko/packages/keiko-server/src/observability/server-log.ts:42:9)",
    ]);

    expect(keikoStackFrames(error)).toEqual([
      "packages/keiko-server/src/observability/server-log.ts:42:9",
    ]);
  });

  it("reduces the root keiko bin's own dist frame", () => {
    const error = stackOf(["    at Object.<anonymous> (file:///opt/keiko/dist/cli/index.js:9:1)"]);

    expect(keikoStackFrames(error)).toEqual(["dist/cli/index.js:9:1"]);
  });

  it("reduces the root keiko bin's own src frame under vitest", () => {
    const error = stackOf(["    at Object.<anonymous> (/Users/dev/keiko/src/cli/index.ts:5:2)"]);

    expect(keikoStackFrames(error)).toEqual(["src/cli/index.ts:5:2"]);
  });

  it("anchors on the LAST occurrence, ignoring an earlier decoy segment", () => {
    // A user could plausibly have a directory of their own named `packages/keiko-server/dist` on
    // the way to their checkout. Only the rightmost, real occurrence must be trusted.
    const error = stackOf([
      "    at f (file:///Users/x/packages/keiko-server/dist/decoy/packages/keiko-model-gateway/dist/gateway.js:3:3)",
    ]);

    expect(keikoStackFrames(error)).toEqual(["packages/keiko-model-gateway/dist/gateway.js:3:3"]);
  });

  it("drops a node_modules frame and a node:internal frame entirely", () => {
    const error = stackOf([
      "    at node:internal/process/task_queues:95:5",
      "    at Object.require (/Users/x/app/node_modules/some-lib/index.js:1:1)",
    ]);

    expect(keikoStackFrames(error)).toEqual([]);
  });

  it("drops an <anonymous> frame and a malformed eval frame without special-casing them", () => {
    const error = stackOf([
      "    at <anonymous>",
      "    at eval (eval at Object.<anonymous> (file:///Users/x/app/packages/keiko-server/dist/x.js:1:1))",
      "    at Object.<anonymous> (file:///Users/x/app/packages/keiko-server/dist/observability/server-log.js:5:5)",
    ]);

    expect(keikoStackFrames(error)).toEqual([
      "packages/keiko-server/dist/observability/server-log.js:5:5",
    ]);
  });

  it("drops a frame whose relative path carries a traversal segment", () => {
    const error = stackOf([
      "    at f (file:///Users/x/app/packages/keiko-server/dist/../../etc/passwd.js:1:1)",
    ]);

    expect(keikoStackFrames(error)).toEqual([]);
  });

  it("drops a frame whose relative path exceeds the bounded length", () => {
    const overlong = `${"a/".repeat(90)}file.js`;
    const error = stackOf([
      `    at f (file:///Users/x/app/packages/keiko-server/dist/${overlong}:1:1)`,
    ]);

    expect(keikoStackFrames(error)).toEqual([]);
  });

  it("caps at maxFrames, keeping the frames nearest the throw site first", () => {
    const error = stackOf([
      "    at a (file:///x/packages/keiko-server/dist/a.js:1:1)",
      "    at b (file:///x/packages/keiko-server/dist/b.js:2:2)",
      "    at c (file:///x/packages/keiko-server/dist/c.js:3:3)",
    ]);

    expect(keikoStackFrames(error, 2)).toEqual([
      "packages/keiko-server/dist/a.js:1:1",
      "packages/keiko-server/dist/b.js:2:2",
    ]);
  });

  it("returns an empty array when the stack getter throws", () => {
    const hostile: unknown = {
      get stack(): string {
        throw new Error("hostile accessor");
      },
    };

    expect(keikoStackFrames(hostile)).toEqual([]);
  });

  it("returns an empty array for a non-Error, non-object thrown value", () => {
    expect(keikoStackFrames("just a string")).toEqual([]);
    expect(keikoStackFrames(undefined)).toEqual([]);
  });

  it("stays within the cap on a 10,000-line stack and still finds the real frames", () => {
    const line = "    at f (file:///x/app/packages/keiko-server/dist/hot.js:1:1)";
    const error = stackOf(new Array(10_000).fill(line));

    const frames = keikoStackFrames(error);

    expect(frames.length).toBeLessThanOrEqual(8);
    expect(frames[0]).toBe("packages/keiko-server/dist/hot.js:1:1");
  });
});

describe("FRAME_SHAPE_PATTERN", () => {
  it("accepts a workspace-package frame and a root-bin frame", () => {
    expect(
      FRAME_SHAPE_PATTERN.test("packages/keiko-server/dist/observability/server-log.js:128:18"),
    ).toBe(true);
    expect(FRAME_SHAPE_PATTERN.test("packages/keiko-server/src/store.ts:1:1")).toBe(true);
    expect(FRAME_SHAPE_PATTERN.test("dist/cli/index.js:9:1")).toBe(true);
    expect(FRAME_SHAPE_PATTERN.test("src/cli/index.ts:5:2")).toBe(true);
  });

  it("declines an absolute path, a missing location, and a non-keiko package prefix", () => {
    expect(
      FRAME_SHAPE_PATTERN.test("/packages/keiko-server/dist/observability/server-log.js:1:1"),
    ).toBe(false);
    expect(FRAME_SHAPE_PATTERN.test("packages/keiko-server/dist/server-log.js")).toBe(false);
    expect(FRAME_SHAPE_PATTERN.test("packages/not-keiko-anything/dist/x.js:1:1")).toBe(false);
  });

  it("declines a relative path over the bounded length", () => {
    const overlong = `${"a".repeat(200)}.js`;
    expect(FRAME_SHAPE_PATTERN.test(`packages/keiko-server/dist/${overlong}:1:1`)).toBe(false);
  });
});

describe("causeChain", () => {
  it("classifies each cause with the same content-free class the diagnostics sink uses", () => {
    const root = new Error("root");
    const middle = new TypeError("middle");
    (root as { cause?: unknown }).cause = middle;

    expect(causeChain(root)).toEqual(["TypeError"]);
  });

  it("stops at maxDepth", () => {
    const errors = Array.from({ length: 10 }, (_, index) => new Error(`e${String(index)}`));
    for (let index = 0; index < errors.length - 1; index += 1) {
      const current = errors[index];
      const next = errors[index + 1];
      if (current !== undefined) (current as { cause?: unknown }).cause = next;
    }
    const root = errors[0];
    expect(root).toBeDefined();

    expect(causeChain(root, 3)).toHaveLength(3);
  });

  it("terminates a cyclic cause chain instead of looping forever", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;

    expect(causeChain(a)).toEqual(["Error"]);
  });

  it("classifies one non-Error object cause, then stops", () => {
    const root = new Error("root");
    (root as { cause?: unknown }).cause = { code: "FOO" };

    expect(causeChain(root)).toEqual(["object"]);
  });

  it("stops immediately on a primitive (non-object) cause", () => {
    const root = new Error("root");
    (root as { cause?: unknown }).cause = "just a string";

    expect(causeChain(root)).toEqual([]);
  });

  it("returns an empty array when there is no cause at all", () => {
    expect(causeChain(new Error("solo"))).toEqual([]);
  });

  it("returns an empty array for a non-object thrown value", () => {
    expect(causeChain("just a string")).toEqual([]);
  });
});
