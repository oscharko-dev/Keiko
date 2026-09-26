import { describe, expect, it } from "vitest";
import { validateRegisteredActivityLogEvent } from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  applyAuthoritativeInstallLayout,
  installLayoutOverrideActivityLogEvent,
  installLayoutOverrideEvidence,
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
  writeInstallLayoutOverrideEvidence,
  writeInstallLayoutOverrideEvidenceWithFactory,
  type AuthoritativeInstallLayout,
  type InstallLayoutNormalizedActivityLogEvent,
} from "./install-layout.js";

const LAYOUT: AuthoritativeInstallLayout = {
  cliBinPath: "/install/dist/cli/index.js",
  uiStaticRoot: "/install/dist/ui/static",
  localStateAuditor: "/install/scripts/lib/local-state-audit.mjs",
};

describe("authoritative install layout", () => {
  it("replaces inherited paths and records only body-free override kinds", () => {
    const env: NodeJS.ProcessEnv = {
      KEIKO_CLI_BIN_PATH: "/stale/cli.js",
      KEIKO_UI_STATIC_ROOT: "/stale/ui",
      KEIKO_LOCAL_STATE_AUDITOR: "/stale/audit.mjs",
    };

    applyAuthoritativeInstallLayout(env, LAYOUT);

    expect(env.KEIKO_CLI_BIN_PATH).toBe(LAYOUT.cliBinPath);
    expect(env.KEIKO_UI_STATIC_ROOT).toBe(LAYOUT.uiStaticRoot);
    expect(env.KEIKO_LOCAL_STATE_AUDITOR).toBe(LAYOUT.localStateAuditor);
    const evidence = installLayoutOverrideEvidence(env);
    expect(evidence?.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence?.overriddenKinds).toEqual(["cli-bin", "ui-static-root", "local-state-auditor"]);
  });

  it("does not report missing defaults as stale and clears untrusted markers", () => {
    const env: NodeJS.ProcessEnv = {
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };

    applyAuthoritativeInstallLayout(env, LAYOUT);

    expect(installLayoutOverrideEvidence(env)).toBeUndefined();
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBeUndefined();
    expect(env[INSTALL_LAYOUT_CORRELATION_ID_ENV]).toBeUndefined();
  });

  it("preserves validated parent evidence across the detached UI child", () => {
    const env: NodeJS.ProcessEnv = { KEIKO_CLI_BIN_PATH: "/stale/cli.js" };
    applyAuthoritativeInstallLayout(env, LAYOUT);
    const parentEvidence = installLayoutOverrideEvidence(env);

    applyAuthoritativeInstallLayout(env, LAYOUT);

    expect(installLayoutOverrideEvidence(env)).toEqual(parentEvidence);
  });

  it("writes one correlated, body-free normalization event", () => {
    const env: NodeJS.ProcessEnv = { KEIKO_CLI_BIN_PATH: "/stale/cli.js" };
    const events: InstallLayoutNormalizedActivityLogEvent[] = [];
    applyAuthoritativeInstallLayout(env, LAYOUT);
    const evidence = installLayoutOverrideEvidence(env);

    expect(writeInstallLayoutOverrideEvidence({ write: (event) => events.push(event) }, env)).toBe(
      true,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      category: "diagnostic",
      op: "cli.install-layout.normalized",
      correlationId: evidence?.correlationId,
      extra: {
        completeness: "complete",
        loss: "none",
        overriddenCount: 1,
        overriddenKinds: ["cli-bin"],
      },
    });
    expect(validateRegisteredActivityLogEvent(events[0] ?? {})).toMatchObject({
      op: "cli.install-layout.normalized",
      emitter: "install-layout.installLayoutOverrideActivityLogEvent",
    });
    expect(installLayoutOverrideEvidence(env)).toBeUndefined();
    expect(writeInstallLayoutOverrideEvidence({ write: (event) => events.push(event) }, env)).toBe(
      false,
    );
    expect(writeInstallLayoutOverrideEvidence({ write: (event) => events.push(event) }, {})).toBe(
      false,
    );
    expect(events).toHaveLength(1);
  });

  it("builds the same registered event for direct install-layout callers", () => {
    const event = installLayoutOverrideActivityLogEvent({
      correlationId: "00000000-0000-4000-8000-000000000001",
      overriddenKinds: ["ui-static-root"],
    });

    expect(validateRegisteredActivityLogEvent(event).op).toBe("cli.install-layout.normalized");
    expect(event.extra).toEqual({
      completeness: "complete",
      loss: "none",
      overriddenCount: 1,
      overriddenKinds: ["ui-static-root"],
    });
  });

  it("does not open a state-dir sink until validated evidence exists", () => {
    let factoryCalls = 0;
    const events: unknown[] = [];
    const factory = (): { readonly write: (event: unknown) => void } => {
      factoryCalls += 1;
      return { write: (event): void => void events.push(event) };
    };

    expect(writeInstallLayoutOverrideEvidenceWithFactory(factory, "/state", {})).toBe(false);
    expect(factoryCalls).toBe(0);

    const env: NodeJS.ProcessEnv = { KEIKO_CLI_BIN_PATH: "/stale/cli.js" };
    applyAuthoritativeInstallLayout(env, LAYOUT);
    expect(writeInstallLayoutOverrideEvidenceWithFactory(factory, "/state", env)).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("rejects malformed, duplicate, and unknown evidence", () => {
    const correlationId = "00000000-0000-4000-8000-000000000001";
    expect(
      installLayoutOverrideEvidence({
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
      }),
    ).toBeUndefined();
    expect(
      installLayoutOverrideEvidence({
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin,cli-bin",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
      }),
    ).toBeUndefined();
    expect(
      installLayoutOverrideEvidence({
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin,unknown",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
      }),
    ).toBeUndefined();
    expect(
      installLayoutOverrideEvidence({
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "cli-bin",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "not-a-correlation-id",
      }),
    ).toBeUndefined();
  });
});
