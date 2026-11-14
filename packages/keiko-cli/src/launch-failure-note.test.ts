import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAUNCH_FAILURE_NOTE_ENV,
  LAUNCH_FAILURE_REASONS,
  writeLaunchFailureNote,
} from "./launch-failure-note.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function notePath(name = "keiko-launch-note-4711.txt"): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-note-"));
  roots.push(root);
  return join(root, name);
}

describe("the failure note for the native launcher", () => {
  it("writes only the closed reason token for a start the launcher began", () => {
    const path = notePath();

    const result = writeLaunchFailureNote(
      { KEIKO_PORTABLE_UI_LAUNCH: "1", [LAUNCH_FAILURE_NOTE_ENV]: path },
      "health-timeout",
    );

    expect(result).toBe("written");
    expect(readFileSync(path, "utf8")).toBe("health-timeout");
  });

  it.each([
    ["no double-click marker", { [LAUNCH_FAILURE_NOTE_ENV]: "/tmp/keiko-launch-note-1.txt" }],
    ["a marker that is not exactly 1", { KEIKO_PORTABLE_UI_LAUNCH: "true" }],
    ["no note path", { KEIKO_PORTABLE_UI_LAUNCH: "1" }],
    ["an empty note path", { KEIKO_PORTABLE_UI_LAUNCH: "1", [LAUNCH_FAILURE_NOTE_ENV]: "" }],
  ] as const)("is not requested with %s", (_label, env) => {
    expect(writeLaunchFailureNote(env, "launch-error")).toBe("not-requested");
  });

  it.each([
    ["a relative path", "keiko-launch-note-4711.txt"],
    ["another file name", "/tmp/something-else.txt"],
    ["a name that only ends like the note", "/tmp/xkeiko-launch-note-4711.txt"],
    ["a non-numeric id", "/tmp/keiko-launch-note-abc.txt"],
    ["a path through a parent", "/tmp/../etc/keiko-launch-note-1.txt"],
  ] as const)("refuses %s without writing anything", (_label, path) => {
    expect(() =>
      writeLaunchFailureNote(
        { KEIKO_PORTABLE_UI_LAUNCH: "1", [LAUNCH_FAILURE_NOTE_ENV]: path },
        "launch-error",
      ),
    ).toThrow("not the launcher's own");
  });

  it("never overwrites a file that exists: the launcher removes its own before the child starts", () => {
    const path = notePath();
    writeFileSync(path, "planted");

    expect(() =>
      writeLaunchFailureNote(
        { KEIKO_PORTABLE_UI_LAUNCH: "1", [LAUNCH_FAILURE_NOTE_ENV]: path },
        "launch-error",
      ),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe("planted");
  });

  it("writes nothing into a folder that does not exist", () => {
    const path = join(tmpdir(), "keiko-no-such-folder-4358", "keiko-launch-note-1.txt");

    expect(() =>
      writeLaunchFailureNote(
        { KEIKO_PORTABLE_UI_LAUNCH: "1", [LAUNCH_FAILURE_NOTE_ENV]: path },
        "launch-error",
      ),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  // The launcher reads at most 31 bytes of lowercase letters and hyphens up to the first other byte
  // (keiko-portable-launcher.c, read_failure_reason): a reason that does not fit would be cut.
  it("keeps every reason inside what the launcher reads", () => {
    for (const reason of LAUNCH_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z-]{1,31}$/u);
    }
    expect(new Set(LAUNCH_FAILURE_REASONS).size).toBe(LAUNCH_FAILURE_REASONS.length);
  });
});
