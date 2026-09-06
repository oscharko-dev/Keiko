import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildToolCatalogConsumerReports,
  inspectToolCatalogQualificationPackage,
  readToolCatalogQualificationObservations,
} from "../qualify-tool-catalog-consumers.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";
import {
  TOOL_CATALOG_QUALIFICATION_COMPONENTS,
  TOOL_CATALOG_QUALIFICATION_PACKAGES,
  validToolCatalogQualificationOutcome,
} from "../lib/tool-catalog-qualification-observation.mjs";

const roots = [];
const HEAD = "a".repeat(40);
const DIGEST = "b".repeat(64);
const BINDING = {
  catalogRevision: "c".repeat(64),
  profile: { id: "fixture", version: 1 },
  projectionDigest: "d".repeat(64),
  handlerSetDigest: "e".repeat(64),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-catalog-consumers-"));
  roots.push(root);
  for (const [consumer, components] of Object.entries(TOOL_CATALOG_QUALIFICATION_COMPONENTS)) {
    for (const component of components) {
      const unavailable = component === "cli" || component === "server" || component === "sdk";
      const managed = component === "managed-opencode";
      const terminalStatus = unavailable ? "unavailable" : "completed";
      writeFileSync(
        join(root, `${consumer}.${component}.observation.json`),
        JSON.stringify({
          schemaVersion: 1,
          sourceHead: HEAD,
          consumer,
          component,
          binding: BINDING,
          terminalStatus,
          settlementCount: managed ? 7 : unavailable ? 0 : 1,
          proof: managed
            ? {
                kind: "managed-search-read",
                searchSettled: true,
                boundedReadSettled: true,
                causalHandoff: true,
              }
            : { kind: unavailable ? "closed-unavailable" : "single-settlement" },
        }),
      );
    }
  }
  return root;
}

function packagedFixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-catalog-package-source-"));
  const stage = mkdtempSync(join(tmpdir(), "keiko-catalog-package-stage-"));
  roots.push(root, stage);
  const packageRoot = join(stage, "package");
  const vendorRoot = join(packageRoot, "vendor");
  mkdirSync(vendorRoot, { recursive: true });
  const dependencies = {};
  const names = new Set(Object.values(TOOL_CATALOG_QUALIFICATION_PACKAGES).flat());
  for (const name of names) {
    const directory = name.slice("@oscharko-dev/".length);
    const sourceDist = join(root, "packages", directory, "dist");
    mkdirSync(sourceDist, { recursive: true });
    writeFileSync(
      join(sourceDist, "index.js"),
      `export const packageName = ${JSON.stringify(name)};\n`,
    );
    if (directory === "keiko-server") {
      mkdirSync(join(sourceDist, "store"), { recursive: true });
      writeFileSync(join(sourceDist, "store", "example.js"), "export const nested = true;\n");
      writeFileSync(join(sourceDist, "store-fingerprints.js"), "export const sibling = true;\n");
    }
    const nested = join(stage, `nested-${directory}`, "package");
    mkdirSync(join(nested, "dist"), { recursive: true });
    writeFileSync(join(nested, "dist", "index.js"), readFileSync(join(sourceDist, "index.js")));
    if (directory === "keiko-server") {
      mkdirSync(join(nested, "dist", "store"), { recursive: true });
      writeFileSync(
        join(nested, "dist", "store", "example.js"),
        readFileSync(join(sourceDist, "store", "example.js")),
      );
      writeFileSync(
        join(nested, "dist", "store-fingerprints.js"),
        readFileSync(join(sourceDist, "store-fingerprints.js")),
      );
    }
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name, version: "0.3.17" }));
    const archiveName = `${directory}.tgz`;
    execFileSync(resolveHostExecutable("tar"), ["-czf", join(vendorRoot, archiveName), "package"], {
      cwd: join(stage, `nested-${directory}`),
    });
    dependencies[name] = `file:vendor/${archiveName}`;
  }
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version: "0.3.17", dependencies }),
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version: "0.3.17" }),
  );
  const artifact = join(stage, "keiko.tgz");
  execFileSync(resolveHostExecutable("tar"), ["-czf", artifact, "package"], { cwd: stage });
  return { root, artifact };
}

describe("tool catalog consumer qualification", () => {
  it("rejects a valid proof shape assigned to the wrong production component", () => {
    expect(
      validToolCatalogQualificationOutcome("editor", "unavailable", 0, {
        kind: "closed-unavailable",
      }),
    ).toBe(false);
  });

  it("retains every exact production component in the grouped report counts", () => {
    const observations = readToolCatalogQualificationObservations(fixture(), HEAD);
    const reports = buildToolCatalogConsumerReports({
      currentHead: HEAD,
      artifactDigest: DIGEST,
      platform: "darwin-arm64",
      runtime: { node: "26.3.0", product: "0.3.17" },
      observations,
      packageEvidence: new Map(
        Object.entries(TOOL_CATALOG_QUALIFICATION_PACKAGES).map(([consumer, packages]) => [
          consumer,
          packages.map((name) => ({
            name,
            archiveDigest: DIGEST,
            fileCount: 1,
            filesDigest: DIGEST,
          })),
        ]),
      ),
    });
    expect(reports.get("native-harness-gateway")).toMatchObject({ passed: 1, binding: BINDING });
    expect(reports.get("cli-server-sdk")).toMatchObject({ passed: 3, binding: BINDING });
    expect(reports.get("managed-opencode")?.executionKind).toBe("real-runtime");
    expect(reports.get("editor")?.components).toEqual([
      {
        component: "editor",
        terminalStatus: "completed",
        settlementCount: 1,
        proof: { kind: "single-settlement" },
      },
    ]);
  });

  it("rejects missing, unknown, stale, divergent and noncanonical observations", () => {
    const mutations = [
      (root) => rmSync(join(root, "cli-server-sdk.sdk.observation.json")),
      (root) => writeFileSync(join(root, "unknown.observation.json"), "{}"),
      (root) => update(root, "editor.editor", { sourceHead: "f".repeat(40) }),
      (root) =>
        update(root, "cli-server-sdk.sdk", {
          binding: { ...BINDING, handlerSetDigest: "f".repeat(64) },
        }),
      (root) =>
        update(root, "cli-server-sdk.sdk", {
          binding: { ...BINDING, rawPath: "/private/workspace" },
        }),
      (root) => update(root, "read-only-child.read-only-child", { settlementCount: 0 }),
      (root) =>
        update(root, "managed-opencode.managed-opencode", {
          proof: {
            kind: "managed-search-read",
            searchSettled: true,
            boundedReadSettled: true,
            causalHandoff: false,
          },
        }),
      (root) =>
        update(root, "managed-opencode.managed-opencode", {
          proof: {
            kind: "managed-search-read",
            searchSettled: true,
            boundedReadSettled: true,
            causalHandoff: true,
            prompt: "raw",
          },
        }),
    ];
    for (const mutate of mutations) {
      const root = fixture();
      mutate(root);
      expect(() => readToolCatalogQualificationObservations(root, HEAD)).toThrow(TypeError);
    }
  });

  it("binds each consumer to byte-identical built files inside the staged package", () => {
    const packaged = packagedFixture();
    const evidence = inspectToolCatalogQualificationPackage(packaged.root, packaged.artifact);
    expect(evidence.get("cli-server-sdk")?.map((entry) => entry.name)).toEqual(
      TOOL_CATALOG_QUALIFICATION_PACKAGES["cli-server-sdk"],
    );
    writeFileSync(
      join(packaged.root, "packages", "keiko-server", "dist", "index.js"),
      "export const stale = true;\n",
    );
    expect(() => inspectToolCatalogQualificationPackage(packaged.root, packaged.artifact)).toThrow(
      "packaged dist bytes are stale",
    );
  });
});

function update(root, name, mutation) {
  const path = join(root, `${name}.observation.json`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...value, ...mutation }));
}
