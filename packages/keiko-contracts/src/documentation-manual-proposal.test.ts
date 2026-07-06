import { describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "./local-knowledge.js";
import type { KnowledgePodSummary } from "./local-knowledge-pods.js";
import {
  asAlreadyIndexedProposal,
  buildDocumentationIndexingProposal,
  buildManualScopePreview,
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  DOCUMENTATION_MANUAL_PROPOSAL_REASONS,
  DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
  DOCUMENTATION_MANUAL_PROPOSAL_STATES,
  detectIndexableManual,
  findIndexedManualForFingerprint,
  isApprovableProposalState,
  parseManualProposalRequest,
  summarizeManualOrigin,
  summarizeManualPathPrefix,
  validateDocumentationIndexingApproval,
  validateDocumentationIndexingProposal,
  type DocumentationIndexingApproval,
  type DocumentationIndexingProposal,
  type DocumentationManualProposalState,
} from "./documentation-manual-proposal.js";

const RLO = String.fromCodePoint(0x202e);

function podFixture(overrides: Partial<KnowledgePodSummary>): KnowledgePodSummary {
  return {
    schemaVersion: "1",
    id: "capsule-1" as KnowledgePodSummary["id"],
    kind: "pod",
    displayName: "Manual pod",
    tags: [],
    readiness: "ready",
    counts: { capsuleCount: 1, sourceCount: 1, documentCount: 3, chunkCount: 9, vectorCount: 9 },
    sourceKinds: ["folder"],
    retrieval: {
      lexicalIndex: true,
      vectorIndex: true,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
    },
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: {
      locationKind: "local",
      sealingPosture: "not-declared",
      policyPosture: "not-declared",
      managedServiceDependency: false,
    },
    modelUsePolicy: {
      source: "explicit",
      mode: "standard",
      operations: {
        externalEmbeddings: "allow",
        localEmbeddings: "allow",
        externalReranking: "allow",
        localReranking: "allow",
        answerSynthesis: "allow",
        rawContentRelease: "deny",
        evidencePersistence: "allow",
      },
    },
    compatibility: {
      backingKind: "knowledge-capsule",
      capsuleIds: ["capsule-1" as KnowledgeCapsuleId],
      sourceIds: ["source-1" as KnowledgeSourceId],
      localKnowledgeSchemaVersion: "1",
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1,
    degradationReasons: [],
    ...overrides,
  };
}

describe("documentation-manual-proposal constants", () => {
  it("pins the schema version", () => {
    expect(DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION).toBe("1");
  });

  it("only marks the three candidate states approvable", () => {
    const approvable = DOCUMENTATION_MANUAL_PROPOSAL_STATES.filter(isApprovableProposalState);
    expect([...approvable].sort()).toEqual([
      "likely-manual",
      "probable-manual",
      "requires-local-file-approval",
    ]);
  });

  it("never marks a governed-limitation state approvable", () => {
    for (const state of [
      "not-evaluated",
      "unsupported",
      "denied",
      "authentication-required",
      "already-indexed",
      "degraded",
    ] satisfies DocumentationManualProposalState[]) {
      expect(isApprovableProposalState(state)).toBe(false);
    }
  });
});

describe("detectIndexableManual — approvable manual shapes", () => {
  it("treats an intranet index.html as a likely manual", () => {
    const detection = detectIndexableManual("https://intranet/docs/index.html");
    expect(detection.state).toBe("likely-manual");
    expect(detection.sourceKind).toBe("html-manual-http");
    expect(detection.confidence).toBe("high");
    expect(detection.reasons).toContain("index-html-entry");
  });

  it("treats an html document under a docs path as a likely manual", () => {
    const detection = detectIndexableManual("https://wiki.corp/handbook/chapter.html");
    expect(detection.state).toBe("likely-manual");
    expect(detection.reasons).toEqual(
      expect.arrayContaining(["html-document-extension", "documentation-path-pattern"]),
    );
  });

  it("treats a documentation directory as a probable manual", () => {
    const detection = detectIndexableManual("https://intranet/handbook/");
    expect(detection.state).toBe("probable-manual");
    expect(detection.confidence).toBe("medium");
    expect(detection.reasons).toEqual(
      expect.arrayContaining(["documentation-path-pattern", "directory-style-target"]),
    );
  });

  it("treats a loopback documentation server root as a probable manual", () => {
    const detection = detectIndexableManual("http://127.0.0.1:8080/");
    expect(detection.state).toBe("probable-manual");
    expect(detection.reasons).toContain("loopback-documentation-server");
  });

  it("degrades an unknown intranet page shape to low confidence, never auto-approved", () => {
    const detection = detectIndexableManual("https://intranet/portal.aspx");
    expect(detection.state).toBe("probable-manual");
    expect(detection.confidence).toBe("low");
    expect(detection.reasons).toContain("unknown-page-shape");
  });

  it("recognises a local file manual candidate but requires local approval", () => {
    const detection = detectIndexableManual("file:///opt/manuals/index.html");
    expect(detection.state).toBe("requires-local-file-approval");
    expect(detection.sourceKind).toBe("html-manual-local");
    expect(detection.reasons).toContain("local-file-manual-candidate");
  });
});

describe("detectIndexableManual — fail closed", () => {
  it("declines an action/login page as degraded, not offered", () => {
    const detection = detectIndexableManual("https://intranet/docs/login");
    expect(detection.state).toBe("degraded");
    expect(detection.reasons).toContain("dynamic-or-action-page");
    expect(isApprovableProposalState(detection.state)).toBe(false);
  });

  it("declines a public external target", () => {
    const detection = detectIndexableManual("https://example.com/docs/index.html");
    expect(detection.state).toBe("unsupported");
    expect(detection.reasons).toContain("external-target-not-offered");
  });

  it("declines an unsupported scheme", () => {
    const detection = detectIndexableManual("ftp://host/manual.html");
    expect(detection.state).toBe("unsupported");
    expect(detection.reasons).toContain("unsupported-scheme");
  });

  it("denies a credentialed target without hinting the credential", () => {
    const detection = detectIndexableManual("https://user:pass@intranet/docs/index.html");
    expect(detection.state).toBe("denied");
    expect(detection.reasons).toEqual(["credentials-in-target"]);
    expect(JSON.stringify(detection)).not.toContain("pass");
  });

  it("degrades an unparseable or non-string target", () => {
    expect(detectIndexableManual("not a url").state).toBe("degraded");
    expect(detectIndexableManual(42).state).toBe("degraded");
    expect(detectIndexableManual("").state).toBe("degraded");
  });

  it("uses only known reason codes", () => {
    const known = new Set(DOCUMENTATION_MANUAL_PROPOSAL_REASONS);
    for (const raw of [
      "https://intranet/docs/index.html",
      "https://intranet/portal.aspx",
      "file:///x/index.html",
      "ftp://h/f",
      "https://user:p@h/",
    ]) {
      for (const reason of detectIndexableManual(raw).reasons) {
        expect(known.has(reason)).toBe(true);
      }
    }
  });
});

describe("summary redaction", () => {
  it("summarises an http origin without path or query", () => {
    expect(summarizeManualOrigin("https://intranet/secret/report.html?token=abc")).toBe(
      "https://intranet",
    );
  });

  it("never exposes a local path", () => {
    expect(summarizeManualOrigin("file:///home/user/secret/manual.html")).toBe("local file");
  });

  it("summarises the path prefix as a shape only", () => {
    expect(summarizeManualPathPrefix("https://intranet/")).toBe("/");
    expect(summarizeManualPathPrefix("https://intranet/secret/deep.html")).toBe("/…");
    expect(summarizeManualPathPrefix("file:///x/index.html")).toBeNull();
  });

  it("returns a safe fallback for invalid input", () => {
    expect(summarizeManualOrigin("not a url")).toBe("unavailable");
    expect(summarizeManualOrigin(99)).toBe("unavailable");
    expect(summarizeManualPathPrefix(99)).toBeNull();
  });
});

describe("buildManualScopePreview", () => {
  it("declares the governed limits and honours robots for http manuals", () => {
    const preview = buildManualScopePreview({
      sourceKind: "html-manual-http",
      originSummary: "https://intranet",
      pathPrefixSummary: "/…",
    });
    expect(preview.limits).toEqual(DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS);
    expect(preview.limits.followRedirects).toBe(false);
    expect(preview.estimatedPageCount).toBeNull();
    expect(preview.robotsPosture).toBe("honor-robots-txt");
    expect(preview.deniedLinkClasses).toContain("cross-origin");
    expect(preview.proposedPodName).toContain("https://intranet");
  });

  it("uses a generic pod name and no robots posture for local manuals", () => {
    const preview = buildManualScopePreview({
      sourceKind: "html-manual-local",
      originSummary: "local file",
      pathPrefixSummary: null,
    });
    expect(preview.proposedPodName).toBe("Local HTML manual");
    expect(preview.robotsPosture).toBe("not-applicable");
  });
});

describe("buildDocumentationIndexingProposal", () => {
  it("attaches a scope preview only for an approvable state", () => {
    const proposal = buildDocumentationIndexingProposal({
      detection: detectIndexableManual("https://intranet/docs/index.html"),
      targetClass: "intranet-http",
      originSummary: "https://intranet",
      pathPrefixSummary: "/…",
    });
    expect(proposal.state).toBe("likely-manual");
    expect(proposal.scopePreview).not.toBeNull();
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.approved).toBe(false);
    expect(validateDocumentationIndexingProposal(proposal)).toEqual({ ok: true });
  });

  it("omits the scope preview for a non-approvable state", () => {
    const proposal = buildDocumentationIndexingProposal({
      detection: detectIndexableManual("https://example.com/docs"),
      targetClass: "external-http",
      originSummary: "https://example.com",
      pathPrefixSummary: "/…",
    });
    expect(proposal.state).toBe("unsupported");
    expect(proposal.scopePreview).toBeNull();
    expect(validateDocumentationIndexingProposal(proposal)).toEqual({ ok: true });
  });

  it("never leaks a raw path or token into the proposal JSON", () => {
    const proposal = buildDocumentationIndexingProposal({
      detection: detectIndexableManual("https://intranet/secret/index.html?token=abc"),
      targetClass: "intranet-http",
      originSummary: summarizeManualOrigin("https://intranet/secret/index.html?token=abc"),
      pathPrefixSummary: summarizeManualPathPrefix("https://intranet/secret/index.html?token=abc"),
    });
    const serialised = JSON.stringify(proposal);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("token");
  });
});

describe("validateDocumentationIndexingProposal — fail closed", () => {
  function baseProposal(): DocumentationIndexingProposal {
    return buildDocumentationIndexingProposal({
      detection: detectIndexableManual("https://intranet/docs/index.html"),
      targetClass: "intranet-http",
      originSummary: "https://intranet",
      pathPrefixSummary: "/…",
    });
  }

  it("guarantees consent is never pre-granted at the value level", () => {
    const proposal = baseProposal();
    expect(proposal.approved).toBe(false);
    expect(proposal.approvalRequired).toBe(true);
  });

  it("rejects an approvable proposal with no scope preview", () => {
    const tampered = { ...baseProposal(), scopePreview: null };
    expect(validateDocumentationIndexingProposal(tampered).ok).toBe(false);
  });

  it("rejects a leaked path in the origin summary", () => {
    const tampered = { ...baseProposal(), originSummary: "/etc/secret/passwd" };
    expect(validateDocumentationIndexingProposal(tampered).ok).toBe(false);
  });

  it("rejects a format-spoofing origin summary", () => {
    const tampered = { ...baseProposal(), originSummary: `https://intranet${RLO}` };
    expect(validateDocumentationIndexingProposal(tampered).ok).toBe(false);
  });

  it("rejects a non-shape path prefix", () => {
    const tampered = { ...baseProposal(), pathPrefixSummary: "/secret/deep" };
    expect(validateDocumentationIndexingProposal(tampered).ok).toBe(false);
  });
});

describe("asAlreadyIndexedProposal + findIndexedManualForFingerprint", () => {
  it("re-shapes a proposal to the already-indexed state pointing at the pod", () => {
    const proposal = buildDocumentationIndexingProposal({
      detection: detectIndexableManual("https://intranet/docs/index.html"),
      targetClass: "intranet-http",
      originSummary: "https://intranet",
      pathPrefixSummary: "/…",
    });
    const alreadyIndexed = asAlreadyIndexedProposal(proposal, "capsule-7");
    expect(alreadyIndexed.state).toBe("already-indexed");
    expect(alreadyIndexed.alreadyIndexedPodId).toBe("capsule-7");
    expect(alreadyIndexed.scopePreview).toBeNull();
    expect(validateDocumentationIndexingProposal(alreadyIndexed)).toEqual({ ok: true });
  });

  it("matches a ready pod carrying the same fingerprint", () => {
    const pod = podFixture({
      id: "capsule-7" as KnowledgePodSummary["id"],
      manualSourceFingerprint: "fp-abc",
    });
    expect(findIndexedManualForFingerprint("fp-abc", [pod])?.id).toBe("capsule-7");
  });

  it("does not match an empty fingerprint or a non-ready pod", () => {
    const ready = podFixture({ manualSourceFingerprint: "fp-abc" });
    const stale = podFixture({ manualSourceFingerprint: "fp-abc", readiness: "stale" });
    expect(findIndexedManualForFingerprint("", [ready])).toBeNull();
    expect(findIndexedManualForFingerprint("fp-abc", [stale])).toBeNull();
    expect(findIndexedManualForFingerprint("fp-other", [ready])).toBeNull();
  });
});

describe("parseManualProposalRequest", () => {
  it("accepts a well-formed target", () => {
    const parsed = parseManualProposalRequest({ target: "https://intranet/docs/" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe("1");
    expect(parsed.value.target).toBe("https://intranet/docs/");
  });

  it("rejects a non-object, empty, or over-long target", () => {
    expect(parseManualProposalRequest(null).ok).toBe(false);
    expect(parseManualProposalRequest({ target: "" }).ok).toBe(false);
    expect(parseManualProposalRequest({ target: `https://x/${"a".repeat(5000)}` }).ok).toBe(false);
  });
});

describe("validateDocumentationIndexingApproval", () => {
  function baseApproval(): DocumentationIndexingApproval {
    return {
      schemaVersion: "1",
      approved: true,
      sourceKind: "html-manual-http",
      sourceFingerprint: "a".repeat(64),
      originSummary: "https://intranet",
      pathPrefixSummary: "/…",
      proposedPodName: "https://intranet — HTML manual",
      limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    };
  }

  it("accepts a well-formed approval handoff", () => {
    expect(validateDocumentationIndexingApproval(baseApproval())).toEqual({ ok: true });
  });

  it("rejects a missing fingerprint or leaked path", () => {
    expect(
      validateDocumentationIndexingApproval({ ...baseApproval(), sourceFingerprint: "" }).ok,
    ).toBe(false);
    expect(
      validateDocumentationIndexingApproval({
        ...baseApproval(),
        proposedPodName: "/etc/secret/passwd",
      }).ok,
    ).toBe(false);
  });

  it("carries explicit consent at the value level", () => {
    expect(baseApproval().approved).toBe(true);
  });
});
