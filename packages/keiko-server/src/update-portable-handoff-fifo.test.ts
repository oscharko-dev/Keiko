import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const childModule = new URL(
  "../../../tests/support/portable-handoff-fifo-child.ts",
  import.meta.url,
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("portable handoff FIFO boundaries", () => {
  it.each([
    ["copy-coordinator", "linux-x64"],
    ["copy-supervisor", "linux-x64"],
    ["copy-coordinator", "macos-arm64"],
    ["copy-supervisor", "macos-arm64"],
    ["copy-directory-race", "linux-x64"],
    ["plan-race", "linux-x64"],
    ["receipt-race", "linux-x64"],
    ["ack-race", "linux-x64"],
    ["plan-fifo", "linux-x64"],
    ["receipt-fifo", "linux-x64"],
    ["ack-fifo", "linux-x64"],
    ["directory-fifo", "linux-x64"],
  ])("refuses %s on %s after a reachable healthy control", (subject, target) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-handoff-fifo-")));
    roots.push(root);
    const child = spawnSync(process.execPath, [fileURLToPath(childModule), root, subject, target], {
      encoding: "utf8",
      timeout: 3_500,
      killSignal: "SIGKILL",
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("refused-after-healthy-control");
    expect(child.stderr).toBe("");
  });
});
