import { describe, expect, it } from "vitest";

import {
  allRegisteredFilePatterns,
  canonicalMetadataEcosystem,
  CANONICAL_MANIFEST_BASENAMES,
  ECOSYSTEMS,
  ecosystemMetadataIntentPatterns,
  ecosystemPackageBoundary,
  ecosystemStructureProfiles,
  ecosystemTechnicalPhrases,
  ecosystemVersionDeclarationPatterns,
  isCanonicalMetadataFile,
  isEcosystemLockfile,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
  workspaceLanguageForPath,
} from "./ecosystems.js";
import { DEFAULT_DENY_PATTERNS, isDenied } from "./ignore.js";

describe("ecosystems registry — canonical metadata recognition", () => {
  it.each([
    ["pom.xml", "maven"],
    ["services/payments/pom.xml", "maven"],
    ["go.mod", "go"],
    ["cmd/api/go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["build.gradle", undefined],
    ["build.gradle.kts", undefined],
    ["package.json", undefined],
    ["tsconfig.json", undefined],
    ["src/Api.csproj", "dotnet"],
    ["infra/main.tf", "terraform"],
    ["Dockerfile", "docker"],
  ])("recognizes %s as canonical metadata", (path, _eco) => {
    expect(isCanonicalMetadataFile(path)).toBe(true);
    expect(canonicalMetadataEcosystem(path)).toBeDefined();
  });

  it("maps unambiguous manifests to the expected ecosystem", () => {
    expect(canonicalMetadataEcosystem("go.mod")).toBe("go");
    expect(canonicalMetadataEcosystem("Cargo.toml")).toBe("rust");
    expect(canonicalMetadataEcosystem("pyproject.toml")).toBe("python");
    expect(canonicalMetadataEcosystem("svc/Service.csproj")).toBe("dotnet");
  });

  it.each([
    "README.md",
    "docs/architecture.md",
    "src/main/java/com/acme/App.java",
    "src/index.ts",
    "notes.txt",
    "data.csv",
  ])("does not treat %s as canonical metadata", (path) => {
    expect(isCanonicalMetadataFile(path)).toBe(false);
  });

  it("is case-insensitive on the basename but order-stable", () => {
    expect(isCanonicalMetadataFile("CARGO.TOML")).toBe(true);
    expect(isCanonicalMetadataFile("svc/PROJECT.CSPROJ")).toBe(true);
  });
});

describe("ecosystems registry — source files", () => {
  it.each([
    "src/main/java/A.java",
    "cmd/main.go",
    "src/lib.rs",
    "app/service.py",
    "ui/Widget.kt",
    "engine/render.cpp",
    "engine/render.hpp",
    "models/user.rb",
    "src/Controller.cs",
    "App/View.swift",
    "web/Index.php",
  ])("classifies %s as an ecosystem source file", (path) => {
    expect(isEcosystemSourceFile(path)).toBe(true);
  });

  it("does not classify docs or manifests as source", () => {
    expect(isEcosystemSourceFile("README.md")).toBe(false);
    expect(isEcosystemSourceFile("pom.xml")).toBe(false);
  });

  it.each([
    ["pom.xml", "java"],
    ["src/main/java/A.java", "java"],
    ["build.gradle.kts", "kotlin"],
    ["src/App.kt", "kotlin"],
    ["pyproject.toml", "python"],
    ["app/service.py", "python"],
    ["go.mod", "go"],
    ["cmd/main.go", "go"],
    ["Cargo.toml", "rust"],
    ["src/lib.rs", "rust"],
    ["src/Controller.cs", "csharp"],
    ["src/index.ts", "typescript"],
    ["src/index.js", "javascript"],
  ] as const)("maps %s to WorkspaceLanguage %s", (path, language) => {
    expect(workspaceLanguageForPath(path)).toBe(language);
  });
});

describe("ecosystems registry — structure capability profiles", () => {
  it("derives package boundary metadata from the same ecosystem registry fields by default", () => {
    const profiles = ecosystemStructureProfiles();
    const java = profiles.find((profile) => profile.ecosystem === "java");
    const dotnet = profiles.find((profile) => profile.ecosystem === "dotnet");

    expect(java?.sourceExtensions).toContain("java");
    expect(java?.manifestNames).toContain("pom.xml");
    expect(dotnet?.manifestSuffixes).toContain(".csproj");
    expect(profiles.every((profile) => profile.extractorName === undefined)).toBe(true);
  });

  it("allows an ecosystem to override package boundaries without a parallel registry", () => {
    const java = ECOSYSTEMS.find((ecosystem) => ecosystem.id === "java");
    if (java === undefined) {
      throw new Error("expected Java ecosystem fixture");
    }
    const boundary = ecosystemPackageBoundary({
      ...java,
      structure: {
        packageBoundary: {
          manifestNames: ["module-info.java"],
          manifestSuffixes: [],
          sourceRootSegments: ["src/main/java"],
        },
      },
    });

    expect(boundary).toEqual({
      manifestNames: ["module-info.java"],
      manifestSuffixes: [],
      sourceRootSegments: ["src/main/java"],
    });
  });
});

describe("ecosystems registry — generated artifacts (whole-segment / anchored suffix only)", () => {
  it.each([
    "target/classes/App.class",
    "vendor/github.com/x/y.go",
    "api/user.pb.go",
    "gen/user_pb2.py",
    "__pycache__/mod.pyc",
    "obj/Debug/App.dll.g.cs",
    "Service.designer.cs",
    "bin/Release/x.nupkg",
  ])("flags generated artifact %s", (path) => {
    expect(isGeneratedArtifactPath(path)).toBe(true);
  });

  it.each([
    // The crucial false-positive guards from the security review: hand-authored source whose name
    // merely CONTAINS a generated marker substring must NOT be demoted.
    "src/builder.ts",
    "internal/generator.go",
    "src/buildConfig.ts",
    "pkg/binutils/reader.go",
    "app/objects/user.rb",
    "src/targeting/aim.rs",
  ])("does not flag hand-authored source %s", (path) => {
    expect(isGeneratedArtifactPath(path)).toBe(false);
  });
});

describe("ecosystems registry — lockfiles", () => {
  it.each([
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "Gemfile.lock",
    "composer.lock",
    "gradle.lockfile",
  ])("recognizes lockfile %s", (path) => {
    expect(isEcosystemLockfile(path)).toBe(true);
  });

  it("does not treat a manifest as a lockfile", () => {
    expect(isEcosystemLockfile("Cargo.toml")).toBe(false);
  });
});

describe("ecosystems registry — SECURITY: deny-clean and secret-convention-clean", () => {
  // The registry can only ever re-bucket files that already survived the always-on deny gate, but
  // the orchestrator's metadata-atom injection does not re-run isDenied on every code path, so the
  // security review requires every registered pattern to be disjoint from the deny list and secret
  // conventions. This is the contract test enforcing that invariant.
  const patterns = allRegisteredFilePatterns();

  it("registers a non-trivial number of patterns", () => {
    expect(patterns.length).toBeGreaterThan(40);
  });

  it.each(patterns)("registered pattern %s is not on the deny list", (pattern) => {
    expect(isDenied(pattern)).toBe(false);
    // Also assert it would not be denied at a nested location.
    expect(isDenied(`services/app/${pattern}`)).toBe(false);
  });

  const SECRET_CONVENTIONS = [
    ".env",
    ".env.production",
    ".npmrc",
    "terraform.tfvars",
    "secrets.tfvars",
    "prod.tfvars.json",
    "terraform.tfstate",
    "kubeconfig",
    "server.pem",
    "deploy.key",
    "service-account.json",
    "id_rsa",
  ];

  it.each(SECRET_CONVENTIONS)(
    "never recognizes secret-bearing file %s as canonical metadata",
    (path) => {
      expect(isCanonicalMetadataFile(path)).toBe(false);
    },
  );

  it("every secret-convention file is itself denied (sanity check on the boundary)", () => {
    for (const secret of SECRET_CONVENTIONS) {
      expect(isDenied(secret)).toBe(true);
    }
  });

  it("no registered pattern collides with a DEFAULT_DENY_PATTERN basename", () => {
    const denyBasenames = new Set(DEFAULT_DENY_PATTERNS.map((p) => p.toLowerCase()));
    for (const pattern of patterns) {
      expect(denyBasenames.has(pattern.toLowerCase())).toBe(false);
    }
  });
});

describe("ecosystems registry — routing patterns (deterministic, ReDoS-safe, precise)", () => {
  it("classifies an ecosystem question via at least one routing pattern", () => {
    const matches = (text: string): readonly string[] =>
      ecosystemMetadataIntentPatterns.filter((p) => p.pattern.test(text)).map((p) => p.term);
    expect(matches("Which Java version does this project use?")).toContain("java");
    expect(matches("Welche Go-Version nutzt dieses Modul?")).toContain("go");
    expect(matches("What Rust edition is configured?")).toContain("rust");
    expect(matches("Which Python version is required?")).toContain("python");
    expect(matches("Which .NET target framework is used?")).toContain("dotnet");
  });

  it("does NOT misroute ordinary code questions or near-collisions", () => {
    const anyMatch = (text: string): boolean =>
      ecosystemMetadataIntentPatterns.some((p) => p.pattern.test(text));
    // "go to", "build a feature" etc. must not trip Go/Gradle routing (bare ambiguous terms are
    // deliberately excluded from the registry).
    expect(anyMatch("How do I go to the settings page?")).toBe(false);
    expect(anyMatch("Where do we build the user object?")).toBe(false);
    expect(anyMatch("How is ZodConfigSchema used in this repository?")).toBe(false);
  });

  it("routing patterns are stable across reads (deterministic order)", () => {
    const a = ecosystemMetadataIntentPatterns.map((p) => `${p.term}:${p.pattern.source}`);
    const b = ecosystemMetadataIntentPatterns.map((p) => `${p.term}:${p.pattern.source}`);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("technical phrases inject manifest content tokens for ecosystem questions", () => {
    const javaTokens = ecosystemTechnicalPhrases
      .filter((p) => p.pattern.test("Which Java version is used?"))
      .map((p) => p.term);
    expect(javaTokens).toContain("maven.compiler");
  });

  it("technical phrases match all routing terms, not only the first term", () => {
    const javaTokens = ecosystemTechnicalPhrases
      .filter((p) => p.pattern.test("Which JDK version is used?"))
      .map((p) => p.term);
    expect(javaTokens).toContain("maven.compiler");
  });

  it("exposes registry-derived version declaration patterns for core ecosystems", () => {
    const declarationsFor = (query: string, line: string): readonly string[] =>
      ecosystemVersionDeclarationPatterns
        .filter((entry) => entry.routePattern.test(query) && entry.declarationPattern.test(line))
        .map((entry) => entry.ecosystem);

    expect(
      declarationsFor("Which Java version?", "<maven.compiler.release>21</maven.compiler.release>"),
    ).toContain("java");
    expect(declarationsFor("Which Go toolchain?", "toolchain go1.23.2")).toContain("go");
    expect(declarationsFor("Which Rust edition?", 'edition = "2021"')).toContain("rust");
    expect(declarationsFor("Which Python version?", 'requires-python = ">=3.11"')).toContain(
      "python",
    );
    expect(declarationsFor("Which Docker base image?", "FROM eclipse-temurin:21-jre")).toContain(
      "docker",
    );
    expect(declarationsFor("Which GraphQL schema?", "schema: ./schema.graphql")).toContain(
      "graphql",
    );
  });

  it("version declaration routing stays linear on adversarial input", () => {
    const text = `${"java_".repeat(10_000)} version`;
    const started = Date.now();
    const matched = ecosystemVersionDeclarationPatterns.some((entry) =>
      entry.routePattern.test(text),
    );
    expect(typeof matched).toBe("boolean");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("ecosystems registry — invariants", () => {
  it("exposes 26 ecosystems and a frozen table", () => {
    expect(ECOSYSTEMS).toHaveLength(26);
    expect(Object.isFrozen(ECOSYSTEMS)).toBe(true);
  });

  it("CANONICAL_MANIFEST_BASENAMES is sorted, de-duplicated and covers the core build manifests", () => {
    expect([...CANONICAL_MANIFEST_BASENAMES]).toEqual([...CANONICAL_MANIFEST_BASENAMES].sort());
    expect(new Set(CANONICAL_MANIFEST_BASENAMES).size).toBe(CANONICAL_MANIFEST_BASENAMES.length);
    for (const name of [
      "pom.xml",
      "build.gradle",
      "go.mod",
      "Cargo.toml",
      "pyproject.toml",
      "package.json",
    ]) {
      expect(CANONICAL_MANIFEST_BASENAMES).toContain(name);
    }
  });
});
