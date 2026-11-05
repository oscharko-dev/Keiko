import { describe, expect, it } from "vitest";

import {
  admittedSurfaceDiff,
  breakingChanges,
  buildUpgradeReport,
  renderUpgradeReport,
  sourceTreeDiff,
  versionsBetween,
} from "../opencode-upgrade-report.mjs";

describe("versionsBetween", () => {
  const refs = ["2.1.4", "2.2.0", "2.2.5", "2.10.0", "3.0.0", "1.19.5"].map(
    (version) => `refs/tags/v${version}`,
  );

  it("keeps releases after the current pin, oldest first and numerically ordered", () => {
    expect(versionsBetween(refs, "2.1.4", "2.10.0")).toEqual(["2.2.0", "2.2.5", "2.10.0"]);
  });

  it("drops tags that are not plain releases", () => {
    expect(
      versionsBetween(
        ["refs/tags/v2.2.0-beta.1", "refs/tags/process-daemon-v0.4.0"],
        "2.1.4",
        "9.0.0",
      ),
    ).toEqual([]);
  });
});

describe("breakingChanges", () => {
  it("reads only the titles of the breaking section", () => {
    const notes = [
      "### Highlights",
      "#### not this",
      "### Breaking changes",
      "",
      "#### First",
      "text",
      "#### Second",
      "### Core",
      "#### also not this",
    ].join("\n");
    expect(breakingChanges(notes)).toEqual(["First", "Second"]);
  });

  it("reads a breaking section that ends the note, and a note without one", () => {
    expect(breakingChanges("### Breaking changes\n#### Last")).toEqual(["Last"]);
    expect(breakingChanges("### Core\n#### Nothing")).toEqual([]);
  });
});

describe("admittedSurfaceDiff", () => {
  const projection = (paths, schemas) => ({ projection: { paths, components: { schemas } } });

  it("separates missing, changed and referenced-schema drift", () => {
    const diff = admittedSurfaceDiff(
      projection(
        { "/a": { get: { x: 1 } }, "/b": { post: { x: 1 } }, "/c": { get: { x: 1 } } },
        { Same: { a: 1 }, Moved: { a: 1 }, Gone: {} },
      ),
      projection(
        { "/a": { get: { x: 1 } }, "/b": { post: { x: 2 } } },
        { Same: { a: 1 }, Moved: { a: 2 } },
      ),
    );
    expect(diff).toEqual({
      admittedCount: 3,
      missing: ["GET /c"],
      changedOperations: ["POST /b"],
      changedSchemas: ["Gone", "Moved"],
    });
  });

  it("does not read a path-level parameter list as an operation", () => {
    const diff = admittedSurfaceDiff(
      projection({ "/a": { parameters: [], get: {} } }, {}),
      projection({ "/a": { parameters: [1], get: {} } }, {}),
    );
    expect(diff.admittedCount).toBe(1);
    expect(diff.changedOperations).toEqual([]);
  });
});

describe("sourceTreeDiff", () => {
  it("classifies by path and blob identity", () => {
    expect(
      sourceTreeDiff(
        [
          { path: "keep", sha: "1" },
          { path: "edit", sha: "1" },
          { path: "drop", sha: "1" },
        ],
        [
          { path: "keep", sha: "1" },
          { path: "edit", sha: "2" },
          { path: "new", sha: "1" },
        ],
      ),
    ).toEqual({ added: ["new"], removed: ["drop"], modified: ["edit"] });
  });
});

function schemaDocument(extraPath) {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/info": { get: { operationId: "info", responses: {} } },
      ...extraPath,
    },
    components: { schemas: { "Config.InfoEncoded": { type: "object", properties: {} } } },
  };
}

function offlineFetch(routes) {
  return async (url) => {
    const body = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (body === undefined) return new globalThis.Response("missing", { status: 404 });
    return new globalThis.Response(typeof body === "string" ? body : JSON.stringify(body));
  };
}

describe("buildUpgradeReport", () => {
  it("refuses a target that is not a release after the pin", async () => {
    const deps = { fetchFn: offlineFetch({ "/git/matching-refs/tags/v": [] }) };
    await expect(buildUpgradeReport("9.9.9", deps)).rejects.toThrow("not a release after");
  });

  it("surfaces an upstream failure instead of reporting partial facts", async () => {
    const deps = { fetchFn: offlineFetch({}) };
    await expect(buildUpgradeReport("9.9.9", deps)).rejects.toThrow("answered 404");
  });

  it("renders the pin entry, the drift and the review areas from fetched facts", async () => {
    const pins = await import("../../packages/keiko-contracts/src/opencode-runtime-pins.json", {
      with: { type: "json" },
    });
    const current = pins.default.pins[0].version;
    const routes = {
      "/git/matching-refs/tags/v": [{ ref: "refs/tags/v99.0.0" }],
      [`/v${current}/packages/protocol/openapi.json`]: JSON.stringify(schemaDocument({})),
      "/v99.0.0/packages/protocol/openapi.json": JSON.stringify(
        schemaDocument({ "/api/new": { post: { operationId: "new.thing", responses: {} } } }),
      ),
      [`/commits/v${current}`]: { sha: "a".repeat(40) },
      "/commits/v99.0.0": { sha: "b".repeat(40) },
      [`/git/trees/v${current}?recursive=1`]: { tree: [], truncated: false },
      "/git/trees/v99.0.0?recursive=1": {
        tree: [
          { type: "blob", path: "packages/core/src/database/migration/20270101_x.ts", sha: "1" },
        ],
        truncated: false,
      },
      "/releases/tags/v99.0.0": { body: "### Breaking changes\n#### A real break" },
    };
    const report = await buildUpgradeReport("99.0.0", { fetchFn: offlineFetch(routes) });
    expect(report).toContain(`OpenCode upgrade report: ${current} to 99.0.0`);
    expect(report).toContain('"commit": "' + "b".repeat(40));
    expect(report).toContain("99.0.0: A real break");
    expect(report).toContain("- new.thing");
    expect(report).toContain("added packages/core/src/database/migration/20270101_x.ts");
  });

  it("refuses a truncated source tree", async () => {
    const pins = await import("../../packages/keiko-contracts/src/opencode-runtime-pins.json", {
      with: { type: "json" },
    });
    const current = pins.default.pins[0].version;
    const document = JSON.stringify(schemaDocument({}));
    const routes = {
      "/git/matching-refs/tags/v": [{ ref: "refs/tags/v99.0.0" }],
      [`/v${current}/packages/protocol/openapi.json`]: document,
      "/v99.0.0/packages/protocol/openapi.json": document,
      [`/commits/v${current}`]: { sha: "a".repeat(40) },
      "/commits/v99.0.0": { sha: "b".repeat(40) },
      [`/git/trees/v${current}?recursive=1`]: { tree: [], truncated: false },
      "/git/trees/v99.0.0?recursive=1": { tree: [], truncated: true },
      "/releases/tags/v99.0.0": { body: "" },
    };
    await expect(buildUpgradeReport("99.0.0", { fetchFn: offlineFetch(routes) })).rejects.toThrow(
      "truncated",
    );
  });
});

describe("renderUpgradeReport", () => {
  it("says none rather than leaving an empty section", () => {
    const report = renderUpgradeReport({
      from: "1.0.0",
      to: "1.0.1",
      pin: {},
      notes: [{ version: "1.0.1", breaking: [] }],
      operations: { added: [], removed: [], changed: [] },
      configuration: { added: [], removed: [] },
      admitted: { admittedCount: 0, missing: [], changedOperations: [], changedSchemas: [] },
      tree: { added: [], removed: [], modified: [] },
    });
    expect(report).toContain("## Upstream breaking changes\n\n- none");
  });
});
