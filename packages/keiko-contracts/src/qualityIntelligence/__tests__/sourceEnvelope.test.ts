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
  it.each([
    {
      title: "rejects an envelope whose displayLabel contains a URL",
      displayLabel: "see https://example.com/foo",
    },
    {
      title: "rejects an envelope with an empty displayLabel",
      displayLabel: "",
    },
    {
      title: "rejects an envelope whose displayLabel looks like base64",
      displayLabel: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5",
    },
  ])("$title", ({ displayLabel }) => {
    const env = { ...makeRepo(), displayLabel };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });

  it.each([
    {
      title: "rejects an envelope whose localRef contains a URL",
      localRef: "https://example.com/foo",
    },
    {
      title: "rejects a localRef containing a credential (AKIA)",
      localRef: "tok:AKIAIOSFODNN7EXAMPLE",
    },
    {
      title: "rejects a localRef with a non-http scheme (ftp)",
      localRef: "ftp://internal/dump",
    },
    {
      title: "rejects a localRef with a non-http scheme (s3)",
      localRef: "s3://bucket/creds.json",
    },
    {
      title: "rejects a localRef with a non-http scheme (file)",
      localRef: "file:///etc/passwd",
    },
    {
      title: "rejects a localRef that is an absolute POSIX path",
      localRef: "/Users/alice/secret",
    },
  ])("$title", ({ localRef }) => {
    const env = { ...makeRepo(), localRef };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });

  it("rejects an envelope with an oversized displayLabel", () => {
    const env = { ...makeRepo(), displayLabel: "x".repeat(257) };
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

  // --- Epic #729: bidi / zero-width display-spoof hardening (defence-in-depth mirror of the
  // envelope-building sanitiser; vectors built via String.fromCodePoint so the source stays ASCII) ---

  it("rejects a displayLabel containing a bidi override (RLO U+202E)", () => {
    const env = { ...makeRepo(), displayLabel: `spec${String.fromCodePoint(0x202e)}fdp.txt` };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a displayLabel containing a zero-width space (U+200B)", () => {
    const env = { ...makeRepo(), displayLabel: `inv${String.fromCodePoint(0x200b)}oice` };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });
  it("rejects a localRef containing a bidi isolate (U+2066)", () => {
    const env = { ...makeRepo(), localRef: `scope:${String.fromCodePoint(0x2066)}foo` };
    expect(looksLikeBrowserSafeSourceEnvelope(env)).toBe(false);
  });

  it("accepts a clean connector-document envelope", () => {
    expect(looksLikeBrowserSafeSourceEnvelope(makeConnector())).toBe(true);
  });

  it("stays fast against an adversarial localRef with no URL scheme delimiter (S8786)", () => {
    // The scheme-detection scan's scheme-name run was unbounded pre-fix; a long run of lowercase
    // letters with no "://" anywhere drove O(n²) backtracking (empirically ~450ms at 32,000 chars
    // pre-fix on this machine — `localRef` has no length cap, unlike `displayLabel`). Bounding the
    // run to {0,63} makes the worst case linear without narrowing detection of any real URL.
    const env = { ...makeRepo(), localRef: "a".repeat(20_000) };
    const start = Date.now();
    const safe = looksLikeBrowserSafeSourceEnvelope(env);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(safe).toBe(true);
  });
});
