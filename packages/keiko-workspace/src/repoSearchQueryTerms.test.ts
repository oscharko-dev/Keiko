import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { expandedQueryTerms } from "./repoSearchQueryTerms.js";

describe("expandedQueryTerms", () => {
  it("derives source identifiers from test-style names", () => {
    const terms = expandedQueryTerms("Where is PaymentServiceTest implemented?", false);
    expect(terms).toContain("paymentservicetest");
    expect(terms).toContain("paymentservice");
    expect(terms).toContain("payment");
    expect(terms).toContain("service");
  });

  it("derives path and symbol terms from stack-frame locations", () => {
    const terms = expandedQueryTerms(
      "TypeError at src/payments/AuthService.ts:42:13 in validateToken",
      false,
    );
    expect(terms).toContain("src/payments/authservice.ts");
    expect(terms).toContain("authservice");
    expect(terms).toContain("auth");
    expect(terms).toContain("service");
    expect(terms).toContain("validatetoken");
  });

  it("adds bounded domain aliases for common monorepo terms", () => {
    const frontend = expandedQueryTerms("Which package powers the frontend?", false);
    expect(frontend).toEqual(expect.arrayContaining(["frontend", "web", "ui", "client"]));

    const infra = expandedQueryTerms("Welche Infrastruktur-Version ist gesetzt?", false);
    expect(infra).toEqual(
      expect.arrayContaining(["infrastruktur", "terraform", "kubernetes", "helm"]),
    );
  });

  it("keeps pathological identifier input linear and bounded", () => {
    const query = `${"PaymentServiceTest ".repeat(20_000)} /api/${"x".repeat(100_000)}`;
    const start = performance.now();
    const terms = expandedQueryTerms(query, false);
    const elapsedMs = performance.now() - start;
    expect(terms.length).toBeLessThanOrEqual(48);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
