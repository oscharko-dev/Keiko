import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("feedback publication migration 003", () => {
  it("stores exact prepared bytes once and keeps delivery/linkage metadata content-free", async () => {
    const source = await readFile(
      new URL("../migrations/003_feedback_publication.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("feedback_publication_preparations");
    expect(source).toContain("title_bytes bytea");
    expect(source).toContain("body_bytes bytea");
    expect(source).toContain("feedback_publication_outbox");
    expect(source).toContain("feedback_github_issue_linkage");
    expect(source).toContain("feedback_publication_audit");
    expect(source).toContain("feedback_publication_idempotency");
    expect(source).toContain("may-have-committed");
    expect(source).toContain("manual-reconciliation");
    expect(source).toContain("cancelled-private");
    expect(source).not.toMatch(/private_key|installation_token|jwt|receipt_secret/iu);
  });

  it("pins prepared retention to 30 days, outbox to 7, and linkage/audit to 365", async () => {
    const source = await readFile(
      new URL("../migrations/003_feedback_publication.sql", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/preparation[^;]+interval '30 days'/isu);
    expect(source).toMatch(/outbox[^;]+interval '7 days'/isu);
    expect(source).toMatch(/linkage[^;]+interval '365 days'/isu);
    expect(source).toMatch(/audit[^;]+interval '365 days'/isu);
  });
});
