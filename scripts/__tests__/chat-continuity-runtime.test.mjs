import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  privateContinuityOutput,
  snapshotContinuityState,
  startContinuityRuntime,
} from "../testing/coding-workbench-lab/chat-continuity-runtime.mjs";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-continuity-"));
  roots.push(root);
  return root;
}

describe("private continuity qualification state", () => {
  it("refuses a denied source location before loading any credential or starting a model", async () => {
    await expect(
      startContinuityRuntime(
        join(temporary(), ".codex", "qualification"),
        "/nonexistent-config",
        [],
      ),
    ).rejects.toThrow("qualification-source-location-denied");
  });
  it("rejects repository-local output, including dot-prefixed names", () => {
    expect(() => privateContinuityOutput(join(REPO_ROOT, "new-output"))).toThrow(
      "external-output-required",
    );
    expect(() => privateContinuityOutput(join(REPO_ROOT, "..hidden-output"))).toThrow(
      "external-output-required",
    );
  });
  it("resolves parent symlinks before admitting an external destination", () => {
    const root = temporary();
    symlinkSync(REPO_ROOT, join(root, "repository"));
    expect(() => privateContinuityOutput(join(root, "repository", "new-output"))).toThrow(
      "external-output-required",
    );
    expect(privateContinuityOutput(join(root, "private-output"))).toBe(
      join(root, "private-output"),
    );
  });
  it("backs up live WAL state without letting probe answers rehearse the source", async () => {
    const root = temporary();
    mkdirSync(join(root, "ui"));
    const source = new DatabaseSync(join(root, "ui", "keiko-ui.db"));
    source.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES ('original agreement');",
    );
    const target = join(root, "snapshot");
    try {
      await snapshotContinuityState(root, target);
      const probe = new DatabaseSync(join(target, "ui", "keiko-ui.db"));
      try {
        expect(probe.prepare("SELECT body FROM messages").all()).toEqual([
          { body: "original agreement" },
        ]);
        probe.exec("INSERT INTO messages VALUES ('recalled answer');");
        expect(source.prepare("SELECT COUNT(*) AS count FROM messages").get().count).toBe(1);
        expect(statSync(target).mode & 0o077).toBe(0);
        expect(statSync(join(target, "ui", "keiko-ui.db")).mode & 0o077).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      source.close();
    }
  });
});
