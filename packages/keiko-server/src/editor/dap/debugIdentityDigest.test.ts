import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDebugRuntimeMountIdentityDigest,
  deriveDebugSpawnEnvelopeIdentityDigest,
  sha256Json,
} from "./debugIdentityDigest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "debug-identity-digest-")));
  roots.push(path);
  return path;
}

function productionSource(basename: string): string {
  return readFileSync(fileURLToPath(new URL(`./${basename}`, import.meta.url)), "utf8");
}

describe("sha256Json", () => {
  it("is exactly sha256(JSON.stringify(value)) -- the formula every call site previously re-typed", () => {
    const value = { a: 1, b: [2, 3], c: "x" };
    expect(sha256Json(value)).toBe(
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    );
  });

  it("is order-sensitive, matching JSON.stringify's own field-order sensitivity", () => {
    expect(sha256Json([1, 2, 3])).not.toBe(sha256Json([3, 2, 1]));
  });
});

describe("deriveDebugRuntimeMountIdentityDigest", () => {
  it("reproduces the exact byte-for-byte formula sha256(JSON.stringify([real, dev, ino, mode, uid]))", () => {
    const runtime = temporaryDirectory();
    const stat = lstatSync(runtime);
    const expected = createHash("sha256")
      .update(JSON.stringify([runtime, stat.dev, stat.ino, stat.mode, stat.uid]))
      .digest("hex");
    expect(deriveDebugRuntimeMountIdentityDigest(runtime, stat)).toBe(expected);
  });

  it("derives an identical digest from the producer's full Stats object and a validator's bare field record", () => {
    const runtime = temporaryDirectory();
    const stat = lstatSync(runtime);
    const fromFullStat = deriveDebugRuntimeMountIdentityDigest(runtime, stat);
    const fromBareFields = deriveDebugRuntimeMountIdentityDigest(runtime, {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
    });
    expect(fromFullStat).toBe(fromBareFields);
  });

  it("changes when any single identity field changes", () => {
    const runtime = temporaryDirectory();
    const stat = lstatSync(runtime);
    const baseline = deriveDebugRuntimeMountIdentityDigest(runtime, stat);
    const mutatedIno = {
      dev: stat.dev,
      ino: stat.ino + 1,
      mode: stat.mode,
      uid: stat.uid,
    };
    expect(deriveDebugRuntimeMountIdentityDigest(runtime, mutatedIno)).not.toBe(baseline);
    expect(deriveDebugRuntimeMountIdentityDigest(`${runtime}-other`, stat)).not.toBe(baseline);
  });
});

describe("deriveDebugSpawnEnvelopeIdentityDigest", () => {
  it("is a no-op filter when identityDigest/planId are absent -- the pre-signing call shape", () => {
    const values = { a: 1, b: 2, c: "keep" };
    expect(deriveDebugSpawnEnvelopeIdentityDigest(values)).toBe(sha256Json(values));
  });

  it("excludes identityDigest and planId so re-deriving from an already-signed envelope reproduces the same digest", () => {
    const values = { a: 1, b: 2, c: "keep" };
    const identityDigest = deriveDebugSpawnEnvelopeIdentityDigest(values);
    const signed = { ...values, planId: identityDigest, identityDigest };
    expect(deriveDebugSpawnEnvelopeIdentityDigest(signed)).toBe(identityDigest);
  });
});

describe("producer/validator formula centralization (KEIKO-0168)", () => {
  // This is the load-bearing regression guard: it is a static proof, over the real source text,
  // that the runtime-mount and spawn-envelope digest formulas are each written exactly once and
  // imported everywhere else, not independently re-typed per file. A value-level equality check
  // between call sites cannot catch this defect class -- three authors typing the identical
  // formula by hand agree on every value comparison right up until one of them is edited alone,
  // which is exactly how issue #2643 broke every Linux debug launch with the suite green.
  const producerAndValidatorFiles = [
    "debugLaunchContext.ts",
    "debugLaunchPlan.ts",
    "dapNodeCapsuleLauncher.ts",
  ] as const;

  it("no producer/validator file re-types a local generic sha256(JSON.stringify(...)) hash helper", () => {
    for (const basename of producerAndValidatorFiles) {
      const source = productionSource(basename);
      expect(source, `${basename} must not re-type a local hash()/digest() helper`).not.toMatch(
        /function (hash|digest)\(value: unknown\): string \{/u,
      );
    }
  });

  it("every producer/validator file imports the shared digest module instead", () => {
    for (const basename of producerAndValidatorFiles) {
      const source = productionSource(basename);
      expect(source, `${basename} must import from ./debugIdentityDigest.js`).toMatch(
        /from "\.\/debugIdentityDigest\.js"/u,
      );
    }
  });

  it("debugLaunchCatalog.ts's unrelated catalog-target digest also reuses the shared sha256Json instead of a local copy", () => {
    const source = productionSource("debugLaunchCatalog.ts");
    expect(source).not.toMatch(/function digest\(value: unknown\): string \{/u);
    expect(source).toMatch(/from "\.\/debugIdentityDigest\.js"/u);
  });
});
