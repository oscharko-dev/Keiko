import { describe, expect, it } from "vitest";
import { lexicalRetrievalStrategy } from "./retrieval.js";
import type { DiscoveredFile, SelectionReason } from "./types.js";

function files(...paths: readonly string[]): readonly DiscoveredFile[] {
  return paths.map((p) => ({ relativePath: p, sizeBytes: 1 }));
}

function reasonOf(path: string): SelectionReason {
  const ranked = lexicalRetrievalStrategy.rank(files(path), undefined);
  return ranked[0]?.selectionReason ?? "source";
}

describe("lexicalRetrievalStrategy", () => {
  it("classifies entrypoints", () => {
    expect(reasonOf("src/index.ts")).toBe("entrypoint");
    expect(reasonOf("main.js")).toBe("entrypoint");
  });

  it("classifies manifests", () => {
    expect(reasonOf("package.json")).toBe("manifest");
    expect(reasonOf("tsconfig.json")).toBe("manifest");
  });

  it("classifies documentation", () => {
    expect(reasonOf("README.md")).toBe("documentation");
    expect(reasonOf("docs/guide.mdx")).toBe("documentation");
  });

  it("classifies config", () => {
    expect(reasonOf("eslint.config.js")).toBe("config");
    expect(reasonOf("settings.yaml")).toBe("config");
  });

  it("classifies tests", () => {
    expect(reasonOf("tests/foo.test.ts")).toBe("test");
    expect(reasonOf("src/bar.spec.ts")).toBe("test");
  });

  it("classifies remaining source", () => {
    expect(reasonOf("src/util.ts")).toBe("source");
  });

  it("orders by reason priority then path", () => {
    const ranked = lexicalRetrievalStrategy.rank(
      files("src/z.ts", "src/a.ts", "README.md", "src/index.ts"),
      undefined,
    );
    expect(ranked.map((r) => r.file.relativePath)).toEqual([
      "src/index.ts",
      "README.md",
      "src/a.ts",
      "src/z.ts",
    ]);
  });

  it("reorders the same candidates for materially different tasks", () => {
    const input = files(
      "README.md",
      "config/payments-url.yaml",
      "src/payments/PaymentService.ts",
      "tests/payments/PaymentService.test.ts",
    );
    const sourceFirst = lexicalRetrievalStrategy
      .rank(input, "Where is PaymentService implemented?")
      .map((r) => r.file.relativePath);
    const configFirst = lexicalRetrievalStrategy
      .rank(input, "Where is the payments url configured?")
      .map((r) => r.file.relativePath);
    expect(sourceFirst[0]).toBe("src/payments/PaymentService.ts");
    expect(configFirst[0]).toBe("config/payments-url.yaml");
    expect(sourceFirst).not.toEqual(configFirst);
  });

  it("lets query relevance outrank static selection buckets", () => {
    const ranked = lexicalRetrievalStrategy.rank(
      files("README.md", "package.json", "src/payments/refundPayment.ts"),
      "Where is refundPayment implemented?",
    );
    expect(ranked[0]?.file.relativePath).toBe("src/payments/refundPayment.ts");
  });

  it("is deterministic across calls for the same task", () => {
    const input = files("b.ts", "a.ts", "c.ts");
    expect(lexicalRetrievalStrategy.rank(input, "task")).toEqual(
      lexicalRetrievalStrategy.rank(input, "task"),
    );
  });

  it("breaks ties on equal selectionReason deterministically by path (returns 0 for equal paths)", () => {
    // Two source files at the same priority level must sort lexically; running the sort
    // twice on the same input must give identical output (stable tie-break, not -1/1 flip).
    const input = files("src/z.ts", "src/a.ts", "src/m.ts");
    const first = lexicalRetrievalStrategy.rank(input, undefined).map((r) => r.file.relativePath);
    const second = lexicalRetrievalStrategy.rank(input, undefined).map((r) => r.file.relativePath);
    expect(first).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
    expect(first).toEqual(second);
  });
});
