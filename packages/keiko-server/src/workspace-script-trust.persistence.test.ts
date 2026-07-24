// Issue #2521 executable journey (ADR-0144 D3/D8): trust must survive a restart — a new deps
// composition over the same on-disk state dir — and an invalidated grant must never resurrect. Each
// assertion is failure-first against the pre-#2521 process-local Map: a grant made in one store
// instance was invisible to the next, so every "survives restart" expectation fails before this change.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createVerificationRunnerManager } from "./editor/verificationRunner.js";
import { createNodeUiStore, type UiStore } from "./store/index.js";
import {
  createWorkspaceScriptTrustService,
  type WorkspaceScriptTrustService,
} from "./workspace-script-trust.js";

const MANIFEST = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit" },
  devDependencies: {},
});

let root: string;
let stateDir: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-trust-ws-"));
  writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
  stateDir = mkdtempSync(join(tmpdir(), "keiko-trust-db-"));
  dbPath = join(stateDir, "ui.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

interface Session {
  readonly store: UiStore;
  readonly trust: WorkspaceScriptTrustService;
}

// A fresh store + trust service over the SAME on-disk uiDb models a server restart / new deps
// composition. Projects and trust both persist, so a later session sees the earlier decision.
function openSession(): Session {
  const store = createNodeUiStore(dbPath);
  return { store, trust: createWorkspaceScriptTrustService({ store }) };
}

function typecheckTrustState(session: Session): string | undefined {
  const verification = createVerificationRunnerManager({
    store: session.store,
    evidenceStore: createInMemoryEvidenceStore(),
    isWorkspaceTrustedForPackageScripts: session.trust.isTrusted,
  });
  return verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState;
}

describe("persisted workspace trust across a restart", () => {
  it("keeps a grant across a new store composition over the same state dir", () => {
    const first = openSession();
    first.store.createProject(root, "fixture");
    expect(typecheckTrustState(first)).toBe("approval-required");
    expect(first.trust.grant(root)).toEqual({ trusted: true });
    expect(typecheckTrustState(first)).toBe("trusted");
    first.store.close();

    const second = openSession();
    expect(typecheckTrustState(second)).toBe("trusted");
    second.store.close();
  });

  it("drops trust after a revoke that survives a restart", () => {
    const first = openSession();
    first.store.createProject(root, "fixture");
    first.trust.grant(root);
    expect(first.trust.revoke(root)).toEqual({ trusted: false });
    first.store.close();

    const second = openSession();
    expect(typecheckTrustState(second)).toBe("approval-required");
    second.store.close();
  });

  it("invalidates a persisted grant on manifest change and never resurrects it", () => {
    const first = openSession();
    first.store.createProject(root, "fixture");
    first.trust.grant(root);
    first.store.close();

    writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
    const second = openSession();
    expect(typecheckTrustState(second)).toBe("approval-required");
    second.store.close();

    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    const third = openSession();
    expect(typecheckTrustState(third)).toBe("approval-required");
    third.store.close();
  });
});
