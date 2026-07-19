import { describe, expect, it } from "vitest";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import {
  parseEditorRootSessions,
  sanitizeEditorRootSessionsJson,
  serializeEditorRootSessions,
  type EditorRootSession,
} from "./editor-root-sessions";

function root(rootRef: string, canonicalRoot: string): WorkspaceRootDescriptor {
  return {
    rootRef: rootRef as WorkspaceRootRef,
    canonicalRoot,
    displayName: rootRef,
    identityDigest: "a".repeat(64) as WorkspaceRootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

function manifest(): WorkspaceManifest {
  const roots = [root("root-a", "/repo-a"), root("root-b", "/repo-b")];
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision: 1,
    roots,
    focusedRootRef: roots[0]!.rootRef,
  };
}

function session(rootRef: WorkspaceRootRef, path: string): EditorRootSession {
  return { rootRef, root: path, layoutJson: JSON.stringify({ schemaVersion: 2, root: path }) };
}

describe("editor root sessions", () => {
  it("round-trips current manifest members and drops sessions for removed roots", () => {
    const current = manifest();
    const sessions = new Map([
      [current.roots[0]!.rootRef, session(current.roots[0]!.rootRef, "/repo-a")],
      [current.roots[1]!.rootRef, session(current.roots[1]!.rootRef, "/repo-b")],
    ]);
    const json = serializeEditorRootSessions(sessions, current, current.roots[1]!.rootRef);
    expect([...parseEditorRootSessions(json, current).keys()]).toEqual(["root-b", "root-a"]);

    const withoutB = {
      ...current,
      roots: [current.roots[0]!],
      focusedRootRef: current.roots[0]!.rootRef,
    };
    expect([...parseEditorRootSessions(json, withoutB).keys()]).toEqual(["root-a"]);
  });

  it("fails closed on duplicate roots, unknown fields, and oversized payloads", () => {
    const duplicate = JSON.stringify({
      schemaVersion: 1,
      sessions: [
        session("root-a" as WorkspaceRootRef, "/repo-a"),
        session("root-a" as WorkspaceRootRef, "/repo-a"),
      ],
    });
    expect(parseEditorRootSessions(duplicate, manifest()).size).toBe(0);
    expect(
      sanitizeEditorRootSessionsJson('{"schemaVersion":1,"sessions":[],"trust":true}'),
    ).toBeUndefined();
    expect(sanitizeEditorRootSessionsJson("x".repeat(128_001))).toBeUndefined();
  });
});
