import { describe, expect, it } from "vitest";
import { asQualityIntelligenceSourceEnvelopeId } from "../ids.js";
import {
  QUALITY_INTELLIGENCE_SOURCE_KINDS,
  looksLikeBrowserSafeSourceEnvelope,
} from "../sourceEnvelope.js";
import type {
  QualityIntelligenceSourceEnvelope,
  QualityIntelligenceSourceKind,
} from "../sourceEnvelope.js";
import { assertQualityIntelligenceNever } from "../assertNever.js";

const ZERO_HASH = "0".repeat(64);

const makeRepo = (): QualityIntelligenceSourceEnvelope => ({
  kind: "repository-context",
  id: asQualityIntelligenceSourceEnvelopeId("env-repo-01"),
  displayLabel: "workspace/foo",
  provenance: {
    origin: "workspace",
    registeredAt: "2026-06-05T00:00:00Z",
    integrityHashSha256Hex: ZERO_HASH,
  },
  localRef: "scope:foo",
});

const makeCapsule = (): QualityIntelligenceSourceEnvelope => ({
  kind: "local-knowledge-capsule",
  id: asQualityIntelligenceSourceEnvelopeId("env-cap-01"),
  displayLabel: "capsule-foo",
  provenance: {
    origin: "capsule:foo",
    registeredAt: "2026-06-05T00:00:00Z",
    integrityHashSha256Hex: ZERO_HASH,
  },
  localRef: "cap:foo:section-1",
});

const makeFigma = (): QualityIntelligenceSourceEnvelope => ({
  kind: "figma-evidence",
  id: asQualityIntelligenceSourceEnvelopeId("env-fig-01"),
  displayLabel: "design-sketch-1",
  provenance: {
    origin: "figma-cache",
    registeredAt: "2026-06-05T00:00:00Z",
    integrityHashSha256Hex: ZERO_HASH,
  },
  localRef: "figma-cache:abc",
});

const makeHuman = (): QualityIntelligenceSourceEnvelope => ({
  kind: "human-context",
  id: asQualityIntelligenceSourceEnvelopeId("env-hum-01"),
  displayLabel: "human-note-1",
  provenance: {
    origin: "conversation-center",
    registeredAt: "2026-06-05T00:00:00Z",
    integrityHashSha256Hex: ZERO_HASH,
  },
  localRef: "cc:note:1",
});

const makeConnector = (): QualityIntelligenceSourceEnvelope => ({
  kind: "connector-document",
  id: asQualityIntelligenceSourceEnvelopeId("env-con-01"),
  displayLabel: "connector-doc-1",
  provenance: {
    origin: "connector",
    registeredAt: "2026-06-05T00:00:00Z",
    integrityHashSha256Hex: ZERO_HASH,
  },
  localRef: "connector:adapter:doc-1",
  adapterId: "adapter-x",
});

const exhaustive = (e: QualityIntelligenceSourceEnvelope): string => {
  switch (e.kind) {
    case "repository-context":
      return e.kind;
    case "local-knowledge-capsule":
      return e.kind;
    case "figma-evidence":
      return e.kind;
    case "human-context":
      return e.kind;
    case "connector-document":
      return e.kind;
    default:
      return assertQualityIntelligenceNever(e);
  }
};

describe("QualityIntelligenceSourceEnvelope", () => {
  it("enumerates all five kinds", () => {
    expect(QUALITY_INTELLIGENCE_SOURCE_KINDS).toEqual<readonly QualityIntelligenceSourceKind[]>([
      "repository-context",
      "local-knowledge-capsule",
      "figma-evidence",
      "human-context",
      "connector-document",
    ]);
  });

  it("exhaustively narrows over the discriminant", () => {
    for (const env of [makeRepo(), makeCapsule(), makeFigma(), makeHuman(), makeConnector()]) {
      expect(exhaustive(env)).toBe(env.kind);
    }
  });

  it("round-trips through JSON.stringify / parse", () => {
    const env = makeRepo();
    const parsed = JSON.parse(JSON.stringify(env)) as QualityIntelligenceSourceEnvelope;
    expect(parsed).toEqual(env);
  });
});

describe("looksLikeBrowserSafeSourceEnvelope", () => {
  it("accepts a clean envelope", () => {
    expect(looksLikeBrowserSafeSourceEnvelope(makeRepo())).toBe(true);
  });
  it("rejects an envelope whose displayLabel contains a URL", () => {
    const env = { ...makeRepo(), displayLabel: "see https://example.com/foo" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects an envelope whose localRef contains a URL", () => {
    const env = { ...makeRepo(), localRef: "https://example.com/foo" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects an envelope with an oversized displayLabel", () => {
    const env = { ...makeRepo(), displayLabel: "x".repeat(257) };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects an envelope with an empty displayLabel", () => {
    const env = { ...makeRepo(), displayLabel: "" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects an envelope whose displayLabel looks like base64", () => {
    const env = { ...makeRepo(), displayLabel: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects an envelope with a malformed integrity hash", () => {
    const env = {
      ...makeRepo(),
      provenance: { ...makeRepo().provenance, integrityHashSha256Hex: "not-hex" },
    };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });

  // --- new negative tests (Issue #277 AC1 hardening) ---

  it("rejects a localRef containing a credential (AKIA)", () => {
    const env = { ...makeRepo(), localRef: "tok:AKIAIOSFODNN7EXAMPLE" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a localRef with a non-http scheme (ftp)", () => {
    const env = { ...makeRepo(), localRef: "ftp://internal/dump" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a localRef with a non-http scheme (s3)", () => {
    const env = { ...makeRepo(), localRef: "s3://bucket/creds.json" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a localRef with a non-http scheme (file)", () => {
    const env = { ...makeRepo(), localRef: "file:///etc/passwd" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a localRef that is an absolute POSIX path", () => {
    const env = { ...makeRepo(), localRef: "/Users/alice/secret" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a provenance.origin containing a URL", () => {
    const env = {
      ...makeRepo(),
      provenance: { ...makeRepo().provenance, origin: "https://internal-endpoint/secret" },
    };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a connector-document with a leaky adapterId (URL)", () => {
    const env = { ...makeConnector(), adapterId: "https://evil.example.com/token" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a connector-document with a credential in adapterId (ghp_)", () => {
    const env = { ...makeConnector(), adapterId: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("accepts a clean connector-document envelope", () => {
    expect(looksLikeBrowserSafeSourceEnvelope(makeConnector())).toBe(true);
  });
});
