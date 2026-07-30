import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DebugActivationSummary,
  EditorM7AiActivationStatus,
  EditorM11SettingsSnapshot,
  GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import type { DebugActivationControlService } from "../dap/debugActivationControl.js";
import type { EditorSettingsControlService } from "./editorSettingsControl.js";
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
    isCurrent: () => true,
    resolve: (context) => summary(context.revision),
    synchronize: (input) => Promise.resolve(summary(input.context.revision)),
    dispose: () => undefined,
  };
}

async function enableInlineCompletion(control: EditorSettingsControlService): Promise<void> {
  const result = await control.mutate({
    action: "set",
    expectedRevision: 0,
    idempotencyKey: "user-inline-completion",
    scope: "user",
    values: { inlineCompletion: true },
  });
  expect(result.kind).toBe("ok");
}

function inlineCompletionStatus(
  snapshot: EditorM11SettingsSnapshot,
): EditorM7AiActivationStatus | undefined {
  return snapshot.aiAssistance?.statuses.find((status) => status.feature === "inlineCompletion");
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

  // F-01, production seam: this is the composition the BFF actually builds, and the summary it
  // projects is what the editor AI-assist badge renders AND what the inline-completion route admits
  // on. With no probe outcome available it used to answer state "active" / policyResult "allowed",
  // because the projection defaulted `gatewayConfigured` to true and hardcoded a healthy provider.
  it("does not project an active AI-assist badge without a gateway probe outcome", async () => {
    const control = createNodeEditorSettingsControl({
      stateDir: temporaryDirectory("editor-settings-factory-unverified"),
      // Exactly what the BFF wires for a saved, parsed gateway config that no readiness check has
      // exercised yet — the state a fresh install is in the moment credentials are entered.
      gatewayStatus: () => ({ configured: true, verification: "unverified" }),
    });
    await enableInlineCompletion(control);

    const status = inlineCompletionStatus(await control.read());

    expect(status).toMatchObject({
      state: "degraded",
      reasonCode: "PROVIDER_UNVERIFIED",
      policyResult: "denied",
    });
  });

  it("falls back to a fail-closed gateway status when a caller wires none", async () => {
    const control = createNodeEditorSettingsControl({
      stateDir: temporaryDirectory("editor-settings-factory-unwired"),
    });
    await enableInlineCompletion(control);

    const status = inlineCompletionStatus(await control.read());

    expect(status?.policyResult).toBe("denied");
    expect(status?.state).not.toBe("active");
  });

  it("projects an active AI-assist badge once a probe has confirmed the gateway", async () => {
    const control = createNodeEditorSettingsControl({
      stateDir: temporaryDirectory("editor-settings-factory-verified"),
      gatewayStatus: () => ({ configured: true, verification: "verified" }),
    });
    await enableInlineCompletion(control);

    expect(inlineCompletionStatus(await control.read())).toMatchObject({
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    });
  });

  // The status is read per settings read, not captured when the control is built: an operator who
  // runs the Settings readiness check while the editor is open must see the badge change without a
  // restart, and one who replaces the gateway config must see it fall back to unverified.
  it("re-reads the gateway status on every settings read", async () => {
    let verification: GatewayVerificationState = "unverified";
    const control = createNodeEditorSettingsControl({
      stateDir: temporaryDirectory("editor-settings-factory-live"),
      gatewayStatus: () => ({ configured: true, verification }),
    });
    await enableInlineCompletion(control);
    expect(inlineCompletionStatus(await control.read())?.state).toBe("degraded");

    verification = "verified";
    expect(inlineCompletionStatus(await control.read())?.state).toBe("active");

    verification = "unverified";
    expect(inlineCompletionStatus(await control.read())?.reasonCode).toBe("PROVIDER_UNVERIFIED");
  });
});
