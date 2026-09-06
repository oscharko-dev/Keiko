import { describe, expect, it } from "vitest";

import {
  CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
  CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
  CODE_TASK_EVIDENCE_CLASSES,
  CODE_TASK_EVIDENCE_PLATFORMS,
  CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
  CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
  CODE_TASK_QUALIFICATION_MANIFEST_KIND,
  CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
  CODE_TASK_QUALIFICATION_REQUIRED_TOOLS,
  codeTaskAcceptanceQualificationFailures,
  codeTaskQualificationManifestFailures,
  codeTaskQualificationVerdictFor,
  hasInheritedEnumerableProperty,
  isCodeTaskContentFreeNote,
  isCodeTaskIsoInstant,
  isCodeTaskRepoRelativePath,
  validateCodeTaskAcceptanceContribution,
  validateCodeTaskQualificationManifest,
  validateCodeTaskQualificationFlowArtifact,
  type CodeTaskAcceptanceBinding,
  type CodeTaskAcceptanceContributionV1,
  type CodeTaskIsoInstant,
  type CodeTaskQualificationManifestV1,
  type CodeTaskQualificationFlowArtifactV1,
} from "./code-task-acceptance.js";
import { withPollutedPrototype } from "./code-task-pollution-test-support.js";

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

describe("factErrors: the null-prototype case (KfQ 3789542391, refuted again at 3789776138)", () => {
  function withReceiptDigest(receiptDigest: unknown): unknown {
    const base = validContribution();
    const scenario = base.scenarios[0];
    if (scenario === undefined) throw new Error("fixture must declare at least one scenario");
    return { ...base, scenarios: [{ ...scenario, receiptDigest }] };
  }

  // KfQ 3789542391 / 3789776138 (new thread, same claim): isRecord's
  // Object.getPrototypeOf(value) === Object.prototype check rejects a null-prototype object today
  // (Object.getPrototypeOf(Object.create(null)) is null, never Object.prototype), and JSON.parse
  // never produces one, so rejecting can never affect a legitimate wire-shaped payload -- deliberate,
  // already pinned here, reused for the new thread id.
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

// Codex P1 3789773829, the terminating fix (see ownField's definition in code-task-acceptance.ts
// for the full reasoning): detecting a specific inherited-property shape is always one step behind
// an attacker who can vary the property descriptor -- enumerable value, then enumerable outcome,
// then this thread's non-enumerable outcome. ownField makes the question moot by never reading
// through the prototype chain at all, for ANY descriptor shape. These tests pin that directly
// against the real global Object.prototype (not a safe stand-in): calling vitest's expect() WHILE
// Object.prototype is polluted throws inside expect's own internals for at least the "value" key
// (confirmed empirically -- its fluent chain apparently builds objects via defineProperty, which
// collides with an inherited plain "value" the same way node:internal/streams/readable did in an
// earlier, non-isolated finding), so withPollutedPrototype (imported, not reimplemented here: KfQ
// 3789982967 found a real bug in this helper when it was still copy-pasted per file -- see its
// shared definition in code-task-pollution-test-support.ts) captures only a plain result during the
// polluted window and restores deterministically in a finally BEFORE any assertion runs.

function withReceiptDigest(receiptDigest: unknown): unknown {
  const base = validContribution();
  const scenario = base.scenarios[0];
  if (scenario === undefined) throw new Error("fixture must declare at least one scenario");
  return { ...base, scenarios: [{ ...scenario, receiptDigest }] };
}

// Non-enumerable pollution isolates ownField's OWN contribution cleanly: hasInheritedEnumerableProperty's
// for...in is blind to it everywhere in the object graph, not only at the field under test (unlike
// enumerable pollution below, which trips that guard on every OTHER nested fact in the same payload
// too, since for...in walks the full chain on every object once anything is enumerable on
// Object.prototype -- confirmed empirically: an enumerable-"kind" pollution test rejected the
// payload via the UNRELATED receiptDigest/reshaping guard messages, not via anything reading
// "kind" at all, before this file's tests were corrected to use non-enumerable pollution here
// specifically to avoid that confound). Proved red-then-green against a temporary ownField
// sabotage (reverted to plain `record[key]`, matching the coordinator's literal acceptance
// criterion) -- confirmed empirically that with ownField sabotaged this way, the non-enumerable
// "kind" case is wrongly ACCEPTED (ok: true), not merely differently rejected.
describe("ownField makes an inherited field unreadable regardless of descriptor shape (Codex P1 3789773829)", () => {
  it("rejects a fact's inherited non-enumerable value on the known branch", () => {
    const payload = withReceiptDigest({ outcome: "known" }); // no own "value"
    const result = withPollutedPrototype("value", { value: DIGEST, enumerable: false }, () =>
      validateCodeTaskAcceptanceContribution(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a fact's inherited non-enumerable outcome discriminator on an empty object", () => {
    const payload = withReceiptDigest({}); // wholly empty; outcome resolves only through the chain
    const result = withPollutedPrototype("outcome", { value: "absent", enumerable: false }, () =>
      validateCodeTaskAcceptanceContribution(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an inherited non-enumerable top-level header field", () => {
    const legitimate = validContribution();
    const { kind: _kind, ...withoutKind } = legitimate as unknown as Record<string, unknown>;
    void _kind;
    const result = withPollutedPrototype(
      "kind",
      { value: CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND, enumerable: false },
      () => validateCodeTaskAcceptanceContribution(withoutKind),
    );
    expect(result.ok).toBe(false);
  });

  it("still accepts a legitimate contribution once Object.prototype is restored", () => {
    // Sanity: withPollutedPrototype's finally actually cleans up -- this runs after every polluted
    // test above and would fail if any of them leaked.
    expect(validateCodeTaskAcceptanceContribution(validContribution()).ok).toBe(true);
  });
});

// Enumerable pollution -- Codex's original, simpler shapes -- is kept as belt-and-braces per the
// coordinator's explicit direction, so these still pass and are worth pinning as end-to-end
// evidence that the pipeline rejects them. They do NOT isolate ownField's marginal contribution
// the way the non-enumerable tests above do: because for...in walks the full prototype chain,
// enumerable pollution of ANY key trips hasInheritedEnumerableProperty on every OTHER nested fact
// in the same payload too, so these tests would still pass even with ownField reverted to plain
// property access (confirmed empirically) -- the rejection comes from the guard, which is exactly
// what "belt and braces" means.
describe("hasInheritedEnumerableProperty still independently rejects the enumerable shapes Codex originally found", () => {
  it("rejects an inherited enumerable value on an otherwise-complete receiptDigest", () => {
    const payload = withReceiptDigest({ outcome: "absent" });
    const result = withPollutedPrototype(
      "value",
      { value: DIGEST, enumerable: true, writable: true },
      () => validateCodeTaskAcceptanceContribution(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an inherited enumerable outcome on an entirely empty receiptDigest", () => {
    const payload = withReceiptDigest({});
    const result = withPollutedPrototype(
      "outcome",
      { value: "absent", enumerable: true, writable: true },
      () => validateCodeTaskAcceptanceContribution(payload),
    );
    expect(result.ok).toBe(false);
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

// #3390 qualification manifest -- a versioned sibling of the acceptance contribution above.
const RUBRIC_DIGEST = "e".repeat(64);
const READINESS_DIGEST = "f".repeat(64);
const OUTCOME_DIGEST = "1".repeat(64);
const AUDIT_DIGEST = "2".repeat(64);
const HUMAN_MERGE_ATTESTATION_DIGEST = "3".repeat(64);
function codeTaskIsoInstant(value: string): CodeTaskIsoInstant {
  if (!isCodeTaskIsoInstant(value)) {
    throw new TypeError("qualification fixture instant must be canonical UTC ISO-8601");
  }
  return value;
}

const QUALIFICATION_RECORDED_AT = codeTaskIsoInstant("2026-09-04T12:00:00Z");

function validQualificationFlow(
  ordinal = 1,
  cumulativeChargedNanoUsd = 3_240_000,
  chargedDeltaNanoUsd = cumulativeChargedNanoUsd,
): CodeTaskQualificationFlowArtifactV1 {
  const pullRequestHeadSha = ordinal === 1 ? TREE_SHA : "d".repeat(40);
  const mergeCommitSha = ordinal === 1 ? COMMIT_SHA : "e".repeat(40);
  const mode = ordinal === 1 ? "governed-assist" : "supervised-coding";
  const issueToPrScenario = {
    "governed-assist": "issue-to-pr-governed-assist",
    "supervised-coding": "issue-to-pr-supervised-coding",
  }[mode];
  const candidate: unknown = {
    evidenceKind: CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND,
    schemaVersion: 1,
    flowId: `issue-to-pr-flow-0${String(ordinal)}`,
    ordinal,
    repository: "oscharko/Wegwerf-Repo",
    issueReference: `https://github.com/oscharko/Wegwerf-Repo/issues/${String(ordinal)}`,
    issueNumber: ordinal,
    issueState: "closed",
    issueClosedAt: QUALIFICATION_RECORDED_AT,
    mode,
    taskRunId: `run-${String(ordinal)}`,
    pullRequestReference: `https://github.com/oscharko/Wegwerf-Repo/pull/${String(ordinal)}`,
    pullRequestNumber: ordinal,
    pullRequestHeadSha,
    pullRequestState: "merged",
    pullRequestMergedAt: QUALIFICATION_RECORDED_AT,
    mergeCommitSha,
    requiredChecks: {
      observation: "observed",
      headSha: pullRequestHeadSha,
      requirementsVersion: "1",
      requirementsDigest: RUBRIC_DIGEST,
      evidenceRef: "ci-observation-1",
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
    },
    authorityObservation: {
      requestedMode: mode,
      effectiveMode: mode,
      approvalRequestCount: 2,
      approvalRequests: [
        { actionClass: "workspace-write", actionKind: "file-edit", requestCount: 1 },
        {
          actionClass: "delivery-substrate",
          actionKind: "commit",
          requestCount: 1,
        },
      ],
      approvedProposalActions: [{ actionKind: "commit", approvalCount: 1 }],
      toolInvocationCount: 4,
      effectStartedCount: 3,
      effectStartedTools: [
        { canonicalId: "keiko.changeset.edit", contractVersion: 1, invocationCount: 1 },
        { canonicalId: "keiko.verification.run", contractVersion: 1, invocationCount: 2 },
      ],
      completedToolCount: 3,
      deniedToolCount: 0,
      failedToolCount: 1,
      otherToolCount: 0,
    },
    rubricReview: {
      reviewId: `qualification-review-${String(ordinal)}`,
      reviewDigest: DIGEST,
      verdict: "approved",
      flowId: `issue-to-pr-flow-0${String(ordinal)}`,
      taskRunId: `run-${String(ordinal)}`,
      repository: "oscharko/Wegwerf-Repo",
      issueNumber: ordinal,
      pullRequestNumber: ordinal,
      pullRequestHeadSha,
      sourceCommitSha: COMMIT_SHA,
      rubricDigest: RUBRIC_DIGEST,
      criteriaTotal: 5,
      criteriaPassed: 5,
    },
    stageEvidence: {
      issueToPr: {
        scenarioId: issueToPrScenario,
        receiptDigest: "4".repeat(64),
      },
      ciRepair:
        ordinal === 1 ? { scenarioId: "ci-repair-loop", receiptDigest: "5".repeat(64) } : null,
      description: {
        scenarioId: "description-auto-draft-and-apply",
        receiptDigest: "6".repeat(64),
      },
      markReady: { scenarioId: "mark-ready-intent", receiptDigest: "7".repeat(64) },
      governedMerge: {
        scenarioId: "human-merge-and-closure",
        receiptDigest: "8".repeat(64),
      },
    },
    transitions: CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
    sourceCommitSha: COMMIT_SHA,
    observedAt: QUALIFICATION_RECORDED_AT,
    spend: {
      budgetNanoUsd: 50_000_000_000,
      chargedDeltaNanoUsd,
      cumulativeChargedNanoUsd,
      remainingNanoUsd: 50_000_000_000 - cumulativeChargedNanoUsd,
    },
  };
  const result = validateCodeTaskQualificationFlowArtifact(candidate);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function validQualificationManifest(): CodeTaskQualificationManifestV1 {
  const parsed: unknown = JSON.parse(
    JSON.stringify({
      kind: CODE_TASK_QUALIFICATION_MANIFEST_KIND,
      schemaVersion: CODE_TASK_QUALIFICATION_MANIFEST_SCHEMA_VERSION,
      epicIssue: 3384,
      childIssue: 3390,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeIdentity: "opencode-1.17.17",
      modelIdentity: "gateway-profile:coding-issue-journey",
      fixtureRevision: "controlled-fixture-rev-1",
      rubricDigest: RUBRIC_DIGEST,
      issueReference: { outcome: "known", value: "controlled/repo#101" },
      pullRequestReference: { outcome: "known", value: "controlled/repo#102" },
      runReference: { outcome: "known", value: "run-20260904-01" },
      readinessSnapshotDigest: { outcome: "known", value: READINESS_DIGEST },
      journeyOutcomeDigest: { outcome: "known", value: OUTCOME_DIGEST },
      auditReference: { outcome: "known", value: "keiko-issue-audit-20260904" },
      auditDigest: { outcome: "known", value: AUDIT_DIGEST },
      humanMergeAttestationDigest: { outcome: "known", value: HUMAN_MERGE_ATTESTATION_DIGEST },
      requiredTools: CODE_TASK_QUALIFICATION_REQUIRED_TOOLS,
      spendBudgetUsd: 25,
      observedSpendUsd: { outcome: "known", value: 4.5 },
      scenarios: [
        {
          scenarioId: "issue-to-pr-full-access",
          evidenceClass: "playwright-journey",
          platform: "macos-arm64",
          provenance: "real-model",
          outcome: "passed",
          recordedAt: "2026-09-04T12:00:00Z",
          blockedReason: { outcome: "absent" },
          artifactDigests: [DIGEST],
          receiptDigest: { outcome: "known", value: DIGEST },
        },
      ],
      flows: [],
      knownLimitations: ["packaged Windows x64 reference run is a documented external dependency"],
    }),
  );
  const result = validateCodeTaskQualificationManifest(parsed);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function mutatedManifest(patch: Record<string, unknown>): unknown {
  return { ...validQualificationManifest(), ...patch };
}

describe("validateCodeTaskQualificationManifest", () => {
  it("accepts a complete JSON-round-tripped manifest", () => {
    expect(validateCodeTaskQualificationManifest(validQualificationManifest()).ok).toBe(true);
  });

  it("rejects a manifest missing provenance, runtime identity, and rubric digest", () => {
    const base = validQualificationManifest();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const scenarioWithoutProvenance: Record<string, unknown> = { ...scenario };
    delete scenarioWithoutProvenance.provenance;
    const manifestWithoutIdentity: Record<string, unknown> = { ...base };
    delete manifestWithoutIdentity.runtimeIdentity;
    delete manifestWithoutIdentity.rubricDigest;
    const result = validateCodeTaskQualificationManifest({
      ...manifestWithoutIdentity,
      scenarios: [scenarioWithoutProvenance],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("runtimeIdentity must be a bounded content-free reference");
    expect(result.errors).toContain("rubricDigest is invalid");
    expect(result.errors.some((error) => error.includes("provenance is invalid"))).toBe(true);
  });

  it("rejects a wrong kind and a non-literal schema version", () => {
    expect(validateCodeTaskQualificationManifest(mutatedManifest({ kind: "other" })).ok).toBe(
      false,
    );
    expect(validateCodeTaskQualificationManifest(mutatedManifest({ schemaVersion: 2 })).ok).toBe(
      false,
    );
  });

  it("requires a blocked scenario to carry a known blockedReason, and no other outcome to", () => {
    const base = validQualificationManifest();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const blockedWithoutReason = validateCodeTaskQualificationManifest({
      ...base,
      scenarios: [{ ...scenario, outcome: "blocked", receiptDigest: { outcome: "absent" } }],
    });
    expect(blockedWithoutReason.ok).toBe(false);
    const passedWithReason = validateCodeTaskQualificationManifest({
      ...base,
      scenarios: [{ ...scenario, blockedReason: { outcome: "known", value: "#2951" } }],
    });
    expect(passedWithReason.ok).toBe(false);
    const blockedWithReason = validateCodeTaskQualificationManifest({
      ...base,
      scenarios: [
        {
          ...scenario,
          outcome: "blocked",
          receiptDigest: { outcome: "absent" },
          blockedReason: { outcome: "known", value: "functional-not-platform-qualified: #2951" },
        },
      ],
    });
    expect(blockedWithReason.ok).toBe(true);
  });

  it("rejects an evidenceClass outside the shared vocabulary (functional-not-platform-qualified excluded)", () => {
    const base = validQualificationManifest();
    const scenario = base.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const result = validateCodeTaskQualificationManifest({
      ...base,
      scenarios: [{ ...scenario, evidenceClass: "functional-not-platform-qualified" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("not a registered evidence class"))).toBe(
      true,
    );
  });

  it("rejects a manifest missing humanMergeAttestationDigest (#3390 audit F9)", () => {
    const base: Record<string, unknown> = { ...validQualificationManifest() };
    delete base.humanMergeAttestationDigest;
    const result = validateCodeTaskQualificationManifest(base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("humanMergeAttestationDigest"))).toBe(true);
  });

  it("rejects requiredTools entries that are not catalog tool names (#3390 audit F10)", () => {
    const result = validateCodeTaskQualificationManifest(
      mutatedManifest({ requiredTools: ["keiko_changeset_edit", "not a tool name!"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("requiredTools must be an array of catalog tool names");
  });

  it("rejects a manifest missing requiredTools entirely", () => {
    const base: Record<string, unknown> = { ...validQualificationManifest() };
    delete base.requiredTools;
    const result = validateCodeTaskQualificationManifest(base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("requiredTools must be an array of catalog tool names");
  });

  it.each([
    ["empty", []],
    ["partial", CODE_TASK_QUALIFICATION_REQUIRED_TOOLS.slice(0, -1)],
    [
      "duplicate",
      [...CODE_TASK_QUALIFICATION_REQUIRED_TOOLS, CODE_TASK_QUALIFICATION_REQUIRED_TOOLS[0]],
    ],
  ] as const)("rejects a %s requiredTools inventory", (_description, requiredTools) => {
    const result = validateCodeTaskQualificationManifest(mutatedManifest({ requiredTools }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      "requiredTools must exactly match the controlled-journey rubric inventory",
    );
  });

  it("rejects a non-positive or unbounded spendBudgetUsd (#3390 audit F15)", () => {
    expect(validateCodeTaskQualificationManifest(mutatedManifest({ spendBudgetUsd: 0 })).ok).toBe(
      false,
    );
    expect(validateCodeTaskQualificationManifest(mutatedManifest({ spendBudgetUsd: -5 })).ok).toBe(
      false,
    );
    expect(
      validateCodeTaskQualificationManifest(mutatedManifest({ spendBudgetUsd: 10_000_000 })).ok,
    ).toBe(false);
  });

  it("accepts an unknown observedSpendUsd and rejects a negative one", () => {
    expect(
      validateCodeTaskQualificationManifest(
        mutatedManifest({ observedSpendUsd: { outcome: "unknown" } }),
      ).ok,
    ).toBe(true);
    expect(
      validateCodeTaskQualificationManifest(
        mutatedManifest({ observedSpendUsd: { outcome: "known", value: -1 } }),
      ).ok,
    ).toBe(false);
  });

  it("requires positive app-bound passing required-check evidence", () => {
    expect(validateCodeTaskQualificationFlowArtifact(validQualificationFlow()).ok).toBe(true);
    const base = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, total: 0, passed: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: {
          ...base.authorityObservation,
          approvalRequests: [
            { actionClass: "workspace-write", actionKind: "commit", requestCount: 2 },
          ],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, observation: "unknown" },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, total: 1, pending: 1 },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, requirementsDigest: "not-a-digest" },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, evidenceRef: "invalid evidence ref" },
      }).ok,
    ).toBe(false);
  });

  it("requires observed authority without mode escalation and complete tool accounting", () => {
    const base = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: {
          ...base.authorityObservation,
          effectiveMode: "autonomous-delivery",
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: { ...base.authorityObservation, toolInvocationCount: 5 },
      }).ok,
    ).toBe(false);
  });

  it("requires grouped action evidence and exact effectful tool references", () => {
    const base = validQualificationFlow();
    const duplicateRequest = base.authorityObservation.approvalRequests[0];
    if (duplicateRequest === undefined) throw new Error("fixture approval request is unavailable");
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: {
          ...base.authorityObservation,
          approvalRequests: [...base.authorityObservation.approvalRequests, duplicateRequest],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: {
          ...base.authorityObservation,
          approvedProposalActions: [{ actionKind: "commit", approvalCount: 2 }],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: {
          ...base.authorityObservation,
          effectStartedTools: [{ canonicalId: "keiko.changeset.edit", invocationCount: 3 }],
        },
      }).ok,
    ).toBe(false);
  });

  it.each(["approvalRequestCount", "effectStartedCount", "completedToolCount"] as const)(
    "rejects a zero %s authority observation",
    (field) => {
      const base = validQualificationFlow();
      expect(
        validateCodeTaskQualificationFlowArtifact({
          ...base,
          authorityObservation: { ...base.authorityObservation, [field]: 0 },
        }).ok,
      ).toBe(false);
    },
  );

  it("accepts a Full zero approval count while Ask and Supervised require one", () => {
    const base = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        mode: "autonomous-delivery",
        authorityObservation: {
          ...base.authorityObservation,
          requestedMode: "autonomous-delivery",
          effectiveMode: "autonomous-delivery",
          approvalRequestCount: 0,
          approvalRequests: [],
          approvedProposalActions: [],
        },
        stageEvidence: {
          ...base.stageEvidence,
          issueToPr: {
            ...base.stageEvidence.issueToPr,
            scenarioId: "issue-to-pr-autonomous-delivery",
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        authorityObservation: { ...base.authorityObservation, approvalRequestCount: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        mode: "supervised-coding",
        authorityObservation: {
          ...base.authorityObservation,
          requestedMode: "supervised-coding",
          effectiveMode: "supervised-coding",
          approvalRequestCount: 0,
        },
        stageEvidence: {
          ...base.stageEvidence,
          issueToPr: {
            ...base.stageEvidence.issueToPr,
            scenarioId: "issue-to-pr-supervised-coding",
          },
        },
      }).ok,
    ).toBe(false);
  });

  it("requires an approved independent rubric review bound to the exact flow", () => {
    const base = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        rubricReview: { ...base.rubricReview, criteriaPassed: 4 },
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        rubricReview: { ...base.rubricReview, pullRequestHeadSha: COMMIT_SHA },
      }).ok,
    ).toBe(false);
  });

  it("requires the provider and journey-observer timestamps from the completed lifecycle", () => {
    const base = validQualificationFlow();
    for (const field of ["issueClosedAt", "pullRequestMergedAt", "observedAt"] as const) {
      expect(validateCodeTaskQualificationFlowArtifact({ ...base, [field]: undefined }).ok).toBe(
        false,
      );
      expect(
        validateCodeTaskQualificationFlowArtifact({ ...base, [field]: "not-an-instant" }).ok,
      ).toBe(false);
    }
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        pullRequestMergedAt: codeTaskIsoInstant("2026-09-04T12:00:01Z"),
      }).ok,
    ).toBe(false);
  });

  it("allows nullable CI repair on any flow while validating every present receipt", () => {
    const first = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...first,
        stageEvidence: { ...first.stageEvidence, ciRepair: null },
      }).ok,
    ).toBe(true);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...first,
        stageEvidence: {
          ...first.stageEvidence,
          description: {
            ...first.stageEvidence.description,
            receiptDigest: first.stageEvidence.issueToPr.receiptDigest,
          },
        },
      }).ok,
    ).toBe(false);
    const second = validQualificationFlow(2);
    expect(validateCodeTaskQualificationFlowArtifact(second).ok).toBe(true);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...second,
        stageEvidence: { ...second.stageEvidence, ciRepair: first.stageEvidence.ciRepair },
      }).ok,
    ).toBe(true);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...second,
        stageEvidence: {
          ...second.stageEvidence,
          ciRepair: { scenarioId: "mark-ready-intent", receiptDigest: "9".repeat(64) },
        },
      }).ok,
    ).toBe(false);
  });

  it("rejects incomplete transitions and a checks snapshot from another PR head", () => {
    const base = validQualificationFlow();
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        transitions: base.transitions.slice(0, -1),
      }).ok,
    ).toBe(false);
    expect(
      validateCodeTaskQualificationFlowArtifact({
        ...base,
        requiredChecks: { ...base.requiredChecks, headSha: COMMIT_SHA },
      }).ok,
    ).toBe(false);
  });
});

describe("codeTaskQualificationManifestFailures and codeTaskQualificationVerdictFor", () => {
  const binding: CodeTaskAcceptanceBinding = {
    epicIssue: 3384,
    childIssue: 3390,
    sourceCommitSha: COMMIT_SHA,
    registeredScenarioIds: ["issue-to-pr-full-access"],
  };

  it("qualifies a bound manifest whose scenarios are all passed and real-model", () => {
    const manifest = validQualificationManifest();
    expect(codeTaskQualificationManifestFailures(manifest, binding)).toEqual([]);
    expect(codeTaskQualificationVerdictFor(manifest, binding)).toBe("qualified");
  });

  it("fails an empty manifest and reports blocked, never qualified", () => {
    const empty: CodeTaskQualificationManifestV1 = {
      ...validQualificationManifest(),
      scenarios: [],
    };
    expect(codeTaskQualificationManifestFailures(empty, binding)).toContain(
      "empty manifest: at least one scenario is required",
    );
    expect(codeTaskQualificationVerdictFor(empty, binding)).toBe("blocked");
  });

  it("fails foreign issue bindings and stale SHA bindings, verdict blocked", () => {
    const manifest = validQualificationManifest();
    expect(
      codeTaskQualificationManifestFailures(manifest, { ...binding, epicIssue: 1982 }),
    ).toContain("foreign epic issue binding");
    expect(codeTaskQualificationVerdictFor(manifest, { ...binding, epicIssue: 1982 })).toBe(
      "blocked",
    );
    expect(
      codeTaskQualificationManifestFailures(manifest, { ...binding, sourceCommitSha: TREE_SHA }),
    ).toContain("stale or foreign source SHA binding");
  });

  it("fails unregistered scenarios", () => {
    const manifest = validQualificationManifest();
    expect(
      codeTaskQualificationManifestFailures(manifest, { ...binding, registeredScenarioIds: [] }),
    ).toContain("unregistered scenario: issue-to-pr-full-access");
  });

  it("a scenario that failed outright yields verdict failed, even alongside other problems", () => {
    const manifest = validQualificationManifest();
    const scenario = manifest.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const failedScenario: CodeTaskQualificationManifestV1 = {
      ...manifest,
      scenarios: [{ ...scenario, outcome: "failed", receiptDigest: { outcome: "absent" } }],
    };
    expect(codeTaskQualificationVerdictFor(failedScenario, { ...binding, epicIssue: 1982 })).toBe(
      "failed",
    );
  });

  it("a passed scenario resting on scripted provenance cannot qualify, and names the scenario", () => {
    const manifest = validQualificationManifest();
    const scenario = manifest.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const scripted: CodeTaskQualificationManifestV1 = {
      ...manifest,
      scenarios: [{ ...scenario, provenance: "scripted" }],
    };
    expect(codeTaskQualificationManifestFailures(scripted, binding)).toContain(
      "scripted-model provenance cannot establish qualification: issue-to-pr-full-access",
    );
    expect(codeTaskQualificationVerdictFor(scripted, binding)).toBe("blocked");
  });

  it("accepts production-functional provenance only for a trusted descriptor scenario", () => {
    const manifest = validQualificationManifest();
    const scenario = manifest.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const forgedModelJourney: CodeTaskQualificationManifestV1 = {
      ...manifest,
      scenarios: [
        {
          ...scenario,
          evidenceClass: "production-functional",
          provenance: "production-functional",
        },
      ],
    };
    expect(codeTaskQualificationManifestFailures(forgedModelJourney, binding)).toContain(
      "production-functional provenance is not trusted for scenario: issue-to-pr-full-access",
    );
    expect(codeTaskQualificationVerdictFor(forgedModelJourney, binding)).toBe("blocked");

    const productionFunctionalValidation = validateCodeTaskQualificationManifest({
      ...manifest,
      scenarios: [
        {
          ...scenario,
          scenarioId: "egress-confinement-macos-arm64",
          evidenceClass: "production-functional",
          provenance: "production-functional",
        },
      ],
    });
    expect(productionFunctionalValidation.ok).toBe(true);
    if (!productionFunctionalValidation.ok) return;
    const productionFunctional = productionFunctionalValidation.value;
    const confinementBinding: CodeTaskAcceptanceBinding = {
      ...binding,
      registeredScenarioIds: ["egress-confinement-macos-arm64"],
      registeredProductionFunctionalScenarioIds: ["egress-confinement-macos-arm64"],
    };
    expect(codeTaskQualificationManifestFailures(productionFunctional, confinementBinding)).toEqual(
      [],
    );
    expect(codeTaskQualificationVerdictFor(productionFunctional, confinementBinding)).toBe(
      "qualified",
    );

    const falseClaim: CodeTaskQualificationManifestV1 = {
      ...manifest,
      scenarios: [{ ...scenario, provenance: "production-functional" }],
    };
    expect(codeTaskQualificationManifestFailures(falseClaim, binding)).toContain(
      "production-functional provenance is not trusted for scenario: issue-to-pr-full-access",
    );
    expect(codeTaskQualificationVerdictFor(falseClaim, binding)).toBe("blocked");
  });

  it("an outstanding blocked scenario with a reason yields verdict blocked, not qualified", () => {
    const manifest = validQualificationManifest();
    const scenario = manifest.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const blocked: CodeTaskQualificationManifestV1 = {
      ...manifest,
      scenarios: [
        {
          ...scenario,
          outcome: "blocked",
          receiptDigest: { outcome: "absent" },
          blockedReason: { outcome: "known", value: "functional-not-platform-qualified: #2951" },
        },
      ],
    };
    expect(codeTaskQualificationManifestFailures(blocked, binding)).toEqual([]);
    expect(codeTaskQualificationVerdictFor(blocked, binding)).toBe("blocked");
  });

  it("fails a manifest that omits a scenario the binding requires, never silently qualifying (#3390 audit F3)", () => {
    const manifest = validQualificationManifest();
    const requiringBinding: CodeTaskAcceptanceBinding = {
      ...binding,
      registeredScenarioIds: ["issue-to-pr-full-access", "issue-to-pr-supervised-coding"],
    };
    expect(codeTaskQualificationManifestFailures(manifest, requiringBinding)).toContain(
      "missing required scenario: issue-to-pr-supervised-coding",
    );
    expect(codeTaskQualificationVerdictFor(manifest, requiringBinding)).toBe("blocked");
  });

  it("requires a known human merge attestation whenever the journey outcome digest is known (#3390 audit F9)", () => {
    const manifest = validQualificationManifest();
    const withoutAttestation: CodeTaskQualificationManifestV1 = {
      ...manifest,
      humanMergeAttestationDigest: { outcome: "absent" },
    };
    expect(codeTaskQualificationManifestFailures(withoutAttestation, binding)).toContain(
      "humanMergeAttestationDigest required when journeyOutcomeDigest is known",
    );
    expect(codeTaskQualificationVerdictFor(withoutAttestation, binding)).toBe("blocked");
    // A manifest with no journey outcome yet does not require the attestation either.
    const noOutcomeYet: CodeTaskQualificationManifestV1 = {
      ...manifest,
      journeyOutcomeDigest: { outcome: "unknown" },
      humanMergeAttestationDigest: { outcome: "absent" },
    };
    expect(codeTaskQualificationManifestFailures(noOutcomeYet, binding)).toEqual([]);
  });

  it("flags an observed spend above the approved budget, never silently (#3390 audit F15)", () => {
    const manifest = validQualificationManifest();
    const overspent: CodeTaskQualificationManifestV1 = {
      ...manifest,
      spendBudgetUsd: 10,
      observedSpendUsd: { outcome: "known", value: 10.01 },
    };
    expect(codeTaskQualificationManifestFailures(overspent, binding)).toContain(
      "spend budget exceeded: observed 10.01 usd exceeds budget 10 usd",
    );
    expect(codeTaskQualificationVerdictFor(overspent, binding)).toBe("blocked");
    const withinBudget: CodeTaskQualificationManifestV1 = {
      ...manifest,
      spendBudgetUsd: 10,
      observedSpendUsd: { outcome: "known", value: 10 },
    };
    expect(codeTaskQualificationManifestFailures(withinBudget, binding)).toEqual([]);
    const unreportedSpend: CodeTaskQualificationManifestV1 = {
      ...manifest,
      observedSpendUsd: { outcome: "unknown" },
    };
    expect(codeTaskQualificationManifestFailures(unreportedSpend, binding)).toEqual([]);
  });

  it("requires the ordered distinct flow identities and preserves failed-attempt ledger charges", () => {
    const first = validQualificationFlow();
    const second = validQualificationFlow(2, 8_000_000, 4_760_000);
    const firstManifestFlow = {
      ...first,
      platform: "macos-arm64" as const,
      provenance: "real-model" as const,
      recordedAt: QUALIFICATION_RECORDED_AT,
      artifactDigest: DIGEST as CodeTaskQualificationManifestV1["flows"][number]["artifactDigest"],
      receiptDigest:
        RUBRIC_DIGEST as CodeTaskQualificationManifestV1["flows"][number]["receiptDigest"],
    };
    const secondManifestFlow = { ...firstManifestFlow, ...second };
    const manifest: CodeTaskQualificationManifestV1 = {
      ...validQualificationManifest(),
      spendBudgetUsd: 50,
      observedSpendUsd: { outcome: "known", value: 0.008 },
      issueReference: { outcome: "known", value: first.issueReference },
      pullRequestReference: { outcome: "known", value: first.pullRequestReference },
      runReference: { outcome: "known", value: first.taskRunId },
      flows: [firstManifestFlow, secondManifestFlow],
    };
    const flowBinding = {
      ...binding,
      registeredQualificationFlows: [first, second].map((flow) => ({
        flowId: flow.flowId,
        ordinal: flow.ordinal,
        repository: flow.repository,
        issueNumber: flow.issueNumber,
        mode: flow.mode,
      })),
    };
    expect(codeTaskQualificationManifestFailures(manifest, flowBinding)).toEqual([]);
    const foreignRubricReview: CodeTaskQualificationManifestV1 = {
      ...manifest,
      flows: [
        {
          ...firstManifestFlow,
          rubricReview: {
            ...firstManifestFlow.rubricReview,
            rubricDigest: firstManifestFlow.rubricReview.reviewDigest,
          },
        },
        secondManifestFlow,
      ],
    };
    expect(codeTaskQualificationManifestFailures(foreignRubricReview, flowBinding)).toContain(
      "issue-to-pr-flow-01: rubric review does not match manifest rubric digest",
    );
    const erasedFailedCharges: CodeTaskQualificationManifestV1 = {
      ...manifest,
      flows: [
        firstManifestFlow,
        { ...secondManifestFlow, spend: { ...second.spend, chargedDeltaNanoUsd: 1 } },
      ],
    };
    expect(codeTaskQualificationManifestFailures(erasedFailedCharges, flowBinding)).toContain(
      "issue-to-pr-flow-02: charged delta does not bridge the prior ledger cumulative",
    );
    expect(
      codeTaskQualificationManifestFailures(
        { ...manifest, flows: [firstManifestFlow, firstManifestFlow] },
        flowBinding,
      ),
    ).toContain("duplicate flow taskRunId");
  });
});
