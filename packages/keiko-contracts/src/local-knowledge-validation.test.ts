// Dedup guard for the shared allowlist-key validator (audit KEIKO-0530).
//
// Four copies of the same "reject any object key outside an explicit allowlist" check used to
// exist across packages/keiko-contracts/src/: the canonical `validateOnlyKeys` below, plus three
// private `onlyKeys` copies in local-knowledge-pods.ts, local-knowledge-retrieval-activity.ts, and
// local-knowledge-model-use-policy.ts. Two of the three siblings now import the canonical function
// directly (aliased to `onlyKeys` so their call sites — arity and argument order — read unchanged).
//
// local-knowledge-model-use-policy.ts keeps a private copy instead of importing the canonical one.
// This file already imports `validateKnowledgePodModelUsePolicy` (a value import, not `import
// type`) from local-knowledge-model-use-policy.ts to validate a capsule's nested modelUsePolicy
// field, so an import running the other way — local-knowledge-model-use-policy.ts pulling
// `validateOnlyKeys` from here — would close a two-file circular module dependency. That risk is
// real, not theoretical: dependency-cruiser's config in this repo has no default rule set to catch
// it (`.dependency-cruiser.cjs` defines `forbidden` from scratch, with no `circular: true` rule),
// so nothing else in the gate surface would flag a cycle introduced here.
//
// This suite pins the resulting three-way split mechanically (source greps, so a future edit that
// silently reintroduces a fourth copy or removes the exemption's precondition fails loudly) and
// behaviorally (the retained private copy is exercised through its real production entry point and
// must still agree with the canonical implementation on the exact rejection message).

import { describe, expect, expectTypeOf, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateConnectorGraphState,
  validateKnowledgeCapsule,
  validateOnlyKeys,
  type LocalKnowledgeValidation,
} from "./local-knowledge-validation.js";
import {
  standardPodModelUsePolicy,
  validateKnowledgePodModelUsePolicy,
} from "./local-knowledge-model-use-policy.js";

import {
  validateConnectorGraphState as publicValidateGraph,
  validateKnowledgeCapsule as publicValidateKnowledgeCapsule,
  type LocalKnowledgeValidation as PublicKnowledgeValidation,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-validation";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, ".");

const CANONICAL_FILE = "local-knowledge-validation.ts";
// Deduped onto the canonical export — must define no allowlist-key validator of their own.
const DEDUPED_SIBLINGS = [
  "local-knowledge-pods.ts",
  "local-knowledge-retrieval-activity.ts",
] as const;
// The sole holdout: keeps a private copy because merging it would create a circular import (see
// file header). Any *other* file defining a competing copy is still a regression.
const EXEMPT_SIBLING = "local-knowledge-model-use-policy.ts";

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "dist") continue;
      results.push(...collectTsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

function readSource(fileName: string): string {
  return readFileSync(resolve(HERE, fileName), "utf8");
}

function onlyKeysDefinitionLines(source: string): string[] {
  return source
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("function onlyKeys") || line.startsWith("function validateOnlyKeys"),
    );
}

describe("validateOnlyKeys is the single canonical allowlist-key validator", () => {
  it("local-knowledge-validation.ts exports exactly one canonical definition", () => {
    const source = readSource(CANONICAL_FILE);
    const exportedLines = source
      .split("\n")
      .filter((line) => line.startsWith("export function validateOnlyKeys"));
    expect(exportedLines).toHaveLength(1);
    // And nothing in this file also defines an un-exported shadow of it.
    expect(onlyKeysDefinitionLines(source)).toHaveLength(0);
  });

  it.each(DEDUPED_SIBLINGS)(
    "%s no longer defines its own onlyKeys/validateOnlyKeys",
    (fileName) => {
      const source = readSource(fileName);
      expect(onlyKeysDefinitionLines(source)).toEqual([]);
    },
  );

  it.each(DEDUPED_SIBLINGS)("%s imports the canonical validateOnlyKeys as onlyKeys", (fileName) => {
    const source = readSource(fileName);
    expect(source).toMatch(/validateOnlyKeys as onlyKeys/);
    expect(source).toMatch(/}\s*from\s*"\.\/local-knowledge-validation\.js";/s);
  });

  it("no other source file in this package defines a competing onlyKeys/validateOnlyKeys", () => {
    const otherFiles = collectTsFiles(SRC_DIR)
      .map((path) => path.slice(SRC_DIR.length + 1))
      .filter((name) => name !== CANONICAL_FILE && name !== EXEMPT_SIBLING)
      .filter((name) => !(DEDUPED_SIBLINGS as readonly string[]).includes(name));

    for (const fileName of otherFiles) {
      expect(onlyKeysDefinitionLines(readSource(fileName))).toEqual([]);
    }
  });

  it(
    "local-knowledge-model-use-policy.ts stays the sole exception, and only while the " +
      "circular-import precondition holds",
    () => {
      // Still keeps its own copy today...
      expect(onlyKeysDefinitionLines(readSource(EXEMPT_SIBLING))).toHaveLength(1);

      // ...specifically because local-knowledge-validation.ts still imports
      // validateKnowledgePodModelUsePolicy (a value import) from it. If that import is ever
      // removed or turned into a type-only import, the circular-import justification disappears
      // and this file should be deduped onto validateOnlyKeys like its two siblings above.
      const validationSource = readSource(CANONICAL_FILE);
      expect(validationSource).toMatch(
        /import \{ validateKnowledgePodModelUsePolicy \} from "\.\/local-knowledge-model-use-policy\.js";/,
      );
    },
  );

  it("the retained private copy still implements the exact canonical algorithm", () => {
    const canonicalErrors: string[] = [];
    validateOnlyKeys(
      { allowedKey: 1, unexpectedKey: 2 },
      ["allowedKey"],
      "modelUsePolicy",
      canonicalErrors,
    );
    expect(canonicalErrors).toEqual(["modelUsePolicy must not include unexpectedKey"]);

    // Exercised through the real production entry point (AGENTS.md §7: never restate the formula
    // under test), not a re-typed expectation of what the private copy "should" do.
    const result = validateKnowledgePodModelUsePolicy({
      ...standardPodModelUsePolicy(),
      unexpectedKey: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid model-use policy");
    expect(result.errors).toEqual(["modelUsePolicy must not include unexpectedKey"]);
  });
});

function capsuleInput(): Record<string, unknown> {
  // Existing happyCapsule data shape from local-knowledge.test.ts:75; no ID cast.
  // Both lineage strings acquire only the parser's actual nominal separation.
  return {
    id: "cap-1",
    displayName: "Risk Controls Library",
    tags: ["compliance"],
    sourceIds: ["src-1"],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    lifecycleState: "ready",
    embeddingModelIdentity: {
      provider: "keiko",
      modelId: "embed-1",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    storageReference: "capsules/cap-1",
    createdAt: 1,
    updatedAt: 2,
  };
}

for (const [name, validate] of [
  ["source", validateKnowledgeCapsule],
  ["public", publicValidateKnowledgeCapsule],
] as const) {
  describe(`${name} optional alwaysQuery admission`, () => {
    it.each(["yes", 1, null, {}, []])("rejects nonboolean %j", (alwaysQuery) => {
      const input = { ...capsuleInput(), alwaysQuery };
      expect(validate(input)).toEqual({
        ok: false,
        errors: ["capsule.alwaysQuery must be a boolean when set"],
      });
    });
    it.each(["omitted", "own-undefined", "true", "false"] as const)("preserves %s", (state) => {
      const input = capsuleInput();
      if (state !== "omitted")
        input.alwaysQuery = state === "own-undefined" ? undefined : state === "true";
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.embeddingModelIdentity).toBe(input.embeddingModelIdentity);
      expect(Object.hasOwn(result.value, "alwaysQuery")).toBe(state !== "omitted");
      expect(result.value.alwaysQuery).toBe(
        state === "true" ? true : state === "false" ? false : undefined,
      );
    });
  });
}

for (const [entry, validate] of [
  ["source", validateConnectorGraphState],
  ["public", publicValidateGraph],
] as const) {
  describe(`${entry} current graph endpoint admission`, () => {
    it.each([undefined, null, 1])("refuses endpoint substituted with %j", (replacement) => {
      let reads = 0;
      const endpoint = { nodeId: "n1", kind: "conversation-center" };
      const edge = {
        get from(): unknown {
          reads += 1;
          return reads === 1 ? endpoint : replacement;
        },
        to: endpoint,
        createdAt: 1,
      };
      const input = {
        schemaVersion: "1",
        nodes: [{ kind: "conversation-center", nodeId: "n1", conversationId: "c1", route: "chat" }],
        edges: [edge],
        updatedAt: 1,
      };
      expect(validate(input)).toEqual({
        ok: false,
        errors: ["graph.edges entry must have from/to objects"],
      });
      expect(reads).toBe(2);
    });
    it("preserves healthy repeated endpoint references", () => {
      let reads = 0;
      const endpoint = { nodeId: "n1", kind: "conversation-center" };
      const edge = {
        get from(): unknown {
          reads += 1;
          return endpoint;
        },
        to: endpoint,
        createdAt: 1,
      };
      const input = {
        schemaVersion: "1",
        nodes: [{ kind: "conversation-center", nodeId: "n1", conversationId: "c1", route: "chat" }],
        edges: [edge],
        updatedAt: 1,
      };
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.edges[0]).toBe(edge);
      expect(reads).toBe(2);
    });
  });
}

for (const [entry, validate] of [
  ["source", validateKnowledgeCapsule],
  ["public", publicValidateKnowledgeCapsule],
] as const) {
  describe(`${entry} physical capsule array admission`, () => {
    it.each(["tags", "sourceIds"] as const)("refuses hidden malformed %s positions", (field) => {
      const members = [42];
      Object.defineProperty(members, Symbol.iterator, {
        value: function* () {
          yield "healthy";
        },
      });
      const result = validate({ ...capsuleInput(), [field]: members });
      expect(result.ok).toBe(false);
    });
    it.each(["tags", "sourceIds"] as const)("refuses sparse %s positions", (field) => {
      const members = new Array<unknown>(1);
      expect(validate({ ...capsuleInput(), [field]: members }).ok).toBe(false);
    });
    it.each(["tags", "sourceIds"] as const)("admits inherited healthy %s positions", (field) => {
      const members = new Array<unknown>(1);
      Object.setPrototypeOf(members, ["healthy"]);
      const input = { ...capsuleInput(), [field]: members };
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[field]).toBe(members);
    });
    it.each(["tags", "sourceIds"] as const)("preserves healthy %s positions", (field) => {
      const members = ["healthy"];
      const input = { ...capsuleInput(), [field]: members };
      const result = validate(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value[field]).toBe(members);
    });
  });
}

type CapsuleAny<T> = 0 extends 1 & T ? true : false;
import type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  KnowledgeCapsule as PublicKnowledgeCapsule,
} from "@oscharko-dev/keiko-contracts";

function consumePublicCapsule(input: unknown): void {
  const result = publicValidateKnowledgeCapsule(input);
  if (result.ok) {
    const id: KnowledgeCapsuleId = result.value.id;
    const sourceIds: readonly KnowledgeSourceId[] = result.value.sourceIds;
    const optional: boolean | undefined = result.value.alwaysQuery;
    const dimensions: number = result.value.embeddingModelIdentity.vectorDimensions;
    const metric: "cosine" | "euclidean" | "dot" = result.value.embeddingModelIdentity.vectorMetric;
    const _concrete: CapsuleAny<typeof result.value> = false;
    const _concreteOptional: CapsuleAny<typeof result.value.alwaysQuery> = false;
    // @ts-expect-error Capsule and source phantom IDs must stay distinct.
    const _sourceId: KnowledgeSourceId = result.value.id;
    expect(result.value).toBe(input);
    expect(id).toBe("cap-1");
    expect(sourceIds).toEqual(["src-1"]);
    expect(optional).toBeUndefined();
    expect(dimensions).toBe(1536);
    expect(metric).toBe("cosine");
  }
}

it("public capsule consumer retains primitives and nominal separation after revalidation", () => {
  const input = capsuleInput();
  consumePublicCapsule(input);
  input.alwaysQuery = 42;
  expect(publicValidateKnowledgeCapsule(input).ok).toBe(false);
});

for (const [entry, validate] of [
  ["source", validateKnowledgeCapsule],
  ["public", publicValidateKnowledgeCapsule],
] as const) {
  describe(`${entry} bounded capsule array growth`, () => {
    it.each(["tags", "sourceIds"] as const)("refuses malformed appended %s member", (field) => {
      const members: unknown[] = ["healthy"];
      Object.defineProperty(members, "0", {
        get(): string {
          members.push(42);
          return "healthy";
        },
      });
      expect(validate({ ...capsuleInput(), [field]: members }).ok).toBe(false);
    });
  });
}

export function parsePublicKnowledgeCapsule(
  input: unknown,
): PublicKnowledgeValidation<PublicKnowledgeCapsule> {
  const result = publicValidateKnowledgeCapsule(input);
  return result;
}

describe("Knowledge capsule public responsibility (#3918)", () => {
  it("pins exact unknown inputs checked results and nested declarations", () => {
    expectTypeOf(validateKnowledgeCapsule).parameter(0).toBeUnknown();
    expectTypeOf(publicValidateKnowledgeCapsule).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicKnowledgeCapsule).parameter(0).toBeUnknown();
    expectTypeOf(validateKnowledgeCapsule).parameter(0).not.toBeAny();
    expectTypeOf(publicValidateKnowledgeCapsule).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicKnowledgeCapsule).parameter(0).not.toBeAny();
    expectTypeOf(validateKnowledgeCapsule).returns.toEqualTypeOf<
      LocalKnowledgeValidation<SourceKnowledgeCapsule>
    >();
    expectTypeOf(validateKnowledgeCapsule).returns.not.toBeAny();
    expectTypeOf(publicValidateKnowledgeCapsule).returns.toEqualTypeOf<
      PublicKnowledgeValidation<PublicKnowledgeCapsule>
    >();
    expectTypeOf(parsePublicKnowledgeCapsule).returns.toEqualTypeOf<
      PublicKnowledgeValidation<PublicKnowledgeCapsule>
    >();
    expectTypeOf(publicValidateKnowledgeCapsule).returns.not.toBeAny();
    expectTypeOf(parsePublicKnowledgeCapsule).returns.not.toBeAny();
    const result = parsePublicKnowledgeCapsule(capsuleInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<PublicKnowledgeCapsule>();
      expectTypeOf(result.value).not.toBeAny();
      expectTypeOf(result.value).not.toBeUnknown();
      expectTypeOf(result.value.id).not.toBeAny();
      expectTypeOf(result.value.id).not.toBeUnknown();
      expectTypeOf(result.value.sourceIds).not.toBeAny();
      expectTypeOf(result.value.sourceIds).not.toBeUnknown();
      expectTypeOf(result.value.embeddingModelIdentity).not.toBeAny();
      expectTypeOf(result.value.embeddingModelIdentity).not.toBeUnknown();
      expectTypeOf(result.value.embeddingModelIdentity.vectorDimensions).not.toBeAny();
      expectTypeOf(result.value.embeddingModelIdentity.vectorDimensions).not.toBeUnknown();
      expectTypeOf(result.value.alwaysQuery).not.toBeAny();
      expectTypeOf(result.value.alwaysQuery).not.toBeUnknown();
    }
  });
});

describe("Knowledge capsule public responsibility (#3918)", () => {
  it("preserves admitted identity optional presence and nested references", () => {
    for (const state of ["omitted", "undefined", "true", "false"]) {
      const input = capsuleInput();
      if (state !== "omitted")
        input.alwaysQuery = state === "undefined" ? undefined : state === "true";
      const result = parsePublicKnowledgeCapsule(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(input);
      expect(result.value.sourceIds).toBe(input.sourceIds);
      expect(result.value.embeddingModelIdentity).toBe(input.embeddingModelIdentity);
      expect(Object.hasOwn(result.value, "alwaysQuery")).toBe(state !== "omitted");
      expect(result.value.alwaysQuery).toBe(input.alwaysQuery);
    }
  });
  it("refuses malformed concrete fields and physical collection members", () => {
    for (const input of [
      null,
      [],
      { ...capsuleInput(), displayName: "" },
      { ...capsuleInput(), metadata: { fixture: 1 } },
      { ...capsuleInput(), sourceIds: [0] },
      { ...capsuleInput(), tags: new Array<unknown>(1) },
      { ...capsuleInput(), embeddingModelIdentity: {} },
      { ...capsuleInput(), alwaysQuery: "yes" },
      { ...capsuleInput(), createdAt: Number.NaN },
    ])
      expect(parsePublicKnowledgeCapsule(input).ok).toBe(false);
  });
});

import type { KnowledgeCapsule as SourceKnowledgeCapsule } from "./local-knowledge.js";
