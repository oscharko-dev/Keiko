import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DebugActivationSummary } from "@oscharko-dev/keiko-contracts";
import type { DebugActivationControlService } from "../dap/debugActivationControl.js";
import { createNodeEditorSettingsControl } from "./editorSettingsControlFactory.js";

const roots: string[] = [];

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `keiko-${label}-`)));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function debugActivation(): DebugActivationControlService {
  const summary = (revision: number): DebugActivationSummary => ({
    ok: true as const,
    schemaVersion: "1" as const,
    adapterId: "node-typescript" as const,
    revision,
    state: "disabledByPolicy" as const,
    reasonCode: "POLICY_UNAVAILABLE" as const,
    policyResult: "denied" as const,
  });
  return {
    resolve: (context) => summary(context.revision),
    synchronize: (input) => Promise.resolve(summary(input.context.revision)),
    dispose: () => undefined,
  };
}

describe("node editor settings control factory", () => {
  it("threads the debug activation composition seam into real settings snapshots", async () => {
    const control = createNodeEditorSettingsControl({
      stateDir: temporaryDirectory("editor-settings-factory-state"),
      debugActivation: debugActivation(),
    });

    expect(
      (await control.read(temporaryDirectory("editor-settings-factory-root"))).debugging,
    ).toMatchObject({
      state: "disabledByPolicy",
      reasonCode: "POLICY_UNAVAILABLE",
    });
  });
});
