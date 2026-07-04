// Model-independent repository-retrieval benchmark (enterprise retrieval, Milestone 1).
//
// Each case is a synthetic, fully in-memory polyglot fixture with a GOLDEN expectation about which
// file the retrieval layer must surface FIRST (and which must NOT be surfaced). It evaluates the
// deterministic retrieval ranking — candidate discovery -> policy bucketing -> lexical scan — in
// isolation from any model answer, exactly as the acceptance criteria require. The intent is passed
// via searchHints (as the grounded orchestrator does after classifyRetrievalIntent); intent
// CLASSIFICATION itself is covered by keiko-workflows/planner/intent.test.ts.
//
// All fixtures are synthetic — no customer data, no secrets — per the operating rules.

import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import type { SearchIntent } from "./repoSearchPolicy.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function scopeFor(files: Readonly<Record<string, string>>): {
  scope: SearchScope;
  fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "polyglot-fixture",
    version: "0.0.0",
    testFramework: "unknown",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "bench", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function nlq(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

interface BenchCase {
  readonly id: string;
  readonly category: string;
  readonly files: Readonly<Record<string, string>>;
  readonly query: string;
  readonly intent: SearchIntent;
  // The scopePath that MUST be the top-ranked evidence atom.
  readonly expectTop: string;
  // When present, the first emitted atom for expectTop must cite a declaration/evidence line that
  // matches this pattern.
  readonly expectLinePattern?: RegExp;
  // scopePaths that must NOT appear in the emitted atoms (e.g. prose decoys that lost, or
  // generated artifacts that should be omitted).
  readonly mustNotInclude?: readonly string[];
}

const POM_JAVA21 = [
  "<project>",
  "  <properties>",
  "    <maven.compiler.release>21</maven.compiler.release>",
  "    <java.version>21</java.version>",
  "  </properties>",
  "</project>",
  "",
].join("\n");

const README_JAVA8_DECOY = [
  "# Legacy Service",
  "",
  "Historically this project targeted Java 8. The prose in this README is out of date;",
  "the authoritative Java version lives in the build manifest.",
  "",
].join("\n");

const CASES: readonly BenchCase[] = [
  {
    id: "java-maven-version",
    category: "project-metadata",
    files: {
      "README.md": README_JAVA8_DECOY,
      "pom.xml": POM_JAVA21,
      "src/main/java/com/acme/App.java": "package com.acme;\npublic class App {}\n",
    },
    query: "Which Java version does this project use?",
    intent: "project-metadata",
    expectTop: "pom.xml",
    expectLinePattern: /maven\.compiler\.release|java\.version/iu,
  },
  {
    id: "java-gradle-version",
    category: "project-metadata",
    files: {
      "README.md": "Overview of the gateway.\n",
      "build.gradle": [
        "plugins { id 'java' }",
        "java {",
        "  sourceCompatibility = JavaVersion.VERSION_21",
        "}",
        "",
      ].join("\n"),
    },
    query: "Welche Java-Version nutzt dieses Gradle-Projekt?",
    intent: "project-metadata",
    expectTop: "build.gradle",
    expectLinePattern: /sourceCompatibility/iu,
  },
  {
    id: "go-version",
    category: "project-metadata",
    files: {
      "README.md": "The service is written in Go.\n",
      "go.mod": "module github.com/acme/svc\n\ngo 1.23.0\n\ntoolchain go1.23.2\n",
      "main.go": "package main\nfunc main() {}\n",
    },
    query: "Which Go version and toolchain does this module require?",
    intent: "project-metadata",
    expectTop: "go.mod",
    expectLinePattern: /^(go|toolchain)\s/iu,
  },
  {
    id: "rust-edition",
    category: "project-metadata",
    files: {
      "README.md": "A Rust crate.\n",
      "Cargo.toml": '[package]\nname = "svc"\nedition = "2021"\nrust-version = "1.80"\n',
      "src/lib.rs": "pub fn run() {}\n",
    },
    query: "What Rust edition and rust-version does this crate target?",
    intent: "project-metadata",
    expectTop: "Cargo.toml",
    expectLinePattern: /edition|rust-version/iu,
  },
  {
    id: "python-requires",
    category: "project-metadata",
    files: {
      "README.md": "A Python package.\n",
      "pyproject.toml": '[project]\nname = "svc"\nrequires-python = ">=3.11"\n',
      "src/svc/__init__.py": "VERSION = '1'\n",
    },
    query: "Which Python version is required (requires-python)?",
    intent: "project-metadata",
    expectTop: "pyproject.toml",
    expectLinePattern: /requires-python/iu,
  },
  {
    id: "node-engines-no-regression",
    category: "project-metadata",
    files: {
      "README.md": "A Node app.\n",
      "package.json": '{\n  "engines": { "node": ">=20" },\n  "packageManager": "pnpm@9.7.0"\n}\n',
    },
    query: "Which Node version and package manager does this project use?",
    intent: "project-metadata",
    expectTop: "package.json",
    expectLinePattern: /engines|packageManager/u,
  },
  {
    id: "typescript-target",
    category: "project-metadata",
    files: {
      "README.md": "A TypeScript workspace.\n",
      "tsconfig.json": '{\n  "compilerOptions": {\n    "target": "ES2022"\n  }\n}\n',
      "package.json": '{\n  "devDependencies": { "typescript": "^5.5.4" }\n}\n',
    },
    query: "Which TypeScript compiler target in tsconfig is configured?",
    intent: "project-metadata",
    expectTop: "tsconfig.json",
    expectLinePattern: /target/iu,
  },
  {
    id: "docs-vs-code-negative-java",
    category: "docs-vs-code",
    files: {
      // README mentions an OUTDATED Java version as prose; the canonical manifest must win.
      "docs/setup.md":
        "Install Java 8 to build (outdated).\nThe project uses Java 8 per this guide.\n",
      "README.md": README_JAVA8_DECOY,
      "pom.xml": POM_JAVA21,
    },
    query: "Which Java version does the project compile against?",
    intent: "project-metadata",
    expectTop: "pom.xml",
    expectLinePattern: /maven\.compiler\.release|java\.version/iu,
  },
  {
    id: "polyglot-monorepo-service-local",
    category: "polyglot-monorepo",
    files: {
      "README.md": "Monorepo root.\n",
      // Root aggregator manifest (shallower) competes with the service-local one.
      "pom.xml": "<project><modules><module>payments</module></modules></project>\n",
      "services/payments/pom.xml": POM_JAVA21,
      "services/gateway/go.mod": "module acme/gateway\n\ngo 1.22\n",
    },
    query: "Which Java version does the payments service use?",
    intent: "project-metadata",
    // The service-local manifest (named in the query) must outrank both the root manifest and the
    // unrelated Go service manifest.
    expectTop: "services/payments/pom.xml",
    expectLinePattern: /maven\.compiler\.release|java\.version/iu,
  },
  {
    id: "generated-avoidance",
    category: "generated-avoidance",
    files: {
      "src/main/java/com/acme/Service.java":
        "package com.acme;\nclass Service { String version; }\n",
      // Generated artifacts that must be omitted, not flood the candidates.
      "target/classes/com/acme/Service.class": "version version version\n",
      "build/generated/Stub.java": "version version\n",
      "api/user.pb.go": "// generated\npackage api\nvar version = 1\n",
    },
    query: "Where is the Service version field defined?",
    intent: "targeted-code-search",
    expectTop: "src/main/java/com/acme/Service.java",
    mustNotInclude: [
      "target/classes/com/acme/Service.class",
      "build/generated/Stub.java",
      "api/user.pb.go",
    ],
  },
  {
    id: "api-route-express",
    category: "api-route",
    files: {
      "README.md": "The API exposes POST /api/payments/:id/refund for refunds.\n",
      "src/http/routes.ts":
        'router.post("/api/payments/:id/refund", async (req, res) => refundPayment(req, res));\n',
      "tests/http/routes.test.ts": "it('POST refund route returns 200', () => {});\n",
    },
    query: "Which file implements the POST /api/payments/:id/refund route?",
    intent: "targeted-code-search",
    expectTop: "src/http/routes.ts",
    expectLinePattern: /router\.post.*\/api\/payments\/:id\/refund/iu,
  },
  {
    id: "test-name-to-source",
    category: "test-to-source",
    files: {
      "src/payments/PaymentService.ts":
        "export class PaymentService {\n  authorize(): boolean { return true; }\n}\n",
      "tests/payments/PaymentService.test.ts":
        'describe("PaymentServiceTest", () => it("covers authorize", () => {}));\n',
      "docs/payment-service.md": "PaymentServiceTest verifies the old payment flow.\n",
    },
    query: "Where is the source implementation for PaymentServiceTest?",
    intent: "targeted-code-search",
    expectTop: "src/payments/PaymentService.ts",
    expectLinePattern: /class\s+PaymentService/iu,
  },
  {
    id: "same-candidates-api-client",
    category: "query-aware-ranking",
    files: {
      "docs/auth-debugging.md": "ApiClient and TokenValidator are both part of auth debugging.\n",
      "src/auth/ApiClient.ts":
        "export class ApiClient {\n  timeoutMs = 5000;\n  handleTimeout(): void {}\n}\n",
      "src/auth/TokenValidator.ts":
        "export class TokenValidator {\n  rejectExpiredJwt(): boolean { return true; }\n}\n",
    },
    query: "Where is ApiClient timeout handling implemented?",
    intent: "targeted-code-search",
    expectTop: "src/auth/ApiClient.ts",
    expectLinePattern: /ApiClient|timeout/iu,
  },
  {
    id: "same-candidates-token-validator",
    category: "query-aware-ranking",
    files: {
      "docs/auth-debugging.md": "ApiClient and TokenValidator are both part of auth debugging.\n",
      "src/auth/ApiClient.ts":
        "export class ApiClient {\n  timeoutMs = 5000;\n  handleTimeout(): void {}\n}\n",
      "src/auth/TokenValidator.ts":
        "export class TokenValidator {\n  rejectExpiredJwt(): boolean { return true; }\n}\n",
    },
    query: "Where does TokenValidator reject expired JWTs?",
    intent: "targeted-code-search",
    expectTop: "src/auth/TokenValidator.ts",
    expectLinePattern: /TokenValidator|rejectExpiredJwt/iu,
  },
  {
    id: "short-identifier-api-id-url",
    category: "query-aware-ranking",
    files: {
      "docs/api.md": "The API id url constant is discussed in this document.\n",
      "src/http/ApiIdUrlMapper.ts":
        'export const API_ID_URL = "/api/id";\nexport function mapApiIdUrl(): string { return API_ID_URL; }\n',
    },
    query: "Which API id url constant is defined in source?",
    intent: "targeted-code-search",
    expectTop: "src/http/ApiIdUrlMapper.ts",
    expectLinePattern: /API_ID_URL|mapApiIdUrl/u,
  },
  {
    id: "stacktrace-source-location",
    category: "diagnostic-search",
    files: {
      "src/payments/AuthService.ts":
        "export class AuthService {\n  validateToken(): void { throw new Error('boom'); }\n}\n",
      "docs/errors.md": "Auth failures can mention validateToken in prose.\n",
    },
    query: "TypeError: boom at src/payments/AuthService.ts:42:13 in validateToken",
    intent: "diagnostic-search",
    expectTop: "src/payments/AuthService.ts",
    expectLinePattern: /AuthService|validateToken/u,
  },
  {
    id: "dotnet-target-framework",
    category: "project-metadata",
    files: {
      "README.md": "A .NET service.\n",
      "src/Api/Api.csproj":
        "<Project>\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <LangVersion>12.0</LangVersion>\n  </PropertyGroup>\n</Project>\n",
    },
    query: "Which .NET target framework does this project use?",
    intent: "project-metadata",
    expectTop: "src/Api/Api.csproj",
    expectLinePattern: /TargetFramework|LangVersion/u,
  },
  {
    id: "cpp-cmake-standard",
    category: "project-metadata",
    files: {
      "README.md": "A C++ engine.\n",
      "CMakeLists.txt":
        "cmake_minimum_required(VERSION 3.25)\nproject(engine)\nset(CMAKE_CXX_STANDARD 20)\n",
    },
    query: "What C++ standard does CMake enforce here?",
    intent: "project-metadata",
    expectTop: "CMakeLists.txt",
    expectLinePattern: /CMAKE_CXX_STANDARD|cmake_minimum_required/u,
  },
  {
    id: "terraform-required-version",
    category: "project-metadata",
    files: {
      "README.md": "Infra as code.\n",
      "versions.tf":
        'terraform {\n  required_version = ">= 1.9.0"\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n',
    },
    query: "Which Terraform version does this configuration require?",
    intent: "project-metadata",
    expectTop: "versions.tf",
    expectLinePattern: /required_version/iu,
  },
  {
    id: "docker-base-image",
    category: "project-metadata",
    files: {
      "README.md": "Container build notes mention Java 8 historically.\n",
      Dockerfile: "FROM eclipse-temurin:21-jre\nCOPY . /app\n",
    },
    query: "Which Docker base image version is used?",
    intent: "project-metadata",
    expectTop: "Dockerfile",
    expectLinePattern: /^FROM\s/iu,
  },
  {
    id: "kubernetes-helm-kubeversion",
    category: "project-metadata",
    files: {
      "README.md": "Deploys to Kubernetes.\n",
      "Chart.yaml": 'apiVersion: v2\nname: svc\nkubeVersion: ">=1.27.0"\nappVersion: "1.4.0"\n',
    },
    query: "Which Kubernetes kubeVersion does the Helm chart target?",
    intent: "project-metadata",
    expectTop: "Chart.yaml",
    expectLinePattern: /apiVersion|kubeVersion|appVersion/u,
  },
  {
    id: "php-composer-require",
    category: "project-metadata",
    files: {
      "README.md": "A PHP app.\n",
      "composer.json": '{\n  "require": { "php": ">=8.2" }\n}\n',
    },
    query: "What PHP version does composer require?",
    intent: "project-metadata",
    expectTop: "composer.json",
    expectLinePattern: /"php"\s*:/iu,
  },
  {
    id: "ruby-version-file",
    category: "project-metadata",
    files: {
      "README.md": "A Ruby gem.\n",
      Gemfile: 'source "https://rubygems.org"\nruby "3.3.4"\n',
    },
    query: "Which Ruby version is pinned for this project?",
    intent: "project-metadata",
    expectTop: "Gemfile",
    expectLinePattern: /^ruby\s/iu,
  },
  {
    id: "swift-tools-version",
    category: "project-metadata",
    files: {
      "README.md": "A Swift package.\n",
      "Package.swift": "// swift-tools-version:6.0\nimport PackageDescription\n",
    },
    query: "Which Swift tools version does this package use?",
    intent: "project-metadata",
    expectTop: "Package.swift",
    expectLinePattern: /swift-tools-version/iu,
  },
  {
    id: "protobuf-syntax",
    category: "project-metadata",
    files: {
      "README.md": "Protocol buffer schemas.\n",
      "api/user.proto": 'syntax = "proto3";\npackage acme.user;\nmessage User {}\n',
    },
    query: "Which protobuf syntax version is used?",
    intent: "project-metadata",
    expectTop: "api/user.proto",
    expectLinePattern: /^syntax\s*=/iu,
  },
  {
    id: "openapi-version",
    category: "project-metadata",
    files: {
      "README.md": "REST API docs.\n",
      "openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: API\n  version: 1.0.0\n",
    },
    query: "Which OpenAPI version does the API spec use?",
    intent: "project-metadata",
    expectTop: "openapi.yaml",
    expectLinePattern: /^openapi\s*:/iu,
  },
  {
    id: "graphql-codegen-schema",
    category: "project-metadata",
    files: {
      "README.md": "GraphQL schema notes.\n",
      "codegen.yml":
        "schema: ./schema.graphql\ngenerates:\n  src/generated.ts:\n    plugins:\n      - typescript\n",
    },
    query: "Where is the GraphQL codegen schema configured?",
    intent: "project-metadata",
    expectTop: "codegen.yml",
    expectLinePattern: /^schema\s*:/iu,
  },
  {
    id: "docs-vs-code-negative-go",
    category: "docs-vs-code",
    files: {
      // README states an OUTDATED Go version as prose; go.mod is authoritative.
      "README.md":
        "This service was written for Go 1.18 originally.\nWe use Go 1.18 historically.\n",
      "go.mod": "module acme/svc\n\ngo 1.23.0\n\ntoolchain go1.23.2\n",
    },
    query: "Which Go version does this module target?",
    intent: "project-metadata",
    expectTop: "go.mod",
    expectLinePattern: /^(go|toolchain)\s/iu,
  },
];

function caseById(id: string): BenchCase {
  const found = CASES.find((x) => x.id === id);
  if (found === undefined) {
    throw new Error(`unknown bench case: ${id}`);
  }
  return found;
}

describe("repository-retrieval benchmark — golden top-k over synthetic polyglot fixtures", () => {
  for (const c of CASES) {
    it(`[${c.category}] ${c.id}: surfaces ${c.expectTop} first`, async () => {
      const { scope, fs } = scopeFor(c.files);
      const result = await searchText(scope, nlq(c.query), DEFAULT_SEARCH_LIMITS, {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: c.intent },
      });
      const paths = result.atoms.map((a) => a.scopePath);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0]).toBe(c.expectTop);
      if (c.expectLinePattern !== undefined) {
        const topAtoms = result.atoms.filter((atom) => atom.scopePath === c.expectTop);
        expect(topAtoms.length).toBeGreaterThan(0);
        const bestTopAtom = topAtoms.reduce((best, atom) =>
          atom.score > best.score ? atom : best,
        );
        expect(bestTopAtom.lineRange).toBeDefined();
        const range = bestTopAtom.lineRange;
        const excerpt = await readExcerpt(
          scope,
          {
            scopePath: c.expectTop,
            startLine: range?.startLine ?? 1,
            endLine: range?.endLine ?? 1,
            maxBytes: 1024,
          },
          { fs, nowMs: FIXED_NOW },
        );
        expect(excerpt.content).toMatch(c.expectLinePattern);
      }
      for (const banned of c.mustNotInclude ?? []) {
        expect(paths).not.toContain(banned);
      }
    });
  }

  it("is deterministic: identical atom ordering across repeated runs", async () => {
    const c = caseById("java-maven-version");
    const run = async (): Promise<readonly string[]> => {
      const { scope, fs } = scopeFor(c.files);
      const r = await searchText(scope, nlq(c.query), DEFAULT_SEARCH_LIMITS, {
        fs,
        nowMs: FIXED_NOW,
        searchHints: { retrievalIntent: c.intent },
      });
      return r.atoms.map((a) => `${a.scopePath}:${(a.lineRange?.startLine ?? 0).toString()}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("returns evidence-bearing line ranges: the Java manifest excerpt contains the real version", async () => {
    const c = caseById("java-maven-version");
    const { scope, fs } = scopeFor(c.files);
    const result = await searchText(scope, nlq(c.query), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: c.intent },
    });
    // The manifest ranks first, and its matched lines (emitted in line order) include the real
    // version declaration. We read the excerpt of every pom.xml atom and assert the canonical Java
    // version line — not the README's outdated "Java 8" prose — is among the surfaced evidence.
    expect(result.atoms[0]?.scopePath).toBe("pom.xml");
    const pomAtoms = result.atoms.filter(
      (a) => a.scopePath === "pom.xml" && a.lineRange !== undefined,
    );
    expect(pomAtoms.length).toBeGreaterThan(0);
    const excerpts = await Promise.all(
      pomAtoms.map(async (a) => {
        const range = a.lineRange;
        if (range === undefined) {
          return "";
        }
        const excerpt = await readExcerpt(
          scope,
          {
            scopePath: "pom.xml",
            startLine: range.startLine,
            endLine: range.endLine,
            maxBytes: 4096,
          },
          { fs, nowMs: FIXED_NOW },
        );
        return excerpt.content;
      }),
    );
    const joined = excerpts.join("\n").toLowerCase();
    expect(joined).toMatch(/21/);
    expect(joined).toMatch(/maven\.compiler|java\.version/);
  });

  // M3: the version-declaration bonus must make the actual declaration line the HIGHEST-scoring
  // atom of the manifest (so its excerpt window is surfaced first), not merely present.
  it("scores the version-declaration line highest within the manifest (M3 line targeting)", async () => {
    const c = caseById("java-maven-version");
    const { scope, fs } = scopeFor(c.files);
    const result = await searchText(scope, nlq(c.query), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: c.intent },
    });
    const pomAtoms = result.atoms.filter(
      (a) => a.scopePath === "pom.xml" && a.lineRange !== undefined,
    );
    expect(pomAtoms.length).toBeGreaterThan(1);
    const top = pomAtoms.reduce((best, a) => (a.score > best.score ? a : best));
    const range = top.lineRange;
    expect(range).toBeDefined();
    const excerpt = await readExcerpt(
      scope,
      {
        scopePath: "pom.xml",
        startLine: range?.startLine ?? 1,
        endLine: range?.endLine ?? 1,
        maxBytes: 512,
      },
      { fs, nowMs: FIXED_NOW },
    );
    // The single highest-scoring pom.xml line is the maven.compiler / java.version declaration —
    // not the "<project>" opener that merely contains the query word "project".
    expect(excerpt.content.toLowerCase()).toMatch(/maven\.compiler|java\.version/);
    expect(excerpt.content).toMatch(/21/);
  });

  it("exposes explainable ranking diagnostics: the winning manifest carries its signal breakdown", async () => {
    const c = caseById("java-maven-version");
    const { scope, fs } = scopeFor(c.files);
    const result = await searchText(scope, nlq(c.query), DEFAULT_SEARCH_LIMITS, {
      fs,
      nowMs: FIXED_NOW,
      searchHints: { retrievalIntent: c.intent },
    });
    const ranked = result.diagnostics?.rankedCandidates ?? [];
    const pom = ranked.find((r) => r.scopePath === "pom.xml");
    expect(pom).toBeDefined();
    expect(pom?.bucket).toBe("canonical-metadata");
    expect(pom?.ecosystem).toBeDefined();
    // The signal breakdown justifies the selection: a canonical-metadata bucket contribution.
    expect(pom?.signals.some((s) => s.name === "bucket:canonical-metadata" && s.value > 0)).toBe(
      true,
    );
    // The README prose decoy ranks strictly below the manifest.
    const readme = ranked.find((r) => r.scopePath === "README.md");
    if (readme !== undefined && pom !== undefined) {
      expect(pom.score).toBeGreaterThan(readme.score);
    }
  });
});
