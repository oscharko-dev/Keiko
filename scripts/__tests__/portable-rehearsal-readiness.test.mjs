import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  portableRehearsalReadiness,
  runPortableRehearsalReadiness,
} from "../portable-rehearsal-readiness.mjs";
import { PORTABLE_RELEASE_IMPACT_CONTRACT, PORTABLE_TARGET_NAMES } from "../portable-runtime.mjs";

const rootPackage = { name: "@oscharko-dev/keiko", version: "2.3.4" };

function approvedEntry(overrides = {}) {
  return {
    packageName: rootPackage.name,
    packageVersion: rootPackage.version,
    releaseTag: `v${rootPackage.version}`,
    review: { status: "reviewed", humanApproved: true },
    portableRuntimeArtifactContract: {
      ...PORTABLE_RELEASE_IMPACT_CONTRACT,
      signingScope: "evaluation",
      targets: [...PORTABLE_TARGET_NAMES],
    },
    ...overrides,
  };
}

describe("portable release rehearsal readiness", () => {
  it("is ready when one approved entry stages every portable target at the stable tag", () => {
    expect(
      portableRehearsalReadiness({ catalog: { entries: [approvedEntry()] }, rootPackage }),
    ).toEqual({
      ready: true,
      releaseTag: "v2.3.4",
      reason: "v2.3.4 is approved for every portable target",
    });
  });

  it.each([
    ["no entry for the version", []],
    [
      "an entry that is not human-approved",
      [approvedEntry({ review: { status: "reviewed", humanApproved: false } })],
    ],
    [
      "an entry that is still in review",
      [approvedEntry({ review: { status: "pending", humanApproved: true } })],
    ],
    ["an entry for another release tag", [approvedEntry({ releaseTag: "v2.3.3" })]],
    ["two entries that would both stage it", [approvedEntry(), approvedEntry()]],
  ])("is not ready, without failing, for %s", (_label, entries) => {
    const result = portableRehearsalReadiness({ catalog: { entries }, rootPackage });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe(
      `no single reviewed and approved release-impact entry stages ${PORTABLE_TARGET_NAMES.join(", ")} for v2.3.4`,
    );
  });

  it("names exactly the targets an approved contract does not cover", () => {
    const entry = approvedEntry();
    entry.portableRuntimeArtifactContract.targets = PORTABLE_TARGET_NAMES.filter(
      (name) => name !== "linux-x64",
    );

    expect(portableRehearsalReadiness({ catalog: { entries: [entry] }, rootPackage }).reason).toBe(
      "no single reviewed and approved release-impact entry stages linux-x64 for v2.3.4",
    );
  });

  it("does not rehearse a prerelease through the stable lane", () => {
    const prerelease = { ...rootPackage, version: "2.4.0-beta.1" };

    expect(
      portableRehearsalReadiness({ catalog: { entries: [] }, rootPackage: prerelease }),
    ).toEqual({
      ready: false,
      releaseTag: "v2.4.0-beta.1",
      reason: "v2.4.0-beta.1 is a prerelease, and the stable lane rehearses stable versions only",
    });
  });

  it.each([
    [
      "a missing package name",
      { catalog: { entries: [] }, rootPackage: { version: "2.3.4" } },
      "root package identity is invalid",
    ],
    [
      "a version that could inject an output line",
      { catalog: { entries: [] }, rootPackage: { name: "x", version: "2.3.4\nready=true" } },
      "root package identity is invalid",
    ],
    [
      "a catalog without entries",
      { catalog: {}, rootPackage },
      "release-impact catalog entries are invalid",
    ],
  ])("fails closed on %s", (_label, input, message) => {
    expect(() => portableRehearsalReadiness(input)).toThrow(message);
  });
});

describe("portable release rehearsal readiness in a workflow step", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  const workspace = (entries) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-rehearsal-readiness-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify(rootPackage));
    writeFileSync(
      join(root, "release-impact.catalog.json"),
      JSON.stringify({ schemaVersion: 1, entries }),
    );
    return root;
  };

  it.each([
    [
      "an approved version",
      [approvedEntry()],
      "ready=true",
      "Release rehearsal: v2.3.4 is approved",
    ],
    ["an unapproved version", [], "ready=false", "Not releasable yet: no single reviewed"],
  ])("writes the step outputs and summary for %s", (_label, entries, output, summary) => {
    const root = workspace(entries);
    const env = { GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary") };
    writeFileSync(env.GITHUB_OUTPUT, "");
    writeFileSync(env.GITHUB_STEP_SUMMARY, "");

    runPortableRehearsalReadiness(root, env);

    expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(`${output}\nrelease-tag=v2.3.4\n`);
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain(summary);
  });

  it("decides without GitHub step outputs outside a workflow", () => {
    const root = workspace([approvedEntry()]);
    expect(runPortableRehearsalReadiness(root, {}).ready).toBe(true);
  });

  it("exits non-zero with a named message when the catalog is unreadable", () => {
    const root = workspace([]);
    writeFileSync(join(root, "release-impact.catalog.json"), "{ not json");

    const result = spawnSync(
      process.execPath,
      [resolve("scripts/portable-rehearsal-readiness.mjs")],
      {
        cwd: root,
        encoding: "utf8",
        env: {},
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("portable-rehearsal-readiness: unreadable package or catalog");
  });
});
