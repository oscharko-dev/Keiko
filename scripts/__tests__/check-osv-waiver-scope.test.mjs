import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../check-osv-waiver-scope.mjs";
import {
  evaluateWaiverScope,
  osvAdvisoryIds,
  readSuppressedIds,
  shippedAdvisoryIds,
  shippedPackages,
} from "../check-osv-waiver-scope.mjs";

const TOML = `# comment
[[IgnoredVulns]]
id = "GHSA-aaaa-bbbb-cccc"
ignoreUntil = 2026-10-25T00:00:00Z
reason = """
not shipped
"""

[[IgnoredVulns]]
id = "GHSA-dddd-eeee-ffff"
reason = "second"

[SomeOtherSection]
id = "GHSA-not-a-waiver"
`;

function auditReport(ids) {
  return JSON.stringify({
    vulnerabilities: Object.fromEntries(
      ids.map((id, index) => [
        `pkg-${String(index)}`,
        { via: [{ url: `https://github.com/advisories/${id}`, title: "x" }] },
      ]),
    ),
  });
}

// A lockfile whose `packages` map holds exactly the given entries.
function lockfile(packages) {
  return JSON.stringify({ name: "keiko", lockfileVersion: 3, packages });
}

// What OSV's querybatch answers when it records the given ids against each queried package.
function osvAnswer(idsPerQuery) {
  return {
    results: idsPerQuery.map((ids) =>
      ids.length === 0
        ? {}
        : { vulns: ids.map((id) => ({ id, modified: "2026-10-02T22:45:04Z" })) },
    ),
  };
}

describe("readSuppressedIds", () => {
  it("collects every id inside IgnoredVulns blocks", () => {
    expect(readSuppressedIds(TOML)).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]);
  });

  it("ignores ids in other sections", () => {
    expect(readSuppressedIds(TOML)).not.toContain("GHSA-not-a-waiver");
  });

  it("returns nothing for a config without waivers", () => {
    expect(readSuppressedIds("# nothing here\n")).toEqual([]);
  });
});

describe("shippedAdvisoryIds", () => {
  it("extracts advisory ids from the npm audit report", () => {
    expect(shippedAdvisoryIds(auditReport(["GHSA-1111-2222-3333"]))).toEqual(
      new Set(["GHSA-1111-2222-3333"]),
    );
  });

  // An EMPTY map is the legitimate "nothing found" answer; a MISSING map means the output was not
  // an audit report at all, and must not be read as an all-clear.
  it("treats an empty vulnerabilities map as no shipped advisories", () => {
    expect(shippedAdvisoryIds(JSON.stringify({ vulnerabilities: {} }))).toEqual(new Set());
  });

  it("refuses a report with no vulnerabilities map at all", () => {
    expect(() => shippedAdvisoryIds(JSON.stringify({}))).toThrow();
  });

  it("skips string via entries without inventing an id", () => {
    const report = JSON.stringify({ vulnerabilities: { a: { via: ["some-package"] } } });
    expect(shippedAdvisoryIds(report)).toEqual(new Set());
  });
});

describe("evaluateWaiverScope", () => {
  it("passes when no suppressed advisory reaches the shipped graph", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-9999-9999-9999"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toEqual([]);
  });

  // The whole point of the gate: an ID-wide suppression must not keep hiding the advisory once it
  // appears in something Keiko actually ships.
  it("fails when a suppressed advisory reaches a shipped dependency", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-aaaa-bbbb-cccc"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("reports every violating suppression, not just the first", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toHaveLength(2);
  });
});

describe("readSuppressedIds — TOML shapes the hand-written reader must not miss", () => {
  it("reads a literal-string id", () => {
    expect(readSuppressedIds("[[IgnoredVulns]]\nid = 'GHSA-single-quoted'\n")).toEqual([
      "GHSA-single-quoted",
    ]);
  });

  it("reads an id carrying a trailing inline comment", () => {
    expect(readSuppressedIds('[[IgnoredVulns]]\nid = "GHSA-with-comment" # why\n')).toEqual([
      "GHSA-with-comment",
    ]);
  });

  it("ignores a section header written with an inline comment", () => {
    const toml =
      '[[IgnoredVulns]] # first\nid = "GHSA-aaa"\n[Other] # not a waiver\nid = "GHSA-bbb"\n';
    expect(readSuppressedIds(toml)).toEqual(["GHSA-aaa"]);
  });

  // A reason block can contain anything, including lines that look like TOML structure.
  it("never parses inside a multi-line reason block", () => {
    const toml = [
      "[[IgnoredVulns]]",
      'id = "GHSA-real"',
      'reason = """',
      "[[IgnoredVulns]]",
      'id = "GHSA-not-a-real-waiver"',
      '"""',
      "",
    ].join("\n");
    expect(readSuppressedIds(toml)).toEqual(["GHSA-real"]);
  });

  // The alternative — dropping it — would leave a suppression this gate never validates.
  it("fails closed on an id syntax it cannot decode", () => {
    expect(() => readSuppressedIds("[[IgnoredVulns]]\nid = { value = 'x' }\n")).toThrow(
      /unsupported id syntax/u,
    );
  });
});

describe("shippedAdvisoryIds — malformed audit output must not read as 'nothing shipped'", () => {
  it.each([
    ["a JSON array", "[]"],
    ["a JSON primitive", '"nope"'],
    ["JSON null", "null"],
    ["an object without a vulnerabilities map", '{"metadata":{}}'],
    ["a null vulnerabilities map", '{"vulnerabilities":null}'],
  ])("throws on %s", (_label, payload) => {
    expect(() => shippedAdvisoryIds(payload)).toThrow();
  });

  it("tolerates a malformed single advisory without losing the rest", () => {
    const report = JSON.stringify({
      vulnerabilities: {
        broken: null,
        alsoBroken: { via: "not-an-array" },
        good: { via: [{ url: "https://github.com/advisories/GHSA-good" }] },
      },
    });
    expect(shippedAdvisoryIds(report)).toEqual(new Set(["GHSA-good"]));
  });
});

// The production install the second source asks OSV about: every package `npm install --omit=dev`
// keeps, by its real registry name.
describe("shippedPackages", () => {
  it("keeps runtime, optional and devOptional installs and leaves out dev-only ones", () => {
    const lock = lockfile({
      "": { name: "keiko", version: "1.0.0" },
      "node_modules/runtime": { version: "1.0.0" },
      "node_modules/optional": { version: "2.0.0", optional: true },
      "node_modules/both": { version: "3.0.0", devOptional: true },
      "node_modules/braces": { version: "3.0.3", dev: true },
      "node_modules/tooling": { version: "4.0.0", dev: true, optional: true },
    });
    expect(shippedPackages(lock)).toEqual([
      { name: "runtime", version: "1.0.0" },
      { name: "optional", version: "2.0.0" },
      { name: "both", version: "3.0.0" },
    ]);
  });

  it("names scoped, nested and aliased installs by their registry package", () => {
    const lock = lockfile({
      "node_modules/@scope/pkg": { version: "1.0.0" },
      "node_modules/a/node_modules/@scope/inner": { version: "2.0.0" },
      "packages/app/node_modules/nested": { version: "3.0.0" },
      "node_modules/string-width-cjs": { name: "string-width", version: "4.2.3" },
    });
    expect(shippedPackages(lock)).toEqual([
      { name: "@scope/pkg", version: "1.0.0" },
      { name: "@scope/inner", version: "2.0.0" },
      { name: "nested", version: "3.0.0" },
      { name: "string-width", version: "4.2.3" },
    ]);
  });

  // No registry publishes this repository's own workspaces, so there is nothing to look up.
  it("skips workspace links and workspace sources", () => {
    const lock = lockfile({
      "node_modules/@oscharko-dev/keiko-ui": { resolved: "packages/keiko-ui", link: true },
      "packages/keiko-ui": { name: "@oscharko-dev/keiko-ui", version: "1.0.0" },
    });
    expect(shippedPackages(lock)).toEqual([]);
  });

  it("asks once for a package installed at several paths", () => {
    const lock = lockfile({
      "node_modules/shared": { version: "1.0.0" },
      "node_modules/a/node_modules/shared": { version: "1.0.0" },
      "node_modules/b/node_modules/shared": { version: "2.0.0" },
    });
    expect(shippedPackages(lock)).toEqual([
      { name: "shared", version: "1.0.0" },
      { name: "shared", version: "2.0.0" },
    ]);
  });

  // A lockfile this reader cannot fully account for must not shrink the graph it vouches for.
  it.each([
    ["a lockfile without a packages map", JSON.stringify({ lockfileVersion: 3 })],
    ["a packages list instead of a map", JSON.stringify({ packages: [] })],
    ["an entry that is not an object", lockfile({ "node_modules/x": "1.0.0" })],
    ["a shipped entry without a version", lockfile({ "node_modules/x": { resolved: "x" } })],
  ])("refuses %s", (_label, lock) => {
    expect(() => shippedPackages(lock)).toThrow(TypeError);
  });
});

describe("osvAdvisoryIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts each batch to OSV's querybatch endpoint as JSON, bounded in time", async () => {
    const requests = [];
    vi.stubGlobal("fetch", async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => osvAnswer([["GHSA-vfj7-8cjw-p6xm"]]) };
    });
    const ids = await osvAdvisoryIds([{ name: "braces", version: "3.0.3" }]);
    expect(ids).toEqual(new Set(["GHSA-vfj7-8cjw-p6xm"]));
    expect(requests).toHaveLength(1);
    const [{ url, init }] = requests;
    expect(url).toBe("https://api.osv.dev/v1/querybatch");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({
      queries: [{ package: { ecosystem: "npm", name: "braces" }, version: "3.0.3" }],
    });
    expect(init.signal).toBeInstanceOf(globalThis.AbortSignal);
  });

  it("fails closed on an HTTP error from OSV", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
    await expect(osvAdvisoryIds([{ name: "braces", version: "3.0.3" }])).rejects.toThrow(
      "OSV querybatch answered HTTP 503",
    );
  });

  it("asks OSV about each package in the npm ecosystem and collects every recorded id", async () => {
    const asked = [];
    const ids = await osvAdvisoryIds(
      [
        { name: "braces", version: "3.0.3" },
        { name: "left-pad", version: "1.3.0" },
      ],
      async (body) => {
        asked.push(body);
        return osvAnswer([["GHSA-vfj7-8cjw-p6xm", "GHSA-other"], []]);
      },
    );
    expect(asked).toEqual([
      {
        queries: [
          { package: { ecosystem: "npm", name: "braces" }, version: "3.0.3" },
          { package: { ecosystem: "npm", name: "left-pad" }, version: "1.3.0" },
        ],
      },
    ]);
    expect(ids).toEqual(new Set(["GHSA-vfj7-8cjw-p6xm", "GHSA-other"]));
  });

  it("splits a graph larger than one OSV batch and reads every batch", async () => {
    const packages = Array.from({ length: 1001 }, (_, index) => ({
      name: `pkg-${String(index)}`,
      version: "1.0.0",
    }));
    const sizes = [];
    const ids = await osvAdvisoryIds(packages, async ({ queries }) => {
      sizes.push(queries.length);
      return osvAnswer(
        queries.map((_, index) => (index === 0 ? [`GHSA-${String(sizes.length)}`] : [])),
      );
    });
    expect(sizes).toEqual([1000, 1]);
    expect(ids).toEqual(new Set(["GHSA-1", "GHSA-2"]));
  });

  it("asks nothing for an empty graph", async () => {
    let calls = 0;
    const ids = await osvAdvisoryIds([], async () => {
      calls += 1;
      return osvAnswer([]);
    });
    expect(calls).toBe(0);
    expect(ids).toEqual(new Set());
  });

  // Each of these answers could hide a suppressed id; none may read as "nothing shipped".
  it.each([
    ["an answer that is not an object", []],
    ["an answer without a results list", { results: {} }],
    ["fewer results than queries", { results: [] }],
    ["a result that is not an object", { results: [null] }],
    ["a result announcing a further page", { results: [{ vulns: [], next_page_token: "t" }] }],
    ["advisories that are not a list", { results: [{ vulns: { id: "GHSA-x" } }] }],
    ["an advisory without an id", { results: [{ vulns: [{ modified: "2026-10-02" }] }] }],
  ])("refuses %s", async (_label, answer) => {
    await expect(
      osvAdvisoryIds([{ name: "braces", version: "3.0.3" }], async () => answer),
    ).rejects.toThrow(/OSV querybatch/u);
  });
});

// The gate's decision paths, driven through the exported entry point. Each one is a distinct answer
// the gate can give, and each one is the answer a real osv-scanner.toml can force.
describe("the waiver-scope gate decision", () => {
  const logs = [];
  const errors = [];
  const capture = {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };

  // Neither source places anything in the shipped graph unless a test says so.
  const clean = {
    configExists: () => true,
    runAudit: () => JSON.stringify({ vulnerabilities: {} }),
    readLockfile: () => lockfile({ "node_modules/runtime": { version: "1.0.0" } }),
    queryOsv: async () => new Set(),
  };

  async function run(overrides) {
    logs.length = 0;
    errors.length = 0;
    const exits = [];
    const original = { error: console.error, log: console.log };
    console.log = capture.log;
    console.error = capture.error;
    try {
      await main({ exit: (code) => exits.push(code), ...overrides });
    } finally {
      console.log = original.log;
      console.error = original.error;
    }
    return { errors: [...errors], exits, logs: [...logs] };
  }

  it("passes when no configuration file exists", async () => {
    const result = await run({ configExists: () => false });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("no osv-scanner.toml");
  });

  it("passes when the configuration records no suppression", async () => {
    const result = await run({ configExists: () => true, readConfig: () => "# nothing here\n" });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("no suppressions recorded");
  });

  it("passes when a suppression covers only build-time dependencies", async () => {
    const result = await run({
      ...clean,
      readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-build-only"\n',
    });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("1 suppression(s), none reaching the shipped graph");
  });

  it("fails when a suppression reaches the shipped graph", async () => {
    const result = await run({
      ...clean,
      readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-shipped"\n',
      runAudit: () =>
        JSON.stringify({
          vulnerabilities: {
            "some-package": {
              via: [{ source: 1, url: "https://github.com/advisories/GHSA-shipped" }],
            },
          },
        }),
    });
    expect(result.exits).toEqual([1]);
    expect(result.errors.join("\n")).toContain("GHSA-shipped is suppressed");
    expect(result.errors.join("\n")).toContain("reaches a SHIPPED");
  });

  // PR #3679: npm's audit feed had not yet listed two advisories GitHub reviewed and OSV reported
  // the same evening, so a waiver for either was vouched for by a source that could not see it.
  it("fails when only OSV places a suppressed advisory in the shipped graph", async () => {
    const asked = [];
    const result = await run({
      ...clean,
      readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-vfj7-8cjw-p6xm"\n',
      readLockfile: () =>
        lockfile({
          "node_modules/braces": { version: "3.0.3" },
          "node_modules/tooling": { version: "1.0.0", dev: true },
        }),
      queryOsv: async (packages) => {
        asked.push(packages);
        return new Set(["GHSA-vfj7-8cjw-p6xm"]);
      },
    });
    expect(asked).toEqual([[{ name: "braces", version: "3.0.3" }]]);
    expect(result.exits).toEqual([1]);
    expect(result.errors.join("\n")).toContain("GHSA-vfj7-8cjw-p6xm is suppressed");
  });

  it("fails closed when OSV cannot answer", async () => {
    await expect(
      run({
        ...clean,
        readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-build-only"\n',
        queryOsv: async () => {
          throw new Error("OSV querybatch answered HTTP 503");
        },
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
