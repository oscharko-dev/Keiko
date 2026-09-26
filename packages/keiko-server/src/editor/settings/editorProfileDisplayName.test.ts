// One table, both paths. Create/rename and import assign display names through different code, and
// they diverged: import wrote whatever the manifest carried, so a name create would have rejected
// with 400 — untrimmed, or a padded "Default" — became a profile that shadowed an existing one
// (#2618). These cases drive the REAL control service on both sides, so the day the two paths stop
// agreeing on what a display name is, this file is what goes red.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceProfileManifest, WorkspaceProfileRef } from "@oscharko-dev/keiko-contracts";
import { EDITOR_M11_SETTINGS_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-m11-settings";
import {
  WORKSPACE_PROFILE_SCHEMA_VERSION,
  isAssignableWorkspaceProfileDisplayName,
  isReservedWorkspaceProfileDisplayName,
  workspaceProfileDisplayNameKey,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-profile";
import { isWorkspaceProfileRef } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
import { createEditorSettingsStore } from "./editorSettingsStore.js";

const roots: string[] = [];

/**
 * Names that read the same to a person but are distinct strings. Every one of them must be treated
 * identically by create, rename and import — that identity is the invariant under test.
 */
const AMBIGUOUS_NAMES = [
  " Focus",
  "Focus ",
  "  Focus  ",
  "\u00A0Focus",
  " Default",
  "Default ",
  "default",
  "DEFAULT",
  "   ",
] as const;

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

function profileRef(value: string): WorkspaceProfileRef {
  if (!isWorkspaceProfileRef(value)) throw new Error(`invalid profile fixture: ${value}`);
  return value;
}

function control(label: string): EditorSettingsControlService {
  const refs = ["profile-alpha", "profile-beta", "profile-gamma", "profile-delta"];
  return createEditorSettingsControlService({
    store: createEditorSettingsStore({ stateDir: temporaryDirectory(label) }),
    mutex: createWorkspaceMutexRegistry(),
    profileRefFactory: () => profileRef(refs.shift() ?? "profile-exhausted"),
  });
}

function manifestNamed(displayName: string): WorkspaceProfileManifest {
  const ref = profileRef("profile-source");
  return {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef: ref,
    displayName,
    revision: 1,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef: ref,
      revision: 1,
      values: { tabSize: 4 },
    },
  };
}

async function createNamed(
  service: EditorSettingsControlService,
  displayName: string,
  expectedRevision: number,
): Promise<string> {
  if (service.mutateProfile === undefined) throw new Error("profile control unavailable");
  const result = await service.mutateProfile({
    action: "create",
    displayName,
    expectedRevision,
    idempotencyKey: `create-${expectedRevision.toString()}-${displayName}`,
  });
  return result.kind;
}

async function importedName(
  service: EditorSettingsControlService,
  displayName: string,
  expectedRevision: number,
): Promise<string> {
  if (service.previewProfileImport === undefined) throw new Error("import control unavailable");
  const preview = await service.previewProfileImport(manifestNamed(displayName), expectedRevision);
  if (preview.kind !== "ok") throw new Error(`import preview rejected: ${preview.code}`);
  return preview.proposedDisplayName;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace profile display-name invariant", () => {
  it.each(AMBIGUOUS_NAMES)("refuses %j on create, rename and duplicate alike", async (name) => {
    const service = control("editor-profile-name-create");
    await createNamed(service, "Focus", 0);

    expect(await createNamed(service, name, 1)).toBe("invalid");
    if (service.mutateProfile === undefined) throw new Error("profile control unavailable");
    const renamed = await service.mutateProfile({
      action: "rename",
      displayName: name,
      expectedRevision: 1,
      idempotencyKey: `rename-${name}`,
      profileRef: profileRef("profile-alpha"),
    });
    const duplicated = await service.mutateProfile({
      action: "duplicate",
      displayName: name,
      expectedRevision: 1,
      idempotencyKey: `duplicate-${name}`,
      profileRef: profileRef("profile-alpha"),
    });

    expect(renamed.kind).toBe("invalid");
    expect(duplicated.kind).toBe("invalid");
  });

  it.each(AMBIGUOUS_NAMES)("never assigns %j through import either", async (name) => {
    const service = control("editor-profile-name-import");
    await createNamed(service, "Focus", 0);

    const assigned = await importedName(service, name, 1);

    // The name import lands on has to be one create would have accepted — that is the whole point.
    expect(isAssignableWorkspaceProfileDisplayName(assigned)).toBe(true);
    expect(isReservedWorkspaceProfileDisplayName(assigned)).toBe(false);
    expect(workspaceProfileDisplayNameKey(assigned)).not.toBe(
      workspaceProfileDisplayNameKey("Focus"),
    );
  });

  it("imports a clean, unclaimed name unchanged", async () => {
    const service = control("editor-profile-name-clean");
    await createNamed(service, "Focus", 0);

    const assigned = await importedName(service, "Deep Work", 1);

    expect(assigned).toBe("Deep Work");
  });

  it("assigns a padded name the same profile a trimmed one would have collided with", async () => {
    const service = control("editor-profile-name-collision");
    await createNamed(service, "Focus", 0);

    // " Focus " reads as "Focus", which is taken — import must rename rather than shadow it.
    expect(await importedName(service, " Focus ", 1)).toBe("Focus (Imported)");
    expect(await importedName(service, "Focus", 1)).toBe("Focus (Imported)");
  });

  it("writes the imported name the preview promised, and keeps it assignable in the store", async () => {
    const service = control("editor-profile-name-applied");
    await createNamed(service, "Focus", 0);
    if (service.previewProfileImport === undefined || service.applyProfileImport === undefined) {
      throw new Error("import control unavailable");
    }
    const manifest = manifestNamed(" Focus ");
    const preview = await service.previewProfileImport(manifest, 1);
    if (preview.kind !== "ok") throw new Error(`import preview rejected: ${preview.code}`);

    const applied = await service.applyProfileImport({
      expectedRevision: 1,
      idempotencyKey: "apply-padded-focus",
      manifest,
      previewDigest: preview.previewDigest,
      switchAfterImport: false,
    });

    expect(applied.kind).toBe("ok");
    if (applied.kind !== "ok") return;
    const names = applied.profiles.profiles.map((entry) => entry.displayName);
    expect(names).toContain(preview.proposedDisplayName);
    expect(names).not.toContain(" Focus ");
    for (const name of names) {
      expect(isAssignableWorkspaceProfileDisplayName(name)).toBe(true);
    }
  });
});
