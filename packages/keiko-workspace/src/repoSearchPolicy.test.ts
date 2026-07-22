import { describe, expect, it } from "vitest";

import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  legacyDiscoveryPolicy,
  orderCandidatesForSearch,
  policyOmissionReason,
  resolveSearchPolicy,
  scoreContentForSearch,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { DiscoveredFile } from "./types.js";
import { selectContentPrescoreFiles } from "./repoSearchScan.js";

const file = (relativePath: string): DiscoveredFile => ({ relativePath, sizeBytes: 10 });

const query = (text: string): RetrievalQuery => ({
  kind: "natural-language",
  text,
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
});

describe("resolveSearchPolicy", () => {
  it("applies gitignore + low-value omission only for the workspace-root default", () => {
    const rootDefault = resolveSearchPolicy(false, undefined);
    expect(rootDefault.mode).toBe("workspace-root-default");
    expect(rootDefault.applyGitignore).toBe(true);
    expect(rootDefault.omitLowValueWorkspaceFiles).toBe(true);

    const explicit = resolveSearchPolicy(true, undefined);
    expect(explicit.mode).toBe("explicit-scope");
    expect(explicit.applyGitignore).toBe(false);
    expect(explicit.omitLowValueWorkspaceFiles).toBe(false);
  });

  it("normalizes hint paths without accepting traversal or denied paths", () => {
    const policy = resolveSearchPolicy(false, {
      lowValuePathAllowlist: ["./vendor/generated///", "../outside", ".env", "assets/😀///"],
      recentPaths: ["src\\payments\\PaymentService.ts///"],
    });
    // "assets/😀///" regression-checks the charCodeAt -> codePointAt rename (typescript:S7758):
    // "😀" is 2 UTF-16 code units and neither unit's code point ever equals the ASCII "/" (47),
    // so trailing-slash stripping stops exactly after the emoji instead of corrupting it.
    expect(policy.lowValuePathAllowlist).toEqual(["assets/😀", "vendor/generated"]);
    expect(policy.recentPaths).toEqual(["src/payments/PaymentService.ts"]);
  });
});

describe("legacyDiscoveryPolicy", () => {
  it("never applies gitignore or low-value omission, preserving full-tree discovery for legacy callers", () => {
    for (const hasExplicit of [false, true]) {
      const policy = legacyDiscoveryPolicy(hasExplicit);
      expect(policy.applyGitignore).toBe(false);
      expect(policy.omitLowValueWorkspaceFiles).toBe(false);
      expect(policy.intent).toBe("generic");
    }
  });
});

describe("orderCandidatesForSearch", () => {
  const policy: SearchPolicy = resolveSearchPolicy(false, {
    retrievalIntent: "targeted-code-search",
  });

  it("ranks a basename-matching source file above docs that merely mention the term", () => {
    const files = [
      file("docs/payments.md"),
      file("packages/core/src/PaymentReconciler.ts"),
      file("README.md"),
    ];
    const { files: ordered } = orderCandidatesForSearch(
      files,
      query("Where is PaymentReconciler implemented"),
      policy,
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("packages/core/src/PaymentReconciler.ts");
  });

  it("expands test-style identifiers so their source file path receives the path-term bonus", () => {
    const files = [
      file("tests/payments/PaymentService.test.ts"),
      file("src/payments/PaymentService.ts"),
      file("docs/payment-service.md"),
    ];
    const { files: ordered, diagnostics } = orderCandidatesForSearch(
      files,
      query("Where is the source implementation for PaymentServiceTest?"),
      policy,
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("src/payments/PaymentService.ts");
    const source = diagnostics.rankedCandidates.find(
      (entry) => entry.scopePath === "src/payments/PaymentService.ts",
    );
    expect(
      source?.signals.some((signal) => signal.name === "query-path-score" && signal.value > 0),
    ).toBe(true);
  });

  it("reorders the same candidates for materially different debugging questions", () => {
    const files = [
      file("docs/auth-debugging.md"),
      file("src/auth/ApiClient.ts"),
      file("src/auth/TokenValidator.ts"),
    ];
    const apiClient = orderCandidatesForSearch(
      files,
      query("Where is ApiClient timeout handling implemented?"),
      policy,
      0,
      0,
    ).files.map((entry) => entry.relativePath);
    const tokenValidator = orderCandidatesForSearch(
      files,
      query("Where does TokenValidator reject expired JWTs?"),
      policy,
      0,
      0,
    ).files.map((entry) => entry.relativePath);
    expect(apiClient[0]).toBe("src/auth/ApiClient.ts");
    expect(tokenValidator[0]).toBe("src/auth/TokenValidator.ts");
    expect(apiClient).not.toEqual(tokenValidator);
  });

  it("lets a code match outrank manifest and prose priors", () => {
    const files = [file("package.json"), file("README.md"), file("src/payments/refundPayment.ts")];
    const { files: ordered } = orderCandidatesForSearch(
      files,
      query("Where is refundPayment implemented?"),
      policy,
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("src/payments/refundPayment.ts");
  });

  it("is deterministic and locale-independent on score ties (code-point order)", () => {
    const files = [file("src/zeta.ts"), file("src/alpha.ts"), file("src/Beta.ts")];
    const run = (): readonly string[] =>
      orderCandidatesForSearch(files, query("unrelated"), policy, 0, 0).files.map(
        (f) => f.relativePath,
      );
    // Upper-case 'B' (0x42) sorts before lower-case letters in code-point order — a localeCompare
    // tiebreak would instead fold case and reorder, so this pins the deterministic contract.
    expect(run()).toEqual(["src/Beta.ts", "src/alpha.ts", "src/zeta.ts"]);
    expect(run()).toEqual(run());
  });

  it("reports discovery omission counts in diagnostics", () => {
    const { diagnostics } = orderCandidatesForSearch([file("a.ts")], query("a"), policy, 7, 3);
    expect(diagnostics.ignoredByDiscovery).toBe(7);
    expect(diagnostics.deniedByDiscovery).toBe(3);
    expect(diagnostics.filesAfterPolicy).toBe(1);
  });

  it("omits case-normalized Storybook build output from workspace-root search", () => {
    expect(
      policyOmissionReason("only-for-internal-use/StorybookStatic/assets/iframe.js", policy),
    ).toBe("generated");
  });

  it("does not let expanded aliases drown out an exact API route declaration", () => {
    const routeQuery = query(
      "Verfolge POST /api/chats/messages/grounded: vom Route-Register zum Handler und zu den Tests.",
    );
    const routeDeclaration =
      '{ method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },';
    const genericTestProse =
      "Tests cover grounded handler orchestration files, messages, routes, and POST behavior.";

    const declarationScore = scoreContentForSearch(routeQuery, routeDeclaration, policy);
    expect(declarationScore).toBeGreaterThan(
      scoreContentForSearch(routeQuery, genericTestProse, policy),
    );
    expect(declarationScore).toBeGreaterThan(140);
  });

  it("ranks an exact-symbol definition above call sites without changing match semantics", () => {
    const exactQuery: RetrievalQuery = {
      kind: "exact-symbol",
      text: "dispatchWorkUnit",
      caseSensitive: false,
      maxResults: 100,
      emittedAtMs: 0,
    };

    expect(
      scoreContentForSearch(
        exactQuery,
        "export async function dispatchWorkUnit(): Promise<void> {}",
        policy,
      ),
    ).toBeGreaterThan(scoreContentForSearch(exactQuery, "await dispatchWorkUnit();", policy));
  });

  it("path-prioritizes files before applying the bounded content-prescore cap", () => {
    const files = [file("src/noise-a.ts"), file("src/noise-b.ts"), file("src/zz-routes.ts")];
    const selected = selectContentPrescoreFiles(
      files,
      query("Trace POST /api/chats/messages/grounded from route to handler"),
      policy,
      2,
    );

    expect(selected.map((entry) => entry.relativePath)).toContain("src/zz-routes.ts");
  });

  it("reserves a route-registration candidate when the question names only method and path", () => {
    const files = [file("src/a.ts"), file("src/b.ts"), file("src/routes.ts")];
    const selected = selectContentPrescoreFiles(
      files,
      query(
        "Welche Produktionsdatei registriert POST /api/chats/messages/grounded und welches Handler-Symbol steht dort?",
      ),
      policy,
      2,
    );

    expect(selected.map((entry) => entry.relativePath)).toContain("src/routes.ts");
  });
});

describe("orderCandidatesForSearch — polyglot ecosystem awareness", () => {
  const metadataPolicy: SearchPolicy = resolveSearchPolicy(false, {
    retrievalIntent: "project-metadata",
  });

  it("ranks a Maven pom.xml above prose for a project-metadata question", () => {
    const files = [file("README.md"), file("docs/setup.md"), file("pom.xml")];
    const { files: ordered, diagnostics } = orderCandidatesForSearch(
      files,
      query("Which Java version does this project use?"),
      metadataPolicy,
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("pom.xml");
    expect(diagnostics.candidateBuckets["canonical-metadata"]).toBe(1);
  });

  it.each(["go.mod", "Cargo.toml", "pyproject.toml", "build.gradle", "services/x/pom.xml"])(
    "buckets %s as canonical-metadata",
    (path) => {
      const { diagnostics } = orderCandidatesForSearch(
        [file(path)],
        query("version"),
        metadataPolicy,
        0,
        0,
      );
      expect(diagnostics.candidateBuckets["canonical-metadata"]).toBe(1);
      expect(diagnostics.rankedCandidates[0]?.ecosystem).toBeDefined();
    },
  );

  it("deprioritizes generated/vendored artifacts into the low-value bucket", () => {
    const files = [
      file("src/Service.java"),
      file("target/classes/Service.class"),
      file("api/user.pb.go"),
      file("vendor/lib/x.go"),
    ];
    const { diagnostics } = orderCandidatesForSearch(
      files,
      query("service"),
      resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" }),
      0,
      0,
    );
    // The three generated artifacts collapse into low-value; only the hand-authored source is not.
    expect(diagnostics.candidateBuckets["low-value"]).toBe(3);
    expect(diagnostics.candidateBuckets.source).toBe(1);
  });

  it("ranks hand-authored config above source wrappers for config-key lookup", () => {
    const files = [file("src/config.ts"), file("config/features.yaml"), file("docs/features.md")];
    const { files: ordered, diagnostics } = orderCandidatesForSearch(
      files,
      query("Where is FEATURE_PAYMENTS_V2 configured?"),
      resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" }),
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("config/features.yaml");
    expect(diagnostics.candidateBuckets.config).toBe(1);
  });

  it("keeps short discriminative code tokens in the lexical score", () => {
    const files = [file("docs/api.md"), file("src/http/ApiIdUrlMapper.ts")];
    const { files: ordered, diagnostics } = orderCandidatesForSearch(
      files,
      query("Where is the API id url mapper implemented?"),
      resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" }),
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("src/http/ApiIdUrlMapper.ts");
    const source = diagnostics.rankedCandidates.find(
      (entry) => entry.scopePath === "src/http/ApiIdUrlMapper.ts",
    );
    expect(source?.signals.some((signal) => signal.name === "query-path-score")).toBe(true);
  });

  it("emits explainable per-file ranking signals for the top candidates", () => {
    const { diagnostics } = orderCandidatesForSearch(
      [file("pom.xml"), file("README.md")],
      query("Which Java version"),
      metadataPolicy,
      0,
      0,
    );
    const pom = diagnostics.rankedCandidates.find((c) => c.scopePath === "pom.xml");
    expect(pom?.bucket).toBe("canonical-metadata");
    expect(pom?.signals.some((s) => s.name === "bucket:canonical-metadata")).toBe(true);
    expect(pom?.signals.some((s) => s.name === "depth-penalty")).toBe(true);
    expect(pom?.signals.some((s) => s.name.startsWith("ecosystem:"))).toBe(true);
  });
});
