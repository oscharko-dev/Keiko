import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  producerLineageFailures,
  TOOL_CATALOG_PRODUCER_LINEAGE_PATH,
} from "../check-tool-catalog-conformance.mjs";

// ADR-0175 amendment (PR #3452): a producer change after the H1 landing is admitted only through an
// append-only lineage of owner-issued checkpoints that starts at the durable record's identity, with
// SHA-256-pinned verification and independent-review receipts per entry. These fixtures are
// hermetic: the current producer identity is injected, so no real catalog is compiled.

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PROFILE = { id: "opencode", version: 1 };
const RECORD_IDENTITY = { catalogRevision: "a".repeat(64), projectionDigest: "b".repeat(64) };
const RECORD = { ...RECORD_IDENTITY, profile: PROFILE };
const FIRST = { catalogRevision: "c".repeat(64), projectionDigest: "d".repeat(64) };
const SECOND = { catalogRevision: "e".repeat(64), projectionDigest: "f".repeat(64) };
const SOURCE = "1".repeat(40);
const HANDLERS = "9".repeat(64);

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-producer-lineage-"));
  roots.push(root);
  return root;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function verificationReceipt(sequence, identity, overrides = {}) {
  return {
    schemaVersion: 1,
    status: "verified",
    verificationKind: "deterministic-production-managed",
    sequence,
    sourceCommit: SOURCE,
    ...identity,
    command: "npx vitest run packages/keiko-tool-catalog/src",
    testFiles: 4,
    testCount: 40,
    result: "passed",
    ...overrides,
  };
}

function reviewReceipt(sequence, identity, overrides = {}) {
  return {
    schemaVersion: 1,
    status: "accepted",
    reviewKind: "independent-source-and-evidence-audit",
    sequence,
    sourceCommit: SOURCE,
    ...identity,
    handlerSetDigest: HANDLERS,
    reviewer: "independent-agent",
    criteria: [{ label: "budget-derived-from-enforced-limits", result: "verified" }],
    ...overrides,
  };
}

// Writes both receipts for one entry and returns the entry with its pinned references.
function entry(root, sequence, predecessor, identity, receipts = {}) {
  const refs = {};
  for (const [kind, build] of [
    ["verification", verificationReceipt],
    ["review", reviewReceipt],
  ]) {
    const path = `docs/qa/evidence/tool-catalog-producer-${String(sequence)}-${kind}.v1.json`;
    const bytes = `${JSON.stringify(build(sequence, identity, receipts[kind]), null, 2)}\n`;
    write(root, path, bytes);
    refs[kind] = `${path}#sha256=${sha256Hex(bytes)}`;
  }
  return {
    sequence,
    predecessor,
    ...identity,
    handlerSetDigest: HANDLERS,
    sourceCommit: SOURCE,
    integrationPr: 3452,
    reason: "verification-budget-derived-from-enforced-limits",
    verificationRef: refs.verification,
    reviewRef: refs.review,
  };
}

function writeLineage(root, entries, overrides = {}) {
  write(
    root,
    TOOL_CATALOG_PRODUCER_LINEAGE_PATH,
    JSON.stringify({ schemaVersion: 1, profile: PROFILE, entries, ...overrides }),
  );
}

function failuresWith(root, current) {
  return producerLineageFailures(root, RECORD, { identity: () => Promise.resolve(current) });
}

describe("tool-catalog producer lineage", () => {
  it("accepts the unchanged producer without reading any lineage", async () => {
    expect(await failuresWith(fixtureRoot(), RECORD_IDENTITY)).toEqual([]);
  });

  it("reports the historical mismatch when a changed producer has no lineage", async () => {
    expect(await failuresWith(fixtureRoot(), FIRST)).toEqual([
      "H1 handoff evidence identity mismatch: catalogRevision does not match the current producer",
      "H1 handoff evidence identity mismatch: projectionDigest does not match the current producer",
    ]);
  });

  it("accepts a producer reached through one owner-issued checkpoint", async () => {
    const root = fixtureRoot();
    writeLineage(root, [entry(root, 1, RECORD_IDENTITY, FIRST)]);
    expect(await failuresWith(root, FIRST)).toEqual([]);
  });

  it("accepts a producer reached through a chain of checkpoints", async () => {
    const root = fixtureRoot();
    writeLineage(root, [entry(root, 1, RECORD_IDENTITY, FIRST), entry(root, 2, FIRST, SECOND)]);
    expect(await failuresWith(root, SECOND)).toEqual([]);
  });

  it("refuses a producer changed again after the last checkpoint", async () => {
    const root = fixtureRoot();
    writeLineage(root, [entry(root, 1, RECORD_IDENTITY, FIRST)]);
    expect(await failuresWith(root, SECOND)).toEqual([
      "tool-catalog producer lineage stale: the current producer is not the lineage's last identity",
    ]);
  });

  it("refuses a lineage that does not start at the durable record", async () => {
    const root = fixtureRoot();
    writeLineage(root, [entry(root, 1, SECOND, FIRST)]);
    expect(await failuresWith(root, FIRST)).toEqual([
      "tool-catalog producer lineage broken: entry 1 does not continue the identity before it",
    ]);
  });

  it("refuses a receipt changed after it was pinned", async () => {
    const root = fixtureRoot();
    writeLineage(root, [entry(root, 1, RECORD_IDENTITY, FIRST)]);
    write(
      root,
      "docs/qa/evidence/tool-catalog-producer-1-verification.v1.json",
      `${JSON.stringify(verificationReceipt(1, FIRST, { testCount: 41 }), null, 2)}\n`,
    );
    expect(await failuresWith(root, FIRST)).toEqual([
      "tool-catalog producer lineage entry 1 has a stale verification receipt",
    ]);
  });

  it("refuses receipts that do not certify the entry", async () => {
    const root = fixtureRoot();
    writeLineage(root, [
      entry(root, 1, RECORD_IDENTITY, FIRST, {
        verification: { result: "failed" },
        review: { criteria: [{ label: "budget-derived-from-enforced-limits", result: "open" }] },
      }),
    ]);
    expect(await failuresWith(root, FIRST)).toEqual([
      "tool-catalog producer lineage entry 1 verification receipt does not bind it",
      "tool-catalog producer lineage entry 1 review receipt does not bind it",
    ]);
  });

  it("refuses a receipt bound to another identity", async () => {
    const root = fixtureRoot();
    writeLineage(root, [
      entry(root, 1, RECORD_IDENTITY, FIRST, {
        review: { catalogRevision: SECOND.catalogRevision },
      }),
    ]);
    expect(await failuresWith(root, FIRST)).toEqual([
      "tool-catalog producer lineage entry 1 review receipt does not bind it",
    ]);
  });

  it("refuses a sequence gap, a foreign profile and unparsable lineage", async () => {
    const gap = fixtureRoot();
    writeLineage(gap, [entry(gap, 2, RECORD_IDENTITY, FIRST)]);
    expect(await failuresWith(gap, FIRST)).toEqual([
      "tool-catalog producer lineage entry 1 malformed",
    ]);

    const foreign = fixtureRoot();
    writeLineage(foreign, [entry(foreign, 1, RECORD_IDENTITY, FIRST)], {
      profile: { id: "opencode", version: 2 },
    });
    expect(await failuresWith(foreign, FIRST)).toEqual([
      "tool-catalog producer lineage profile does not match the record",
    ]);

    const broken = fixtureRoot();
    write(broken, TOOL_CATALOG_PRODUCER_LINEAGE_PATH, "{ not json");
    expect(await failuresWith(broken, FIRST)).toEqual([
      "tool-catalog producer lineage malformed: not valid JSON",
    ]);
  });

  it("reports an uncompilable producer as a record identity failure", async () => {
    expect(
      await producerLineageFailures(fixtureRoot(), RECORD, {
        identity: () => Promise.reject(new Error("producer build missing")),
      }),
    ).toEqual([
      "H1 handoff evidence identity mismatch: durable record's profile cannot be compiled by the current producer",
    ]);
  });
});
