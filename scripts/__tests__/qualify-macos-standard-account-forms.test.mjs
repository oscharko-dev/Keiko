import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  DISPOSABLE_ACCOUNT_VARIABLE,
  FORMS,
  FormsRefusal,
  MARKED_OUTCOMES,
  NODE_FOLDER,
  NODE_USER_INSTALL_LINES,
  accountFacts,
  assertDisposableHome,
  browserDownloadMark,
  buildFormsEvidence,
  markedEntryCount,
  markedOutcome,
  nodeUserInstallScript,
  parseFormsArgs,
  standaloneAssetUrls,
} from "../testing/qualify-macos-standard-account-forms.mjs";

// #4520: the three macOS delivery forms, installed and started as a standard account. These pins
// keep the qualification a proof that can fail: it certifies only a standard account without sudo,
// every form and the download-mark record, and the guide prints the Node.js commands it runs.
const root = resolve(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const STANDARD = { groups: ["staff", "everyone"], administrator: false, sudo: "refused" };
const ADMINISTRATOR = { groups: ["staff", "admin"], administrator: true, sudo: "refused" };
const OPTIONS = { version: "1.5.6", nodeVersion: "26.13.1", expectMarked: "record" };

function passedForms() {
  const checks = [{ name: "coding-run-succeeded", result: "pass", durationMs: 1 }];
  return FORMS.map((form) => ({ form, passed: true, checks }));
}

const MARKED = { markedEntryCount: 12, startExit: 1, outcome: "start-refused" };

function fakeRun(outputs) {
  return (command, args) => outputs[`${command} ${args.join(" ")}`] ?? { status: 1, stdout: "" };
}

describe("parseFormsArgs", () => {
  it("takes the version and the evidence folder and defaults the rest", () => {
    expect(parseFormsArgs(["--version", "1.5.6", "--out-dir", "out"], "26.13.1")).toEqual({
      version: "1.5.6",
      outDir: "out",
      nodeVersion: "26.13.1",
      expectMarked: "record",
      account: "standard",
      repository: "oscharko-dev/Keiko",
    });
  });

  it("refuses a malformed or missing value", () => {
    const refused = [
      ["--out-dir", "out"],
      ["--version", "1.5", "--out-dir", "out"],
      ["--version", "1.5.6"],
      ["--version", "1.5.6", "--out-dir", "out", "--node-version", "26"],
      ["--version", "1.5.6", "--out-dir", "out", "--expect-marked", "maybe"],
      ["--version", "1.5.6", "--out-dir", "out", "--account", "admin"],
      ["--version", "1.5.6", "--out-dir", "out", "--unknown", "x"],
    ];
    for (const argv of refused) expect(() => parseFormsArgs(argv, "26.13.1")).toThrow(FormsRefusal);
  });

  it("accepts every marked outcome as an expectation", () => {
    for (const outcome of MARKED_OUTCOMES) {
      const argv = ["--version", "1.5.6", "--out-dir", "o", "--expect-marked", outcome];
      expect(parseFormsArgs(argv, "26.13.1").expectMarked).toBe(outcome);
    }
  });
});

describe("the Node.js a person unpacks in their own folder", () => {
  it("runs the documented lines with this run's versions and architecture", () => {
    const script = nodeUserInstallScript({
      nodeVersion: "26.14.0",
      nodeArch: "x64",
      keikoVersion: "1.5.6",
    }).split("\n");
    expect(script).toHaveLength(NODE_USER_INSTALL_LINES.length);
    expect(script).toContain("NODE_VERSION=26.14.0");
    expect(script).toContain("NODE_ARCH=x64");
    expect(script).toContain("npm install -g @oscharko-dev/keiko@1.5.6");
    expect(script.filter((line) => !NODE_USER_INSTALL_LINES.includes(line))).toHaveLength(3);
  });

  it("installs below the home folder and never asks for sudo", () => {
    expect(NODE_USER_INSTALL_LINES.join("\n")).not.toMatch(/\bsudo\b/u);
    expect(NODE_USER_INSTALL_LINES).toContain(`mkdir -p "$HOME/${NODE_FOLDER}"`);
    expect(NODE_USER_INSTALL_LINES.some((line) => line.includes("shasum -a 256 -c -"))).toBe(true);
  });

  it("is printed in README.md exactly as the qualification runs it", () => {
    const block = `\`\`\`bash\n${NODE_USER_INSTALL_LINES.join("\n")}\n\`\`\``;
    expect(read("README.md")).toContain(block);
  });
});

describe("accountFacts", () => {
  it("names a standard account that may not use sudo", () => {
    const run = fakeRun({
      "id -Gn": { status: 0, stdout: "staff everyone localaccounts\n" },
      "sudo -n true": { status: 1, stdout: "" },
    });
    expect(accountFacts(run)).toEqual({
      groups: ["staff", "everyone", "localaccounts"],
      administrator: false,
      sudo: "refused",
    });
  });

  it("names an administrator and an account that may use sudo", () => {
    const run = fakeRun({
      "id -Gn": { status: 0, stdout: "staff admin\n" },
      "sudo -n true": { status: 0, stdout: "" },
    });
    expect(accountFacts(run)).toMatchObject({ administrator: true, sudo: "available" });
  });
});

describe("download mark", () => {
  it("counts the marked entries find lists", () => {
    const run = () => ({ status: 0, stdout: "/a\n/a/b\n\n" });
    expect(markedEntryCount("/a", run)).toBe(2);
    expect(markedEntryCount("/a", () => ({ status: 0, stdout: "" }))).toBe(0);
    expect(() => markedEntryCount("/a", () => ({ status: 1, stdout: "" }))).toThrow(FormsRefusal);
  });

  it("writes the shape of a browser's mark", () => {
    expect(browserDownloadMark(0x65_00_00_00 * 1000, "ID")).toBe("0083;65000000;Safari;ID");
    expect(browserDownloadMark()).toMatch(/^0083;[0-9a-f]+;Safari;[0-9A-F-]{36}$/u);
  });

  it("names the outcome from what the start and the run showed", () => {
    expect(markedOutcome({ healthy: false, codingRun: "not-run" })).toBe("start-refused");
    expect(markedOutcome({ healthy: true, codingRun: "failed" })).toBe("started-coding-run-failed");
    expect(markedOutcome({ healthy: true, codingRun: "succeeded" })).toBe(
      "started-coding-run-succeeded",
    );
  });
});

describe("buildFormsEvidence", () => {
  const runner = { os: "darwin", arch: "arm64", osRelease: "25.0.0" };

  it("certifies a standard account whose three forms passed and whose mark was recorded", () => {
    const evidence = buildFormsEvidence({
      options: OPTIONS,
      account: STANDARD,
      forms: passedForms(),
      marked: MARKED,
      runner,
    });
    expect(evidence).toMatchObject({ passed: true, certifies: true, version: "1.5.6" });
  });

  it("never certifies an administrator or an account that may use sudo", () => {
    for (const account of [ADMINISTRATOR, { ...STANDARD, sudo: "available" }]) {
      const evidence = buildFormsEvidence({
        options: OPTIONS,
        account,
        forms: passedForms(),
        marked: MARKED,
        runner,
      });
      expect(evidence).toMatchObject({ passed: true, certifies: false });
    }
  });

  it("fails when a form failed, is missing, or the mark was not recorded", () => {
    const failed = passedForms().map((entry) =>
      entry.form === "standalone" ? { ...entry, passed: false } : entry,
    );
    const noCodingRun = passedForms().map((entry) =>
      entry.form === "npm" ? { ...entry, checks: [] } : entry,
    );
    const cases = [
      { forms: failed, marked: MARKED },
      { forms: passedForms().slice(0, 2), marked: MARKED },
      { forms: noCodingRun, marked: MARKED },
      { forms: passedForms(), marked: undefined },
      { forms: passedForms(), marked: { ...MARKED, markedEntryCount: 0 } },
    ];
    for (const { forms, marked } of cases) {
      const evidence = buildFormsEvidence({
        options: OPTIONS,
        account: STANDARD,
        forms,
        marked,
        runner,
      });
      expect(evidence).toMatchObject({ passed: false, certifies: false });
    }
  });

  it("fails when the recorded outcome differs from the expected one", () => {
    const options = { ...OPTIONS, expectMarked: "started-coding-run-succeeded" };
    const evidence = buildFormsEvidence({
      options,
      account: STANDARD,
      forms: passedForms(),
      marked: MARKED,
      runner,
    });
    expect(evidence.passed).toBe(false);
  });
});

describe("assertDisposableHome", () => {
  it("runs as a standard account only in the CI job that created it", () => {
    const standard = { account: "standard" };
    const job = { CI: "true", [DISPOSABLE_ACCOUNT_VARIABLE]: "1" };
    expect(() => assertDisposableHome(standard, "/Users/q", job, "/Users/q")).not.toThrow();
    for (const env of [{}, { CI: "true" }, { [DISPOSABLE_ACCOUNT_VARIABLE]: "1" }]) {
      expect(() => assertDisposableHome(standard, "/Users/q", env, "/Users/q")).toThrow(
        FormsRefusal,
      );
    }
  });

  it("rehearses only in a home of its own, never the account's real home", () => {
    const any = { account: "any" };
    expect(() => assertDisposableHome(any, "/lab/home", {}, "/Users/me")).not.toThrow();
    expect(() => assertDisposableHome(any, "/Users/me/", {}, "/Users/me")).toThrow(FormsRefusal);
  });
});

describe("release assets", () => {
  it("reads the standalone archive and its checksum from the public release", () => {
    expect(
      standaloneAssetUrls({ repository: "o/r", version: "1.5.6", target: "macos-arm64" }),
    ).toEqual({
      archive: "https://github.com/o/r/releases/download/v1.5.6/keiko-macos-arm64.standalone.zip",
      checksum:
        "https://github.com/o/r/releases/download/v1.5.6/keiko-macos-arm64.standalone.zip.sha256",
    });
  });
});

describe("the standard-account job (#4520)", () => {
  const workflow = parse(read(".github/workflows/npm-folder-qualify.yml"));
  const job = workflow.jobs["standard-account-forms"];
  const step = (name) => job.steps.find((entry) => entry.name === name);

  it("qualifies the resolved published version on Apple silicon", () => {
    expect(job.needs).toBe("resolve");
    expect(job.if).toBe("needs.resolve.outputs.publishable == 'true'");
    expect(job["runs-on"]).toBe("macos-15");
  });

  it("installs and starts the forms as the standard account and checks its footprint as root", () => {
    const names = job.steps.map((entry) => entry.name);
    const created = names.indexOf("Create the standard account the forms are installed as");
    const marked = names.indexOf("Mark the moment before the standard account acts");
    const forms = names.indexOf("Install and start the three forms as the standard account");
    const footprint = names.indexOf(
      "Check that nothing outside the account's own folders was created or changed",
    );
    expect(created).toBeGreaterThan(-1);
    expect([created, marked, forms, footprint]).toEqual(
      [...[created, marked, forms, footprint]].sort((a, b) => a - b),
    );
    expect(job.steps[created].uses).toBe("./.github/actions/macos-standard-account");
    const run = step("Install and start the three forms as the standard account").run;
    expect(run).toContain("sudo -u keikoqa -H /usr/bin/env -i");
    expect(run).toContain("CI=true");
    expect(run).toContain(`${DISPOSABLE_ACCOUNT_VARIABLE}=1`);
    expect(run).toContain("node scripts/testing/qualify-macos-standard-account-forms.mjs");
    expect(run).not.toContain("--account any");
    const check = step(
      "Check that nothing outside the account's own folders was created or changed",
    );
    expect(check.if).toBe("${{ !cancelled() }}");
    expect(check.run).toContain(
      'sudo "$(command -v node)" scripts/testing/standard-account-footprint.mjs',
    );
    expect(check.run).toContain("--account keikoqa");
  });

  it("keeps its evidence apart from the npm folder ZIPs the publication collects", () => {
    const upload = step("Upload the evidence");
    expect(upload.with.name).toBe("macos-delivery-forms-standard-account");
    expect(upload.with.name.startsWith("npm-folder-")).toBe(false);
  });

  it("runs on a pull request that changes the qualification", () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        "scripts/testing/qualify-macos-standard-account-forms.mjs",
        "scripts/testing/standard-account-footprint.mjs",
        ".github/actions/macos-standard-account/**",
      ]),
    );
  });
});
