import { describe, expect, it } from "vitest";

import {
  CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
  CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
  CODE_TASK_EVIDENCE_CLASSES,
  CODE_TASK_EVIDENCE_PLATFORMS,
  codeTaskAcceptanceQualificationFailures,
  hasInheritedEnumerableProperty,
  isCodeTaskContentFreeNote,
  isCodeTaskIsoInstant,
  isCodeTaskRepoRelativePath,
  validateCodeTaskAcceptanceContribution,
  type CodeTaskAcceptanceBinding,
  type CodeTaskAcceptanceContributionV1,
} from "./code-task-acceptance.js";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

function validContribution(): CodeTaskAcceptanceContributionV1 {
  const parsed: unknown = JSON.parse(
    JSON.stringify({
      kind: CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
      schemaVersion: CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
      epicIssue: 2384,
      childIssue: 2385,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      scenarios: [
        {
          scenarioId: "opencode-tracer-edit-verify",
          evidenceClass: "playwright-journey",
          platform: "linux-x64",
          outcome: "passed",
          recordedAt: "2026-07-16T12:00:00Z",
          artifactDigests: [DIGEST],
          receiptDigest: { outcome: "known", value: DIGEST },
        },
      ],
      salvage: [
        {
          sourceBranch: "codex/archive-1982-2376-production-runtime-host",
          sourceSha: COMMIT_SHA,
          path: "packages/keiko-server/src/coding-runtime/productionCodingRuntimeHost.ts",
          disposition: "reshaped",
          reshaping: { outcome: "known", value: "rebound onto the extracted host ports" },
          verifiedAtSha: COMMIT_SHA,
        },
      ],
      knownLimitations: ["packaged-platform activation stays fail-closed"],
      cleanup: { state: "complete" },
    }),
  );
  const result = validateCodeTaskAcceptanceContribution(parsed);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function mutated(patch: Record<string, unknown>): unknown {
  return { ...validContribution(), ...patch };
}

describe("validateCodeTaskAcceptanceContribution", () => {
  it("accepts a complete JSON-round-tripped contribution", () => {
    const result = validateCodeTaskAcceptanceContribution(validContribution());
    expect(result.ok).toBe(true);
  });

  it("rejects non-object payloads", () => {
    for (const value of [undefined, null, "contribution", 7, []]) {
      expect(validateCodeTaskAcceptanceContribution(value).ok).toBe(false);
    }
  });

  it("rejects a wrong kind and a non-literal schema version", () => {
    expect(validateCodeTaskAcceptanceContribution(mutated({ kind: "other" })).ok).toBe(false);
    expect(validateCodeTaskAcceptanceContribution(mutated({ schemaVersion: "1" })).ok).toBe(false);
    expect(validateCodeTaskAcceptanceContribution(mutated({ schemaVersion: 2 })).ok).toBe(false);
  });

  it("rejects malformed issue numbers and git identities", () => {
    for (const patch of [
      { epicIssue: 0 },
      { childIssue: -5 },
      { childIssue: 1.5 },
      { sourceCommitSha: COMMIT_SHA.slice(1) },
      { sourceCommitSha: COMMIT_SHA.toUpperCase() },
      { sourceTreeSha: "not-a-sha" },
    ]) {
      expect(validateCodeTaskAcceptanceContribution(mutated(patch)).ok).toBe(false);
    }
  });

  it("rejects malformed scenarios across the input space", () => {
    const base = validContribution().scenarios[0] as unknown as Record<string, unknown>;
    for (const patch of [
      { scenarioId: "Bad_Upper" },
      { scenarioId: "x" },
      { evidenceClass: "manual-only" },
      { platform: "linux-arm64" },
      { outcome: "skipped" },
      { recordedAt: "2026-07-16 12:00:00" },
      { recordedAt: "2026-13-40T12:00:00Z" },
      { artifactDigests: [DIGEST.slice(2)] },
      { artifactDigests: "none" },
      { receiptDigest: { outcome: "known", value: "short" } },
      { receiptDigest: { outcome: "unknown", value: DIGEST } },
      { receiptDigest: { outcome: "guessed" } },
      // KEIKO-0302 follow-on: factErrors closed the OUTER contribution keys but never the fact
      // object's own keys, so a well-formed known fact padded with an extra field (e.g. free text
      // riding alongside a valid digest) was accepted and returned verbatim.
      { receiptDigest: { outcome: "known", value: DIGEST, promptText: "leak me" } },
      { receiptDigest: { outcome: "unknown", promptText: "leak me" } },
    ]) {
      const result = validateCodeTaskAcceptanceContribution(
        mutated({ scenarios: [{ ...base, ...patch }] }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects malformed salvage rows", () => {
    const base = validContribution().salvage[0] as unknown as Record<string, unknown>;
    for (const patch of [
      { sourceBranch: "" },
      { sourceBranch: `token ${"x".repeat(10)}` },
      { sourceSha: "zz" },
      { path: "/etc/passwd" },
      { path: "../outside.ts" },
      { path: "a/../../b" },
      { path: "C:\\repo\\file.ts" },
      { disposition: "copied" },
      { reshaping: { outcome: "known", value: "" } },
      { reshaping: { outcome: "known", value: "rebound", promptText: "leak me" } },
      { reshaping: { outcome: "absent", promptText: "leak me" } },
      { verifiedAtSha: "1234" },
    ]) {
      const result = validateCodeTaskAcceptanceContribution(
        mutated({ salvage: [{ ...base, ...patch }] }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects content-bearing limitation notes and invalid cleanup states", () => {
    for (const patch of [
      { knownLimitations: ["x".repeat(201)] },
      { knownLimitations: ["api_key=abc123"] },
      { knownLimitations: "none" },
      { cleanup: { state: "complete", residueCount: 1 } },
      { cleanup: { state: "incomplete" } },
      { cleanup: { state: "incomplete", residueCount: 0 } },
      { cleanup: { state: "done" } },
    ]) {
      expect(validateCodeTaskAcceptanceContribution(mutated(patch)).ok).toBe(false);
    }
  });

  it("reports every field error instead of stopping at the first", () => {
    const result = validateCodeTaskAcceptanceContribution(
      mutated({ epicIssue: 0, sourceTreeSha: "bad", cleanup: { state: "done" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("codeTaskAcceptanceQualificationFailures", () => {
  const binding: CodeTaskAcceptanceBinding = {
    epicIssue: 2384,
    childIssue: 2385,
    sourceCommitSha: COMMIT_SHA,
    registeredScenarioIds: ["opencode-tracer-edit-verify"],
  };

  it("passes a bound, registered, cleaned contribution", () => {
    expect(codeTaskAcceptanceQualificationFailures(validContribution(), binding)).toEqual([]);
  });

  it("fails an empty contribution", () => {
    const empty = { ...validContribution(), scenarios: [] };
    expect(codeTaskAcceptanceQualificationFailures(empty, binding)).toContain(
      "empty contribution: at least one scenario is required",
    );
  });

  it("fails foreign issue bindings and stale SHA bindings", () => {
    const contribution = validContribution();
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, { ...binding, epicIssue: 1982 }),
    ).toContain("foreign epic issue binding");
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, { ...binding, childIssue: 2386 }),
    ).toContain("foreign child issue binding");
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, {
        ...binding,
        sourceCommitSha: TREE_SHA,
      }),
    ).toContain("stale or foreign source SHA binding");
  });

  it("fails unregistered scenarios and incomplete cleanup", () => {
    const contribution = validContribution();
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, {
        ...binding,
        registeredScenarioIds: [],
      }),
    ).toContain("unregistered scenario: opencode-tracer-edit-verify");
    const incomplete: CodeTaskAcceptanceContributionV1 = {
      ...contribution,
      cleanup: { state: "incomplete", residueCount: 2 },
    };
    expect(codeTaskAcceptanceQualificationFailures(incomplete, binding)).toContain(
      "incomplete cleanup: 2 residues",
    );
  });
});

describe("code task acceptance primitives", () => {
  it("keeps the closed evidence-class and platform registers stable", () => {
    expect(CODE_TASK_EVIDENCE_CLASSES).toContain("production-functional");
    expect(CODE_TASK_EVIDENCE_CLASSES).toContain("packaged-computer-use");
    expect(CODE_TASK_EVIDENCE_PLATFORMS).toEqual([
      "windows-x64",
      "macos-arm64",
      "macos-x64",
      "linux-x64",
    ]);
  });

  it("validates ISO instants strictly", () => {
    expect(isCodeTaskIsoInstant("2026-07-16T12:00:00.123Z")).toBe(true);
    expect(isCodeTaskIsoInstant("2026-07-16T12:00:00+02:00")).toBe(false);
    expect(isCodeTaskIsoInstant("2026-02-30T12:00:00Z")).toBe(false);
  });

  it("rejects hostile paths and content-bearing notes", () => {
    expect(isCodeTaskRepoRelativePath("packages/keiko-contracts/src/index.ts")).toBe(true);
    expect(isCodeTaskRepoRelativePath("/absolute")).toBe(false);
    expect(isCodeTaskRepoRelativePath("nested/..")).toBe(false);
    expect(isCodeTaskContentFreeNote("bounded qualification note")).toBe(true);
    expect(isCodeTaskContentFreeNote("-----BEGIN PRIVATE KEY-----")).toBe(false);
    expect(isCodeTaskContentFreeNote("Bearer abcdef")).toBe(false);
  });
});

describe("closed key sets (KEIKO-0302)", () => {
  // Every peer validator in this territory enforces a closed key set precisely so an unexpected
  // field on a documented content-free contract cannot ride through into evidence — the accepted
  // object is handed on as `value`. These four validators did not.
  it("rejects an unknown top-level key on the contribution", () => {
    const result = validateCodeTaskAcceptanceContribution({
      ...validContribution(),
      promptText: "leak me",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });

  it("rejects an unknown key on a scenario, a salvage row, and cleanup", () => {
    const base = validContribution();
    const scenario = base.scenarios[0];
    const salvage = base.salvage[0];
    expect(scenario).toBeDefined();
    expect(salvage).toBeDefined();
    if (scenario === undefined || salvage === undefined) return;
    expect(
      validateCodeTaskAcceptanceContribution({
        ...base,
        scenarios: [{ ...scenario, promptText: "leak me" }],
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskAcceptanceContribution({
        ...base,
        salvage: [{ ...salvage, promptText: "leak me" }],
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskAcceptanceContribution({
        ...base,
        cleanup: { ...base.cleanup, promptText: "leak me" },
      }).ok,
    ).toBe(false);
  });
});

// KfQ Critical (unknownKeys, :214/:359): Object.keys sees only OWN enumerable properties. A value
// shaped via Object.create(secretHolder) can carry every required field as an OWN property -- so
// its own-key shape is indistinguishable from a legitimate contribution -- while one extra field
// rides the prototype chain, invisible to Object.keys, Object.getOwnPropertyNames, and even an
// exact-own-property-count check. isRecord now rejects any non-default prototype outright, and
// unknownKeys additionally scans own non-enumerable and symbol-keyed properties.
describe("prototype-based extra-field smuggling (KfQ Critical)", () => {
  it("rejects a contribution with an extra field reachable only through the prototype", () => {
    const legitimate = validContribution();
    const hostile = Object.create({ secretApiKey: "sk-leak-me" }) as Record<string, unknown>;
    Object.assign(hostile, legitimate);
    // Sanity: the own-key shape is indistinguishable from a legitimate contribution, yet the
    // secret still resolves through ordinary property access.
    expect(Object.keys(hostile)).toEqual(Object.keys(legitimate));
    expect(hostile.secretApiKey).toBe("sk-leak-me");
    expect(validateCodeTaskAcceptanceContribution(hostile).ok).toBe(false);
  });

  it("rejects the degenerate Object.create(valid) case with nothing own at all", () => {
    const hostile: unknown = Object.create(validContribution());
    expect(validateCodeTaskAcceptanceContribution(hostile).ok).toBe(false);
  });

  it("rejects a non-enumerable own extra field and a symbol-keyed own extra field", () => {
    const withHidden: Record<string, unknown> = { ...validContribution() };
    Object.defineProperty(withHidden, "hiddenSecret", { value: "leak", enumerable: false });
    expect(validateCodeTaskAcceptanceContribution(withHidden).ok).toBe(false);

    const withSymbol: Record<string, unknown> = {
      ...validContribution(),
      [Symbol("secret")]: "leak",
    };
    expect(validateCodeTaskAcceptanceContribution(withSymbol).ok).toBe(false);
  });

  it("still accepts an ordinary JSON.parse-shaped contribution", () => {
    // Confirms the hardening does not reject legitimate wire-shaped input: JSON.parse always
    // produces a plain object with the default Object.prototype and only enumerable own properties.
    expect(validateCodeTaskAcceptanceContribution(validContribution()).ok).toBe(true);
  });

  // Codex P1 (thread 3789461971): this fixture does NOT exercise the restored "in" check.
  // Object.create({ value: "secret" }) has a non-default prototype, so isRecord's own,
  // already-hardened prototype-identity check rejects it before factErrors ever reaches the
  // guard below -- confirmed by deleting that guard's call site and re-running: this test still
  // passes. It remains a valid pin of the OVERALL contract ("this attack shape is rejected"), just
  // not of the specific guard its comment used to claim. Kept, relabeled honestly; the direct
  // helper tests below are what actually pin the guard itself.
  it("rejects a receiptDigest fact shaped via Object.create (caught by isRecord's prototype check)", () => {
    const hostileFact = Object.create({ value: "secret" }) as Record<string, unknown>;
    hostileFact.outcome = "absent";
    expect(Object.keys(hostileFact)).toEqual(["outcome"]); // own-key view looks complete
    expect("value" in hostileFact).toBe(true); // yet the secret still resolves
    const base = validContribution();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const result = validateCodeTaskAcceptanceContribution({
      ...base,
      scenarios: [{ ...scenario, receiptDigest: hostileFact }],
    });
    expect(result.ok).toBe(false);
  });
});

// Codex P1 (thread 3789635890): checking one inherited key at a time never pins the guard either
// -- round one (above) was rejected by isRecord before reaching it; a prior "mechanism" test only
// demonstrated the `in`/for...in language feature in isolation, never calling this file's own
// code. hasInheritedEnumerableProperty is exported specifically so it can be exercised directly:
// these tests call the real production guard with a crafted object, bypassing isRecord on purpose
// (a test targeting this function does not have to satisfy isRecord's separate "is this a plain
// object" question first, unlike every real caller). The prove-red-then-green discipline for the
// two pipeline-level tests is documented alongside them below.
describe("hasInheritedEnumerableProperty (Codex P1 3789635890)", () => {
  it("detects an inherited value with only outcome as an own property", () => {
    const fact = Object.create({ value: "secret" }) as Record<string, unknown>;
    fact.outcome = "absent";
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("detects an inherited discriminator on an otherwise-empty object", () => {
    // The gap Codex actually found: pollute "outcome" itself rather than "value". An object with
    // ZERO own properties still answers fact.outcome === "absent" via inheritance, and
    // unknownKeys' Object.getOwnPropertyNames scan sees nothing at all to report.
    const fact = Object.create({ outcome: "absent" }) as Record<string, unknown>;
    expect(Object.keys(fact)).toEqual([]);
    expect(fact.outcome).toBe("absent");
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("detects an inherited, wholly undeclared field", () => {
    // Every validator here returns its input by reference (never a reconstructed copy), so an
    // inherited field that is not even part of the contract -- promptText is this audit's
    // recurring example of a smuggled free-text field -- still rides along on the object handed
    // onward, invisible to unknownKeys because it is not own.
    const fact = Object.create({ promptText: "leak me" }) as Record<string, unknown>;
    fact.outcome = "absent";
    expect(Object.keys(fact)).toEqual(["outcome"]);
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("does not flag an ordinary, fully-own object", () => {
    expect(hasInheritedEnumerableProperty({ outcome: "absent" })).toBe(false);
    expect(hasInheritedEnumerableProperty({ outcome: "known", value: DIGEST })).toBe(false);
  });
});

// KfQ 3789542344 asked that a pipeline-level test assert the rejection REASON names this guard
// specifically. Verified, and it cannot be done: isRecord's prototype-identity check runs before
// factErrors ever reaches hasInheritedEnumerableProperty, for every fixture whose direct prototype
// is not exactly Object.prototype -- which is every fixture buildable from outside this process
// (see hasInheritedEnumerableProperty's own comment). Proved this empirically rather than assuming
// it: a version of this test asserting the guard's exact message text against
// Object.create({ outcome: "absent" }) fails with the actual reason being isRecord's
// "... must be a tagged fact object", never the guard's message -- the same architectural
// constraint the extracted-helper approach exists to route around, not a gap the pipeline can
// close. The direct hasInheritedEnumerableProperty tests above are the reachable, correct home for
// pinning this guard's behaviour; asserting its literal message string would only be reachable
// through the same unreachable path.
describe("factErrors: what the pipeline can and cannot pin here (Codex P1 3789635890)", () => {
  function withReceiptDigest(receiptDigest: unknown): unknown {
    const base = validContribution();
    const scenario = base.scenarios[0];
    if (scenario === undefined) throw new Error("fixture must declare at least one scenario");
    return { ...base, scenarios: [{ ...scenario, receiptDigest }] };
  }

  // KfQ 3789542391: isRecord's Object.getPrototypeOf(value) === Object.prototype check rejects a
  // null-prototype object today (Object.getPrototypeOf(Object.create(null)) is null, never
  // Object.prototype), and JSON.parse never produces one, so rejecting is correct -- but nothing
  // pinned that decision before this test. A future loosening of isRecord would go unnoticed
  // without it. Unlike the outcome/promptText shapes above, this one IS reachable through the
  // pipeline: it is isRecord's own check being exercised, not hasInheritedEnumerableProperty's.
  it("rejects a null-prototype receiptDigest", () => {
    const fact: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    fact.outcome = "absent";
    expect(Object.getPrototypeOf(fact)).toBeNull();
    const result = validateCodeTaskAcceptanceContribution(withReceiptDigest(fact));
    expect(result.ok).toBe(false);
  });

  it("still accepts a legitimate receiptDigest with no inherited or null-prototype shape", () => {
    expect(validateCodeTaskAcceptanceContribution(validContribution()).ok).toBe(true);
  });
});

// KfQ 3789542365 (code-task-acceptance.ts:218): the non-known branch used to return as soon as it
// saw an own "value" field, so unknownKeys never ran and any OTHER extra own key went unreported.
// A test asserting only ok === false cannot tell early-return from collect-both apart -- both
// produce a failing result for a fixture that has just one problem. Only a fixture with TWO
// independent problems, and an assertion that BOTH specific messages appear, actually pins collect
// over early-return. Proved red-then-green against a temporary early-return sabotage (see the
// commit this test shipped in for the measurement) before trusting it.
describe("factErrors collects every violation instead of stopping at the first (KfQ 3789542365)", () => {
  it("reports both the disallowed value and the unrelated extra key on a non-known outcome", () => {
    const base = validContribution();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const result = validateCodeTaskAcceptanceContribution({
      ...base,
      scenarios: [
        { ...scenario, receiptDigest: { outcome: "absent", value: DIGEST, promptText: "leak me" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("must not carry a value"))).toBe(true);
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });

  // Not KfQ-filed (the finding named only the non-known branch above), but the same early-return
  // shape existed in the "known" branch too and was fixed the same way for consistency -- an
  // untested decision either way, so pinned here rather than left implicit.
  it("reports both the invalid value and the unrelated extra key on a known outcome", () => {
    const base = validContribution();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const result = validateCodeTaskAcceptanceContribution({
      ...base,
      scenarios: [
        { ...scenario, receiptDigest: { outcome: "known", value: "short", promptText: "leak me" } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("value is invalid"))).toBe(true);
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });
});
