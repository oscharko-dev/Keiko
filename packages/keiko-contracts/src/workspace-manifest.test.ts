import { describe, expect, it } from "vitest";
import {
  isWorkspaceManifestDigest,
  isWorkspaceManifestRef,
  isWorkspaceRootIdentityDigest,
  isWorkspaceRootRef,
  isWorkspaceTrustBasisDigest,
} from "./workspace-contract-primitives.js";
import {
  validateWorkspaceManifest,
  validateWorkspaceRootDispatch,
  WORKSPACE_MANIFEST_MAX_ROOTS,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
} from "./workspace-manifest.js";
import type { WorkspaceManifest, WorkspaceRootDispatch } from "./workspace-manifest.js";

function checked<Value>(value: string, guard: (input: unknown) => input is Value): Value {
  if (!guard(value)) throw new Error(`invalid fixture: ${value}`);
  return value;
}

const ROOT = checked("root-primary", isWorkspaceRootRef);
const ROOT_TWO = checked("root-secondary", isWorkspaceRootRef);
const MANIFEST = checked("manifest-primary", isWorkspaceManifestRef);
const ROOT_DIGEST = checked("a".repeat(64), isWorkspaceRootIdentityDigest);
const ROOT_TWO_DIGEST = checked("b".repeat(64), isWorkspaceRootIdentityDigest);
const MANIFEST_DIGEST = checked("c".repeat(64), isWorkspaceManifestDigest);
const SOURCE_DIGEST = checked("d".repeat(64), isWorkspaceTrustBasisDigest);

function validManifest(): WorkspaceManifest {
  return {
    kind: "workspace-manifest",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    manifestRef: MANIFEST,
    manifestDigest: MANIFEST_DIGEST,
    workspaceId: "workspace-1",
    revision: 2,
    roots: [
      {
        rootRef: ROOT,
        canonicalRoot: "/work/keiko",
        displayName: "Keiko",
        identityDigest: ROOT_DIGEST,
        sourceDigest: { outcome: "known", value: SOURCE_DIGEST },
      },
      {
        rootRef: ROOT_TWO,
        canonicalRoot: "/work/secondary",
        displayName: "Secondary",
        identityDigest: ROOT_TWO_DIGEST,
        sourceDigest: { outcome: "absent" },
      },
    ],
    focusedRootRef: ROOT,
  };
}

function rootAt(position: number): WorkspaceManifest["roots"][number] {
  return {
    rootRef: checked(`root-${String(position)}`, isWorkspaceRootRef),
    canonicalRoot: `/work/root-${String(position)}`,
    displayName: `Root ${String(position)}`,
    identityDigest: checked(position.toString(16).padStart(64, "0"), isWorkspaceRootIdentityDigest),
    sourceDigest: { outcome: "absent" },
  };
}

describe("workspace manifest", () => {
  it("accepts an ordered non-empty multi-root manifest and preserves order", () => {
    const manifest = validManifest();
    expect(validateWorkspaceManifest(manifest)).toEqual({ ok: true });
    expect(manifest.roots.map((root) => root.rootRef)).toEqual([ROOT, ROOT_TWO]);
    expect(WORKSPACE_MANIFEST_MAX_ROOTS).toBe(32);
  });

  it("rejects duplicate identities, foreign focus, unsafe roots, and content smuggling", () => {
    const first = validManifest().roots[0];
    expect(validateWorkspaceManifest({ ...validManifest(), roots: [first, first] }).ok).toBe(false);
    expect(
      validateWorkspaceManifest({ ...validManifest(), focusedRootRef: "root-foreign" }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [{ ...first, canonicalRoot: "/work/../escape" }],
      }).ok,
    ).toBe(false);
    expect(validateWorkspaceManifest({ ...validManifest(), fileBody: "secret" }).ok).toBe(false);
  });

  it("rejects overlapping canonical roots", () => {
    const roots = validManifest().roots;
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [roots[0], { ...roots[1], canonicalRoot: "/work/keiko/nested" }],
      }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [
          { ...roots[0], canonicalRoot: "C:\\work" },
          { ...roots[1], canonicalRoot: "C:\\work/child" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [roots[0], { ...roots[1], canonicalRoot: "/work//keiko/nested" }],
      }).ok,
    ).toBe(false);
  });

  it("enforces root count, display-name, source-fact, and schema bounds", () => {
    const roots = Array.from({ length: WORKSPACE_MANIFEST_MAX_ROOTS + 1 }, (_, position) =>
      rootAt(position),
    );
    expect(validateWorkspaceManifest({ ...validManifest(), roots }).ok).toBe(false);
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [{ ...rootAt(0), displayName: "bad\u0000name" }],
        focusedRootRef: rootAt(0).rootRef,
      }).ok,
    ).toBe(false);
    expect(
      validateWorkspaceManifest({
        ...validManifest(),
        roots: [{ ...rootAt(0), sourceDigest: { outcome: "known", value: "bad" } }],
        focusedRootRef: rootAt(0).rootRef,
      }).ok,
    ).toBe(false);
    expect(validateWorkspaceManifest({ ...validManifest(), schemaVersion: 2 }).ok).toBe(false);
  });

  it("is throw-free for hostile getters", () => {
    const hostile = Object.defineProperty({}, "schemaVersion", {
      get(): never {
        throw new Error("hostile getter");
      },
    });
    expect(() => validateWorkspaceManifest(hostile)).not.toThrow();
    expect(validateWorkspaceManifest(hostile).ok).toBe(false);
  });
});

describe("effectful root dispatch", () => {
  function dispatch(): WorkspaceRootDispatch {
    return {
      kind: "workspace-root-dispatch",
      schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
      workspaceId: "workspace-1",
      manifestRef: MANIFEST,
      manifestRevision: 2,
      manifestDigest: MANIFEST_DIGEST,
      rootRef: ROOT,
      rootIdentityDigest: ROOT_DIGEST,
      operationClass: "mutating",
    };
  }

  it("requires manifest and root identity on every mutating/executing dispatch", () => {
    expect(validateWorkspaceRootDispatch(dispatch())).toEqual({ ok: true });
    expect(validateWorkspaceRootDispatch({ ...dispatch(), operationClass: "executing" })).toEqual({
      ok: true,
    });
    expect(validateWorkspaceRootDispatch({ ...dispatch(), rootRef: undefined }).ok).toBe(false);
    expect(validateWorkspaceRootDispatch({ ...dispatch(), activeRoot: "/fallback" }).ok).toBe(
      false,
    );
    expect(validateWorkspaceRootDispatch({ ...dispatch(), operationClass: "read" }).ok).toBe(false);
    expect(validateWorkspaceRootDispatch({ ...dispatch(), manifestRevision: -1 }).ok).toBe(false);
  });

  it("fails closed for hostile dispatch objects", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile keys");
        },
      },
    );
    expect(() => validateWorkspaceRootDispatch(hostile)).not.toThrow();
    expect(validateWorkspaceRootDispatch(hostile).ok).toBe(false);
  });
});
