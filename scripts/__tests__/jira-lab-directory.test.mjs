// Lab data never lives in a temporary directory (#4369, owner rule).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLabDirectoryOutsideTemporary } from "../testing/jira-chat-lab/lab-directory.mjs";
import { main as seedLanguage } from "../testing/jira-chat-lab/seed-language.mjs";
import { main as fixtures } from "../testing/jira-chat-lab/release-1-fixtures.mjs";

const cleanup = [];
afterEach(() =>
  cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe("assertLabDirectoryOutsideTemporary", () => {
  it.each(["/tmp/lab", "/private/tmp/lab/session", "/var/tmp/x", "/private/var/tmp/x"])(
    "refuses %s",
    (path) => expect(() => assertLabDirectoryOutsideTemporary(path)).toThrow("temporary"),
  );

  it("refuses the operating system's temporary directory and anything below it", () => {
    expect(() => assertLabDirectoryOutsideTemporary(join(tmpdir(), "keiko-lab"))).toThrow(
      "temporary",
    );
    expect(() => assertLabDirectoryOutsideTemporary(tmpdir())).toThrow("temporary");
  });

  it("sees through a symbolic link that points into a temporary directory", () => {
    const real = mkdtempSync(join(tmpdir(), "lab-dir-"));
    const parent = mkdtempSync(join(homedir(), ".keiko-lab-dir-test-"));
    cleanup.push(real, parent);
    const link = join(parent, "alias");
    symlinkSync(real, link);
    mkdirSync(join(real, "inner"));
    expect(() => assertLabDirectoryOutsideTemporary(join(link, "inner"))).toThrow("temporary");
  });

  it.each([
    join(homedir(), "keiko-jira-lab-runs/x"),
    join(homedir(), ".local/share/keiko-jira-new"),
  ])("accepts %s, also when it does not exist yet", (path) =>
    expect(assertLabDirectoryOutsideTemporary(path)).toBe(path),
  );

  it("does not mistake a sibling with the same prefix for a temporary directory", () => {
    expect(() => assertLabDirectoryOutsideTemporary("/tmpfoo/session")).not.toThrow();
  });
});

describe("the fixture commands refuse a temporary session before any read", () => {
  it("seed-language and release-1-fixtures", async () => {
    await expect(seedLanguage(["/private/tmp/session", "de"])).rejects.toThrow("temporary");
    await expect(fixtures(["/tmp/session", "--inventory"])).rejects.toThrow("temporary");
  });
});

describe("session creation", () => {
  it("is refused under a temporary directory, while start/stop of an existing session are not guarded", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = join(import.meta.dirname, "../testing/jira-chat-lab/session.mjs");
    const init = spawnSync(process.execPath, [script, "init", "/private/tmp/keiko-lab-never"], {
      encoding: "utf8",
    });
    expect(init.status).not.toBe(0);
    expect(init.stderr).toContain("temporary directory");
  });
});
