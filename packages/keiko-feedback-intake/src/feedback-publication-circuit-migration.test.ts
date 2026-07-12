import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback publication circuit migration 005", () => {
  it("persists content-free bounded installation circuit and probe state", async () => {
    const source = await readFile(
      new URL("../migrations/005_feedback_publication_circuit.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("feedback_publication_installation_circuits");
    expect(source).toContain("consecutive_failures BETWEEN 0 AND 3");
    expect(source).toContain("probe_owner uuid");
    expect(source).toContain("expires_at = updated_at + interval '7 days'");
    expect(source).toContain("feedback_publication_installation_circuits_expiry_idx");
    expect(source).not.toMatch(/title_bytes|body_bytes|canonical_bytes|marker|token|secret/iu);
    expect(source).toContain(
      "INSERT INTO feedback_schema_migrations (version, applied_at) VALUES (5, now())",
    );
  });
});
