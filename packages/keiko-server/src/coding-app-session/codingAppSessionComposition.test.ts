import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { createInMemoryUiStore } from "../store/index.js";
import { fakePairingRequestBody } from "./_support.js";
import {
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
  mintLauncherPairingAttestation,
} from "./launcherSessionPairingPort.js";

const LAUNCHER_SECRET = "launcher-secret-that-is-long-enough-32+chars";

function productionDeps(env: EnvSource): UiHandlerDeps {
  return buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: realpathSync(mkdtempSync(join(tmpdir(), "app-session-composition-"))),
    env,
    store: createInMemoryUiStore(),
  });
}

describe("production composition of the app-session channel (ADR-0141 D7)", () => {
  it("composes the channel but cannot issue a session without launcher authority (fail closed)", () => {
    const channel = productionDeps({}).codingAppSessionChannel;
    expect(channel).toBeDefined();
    expect(channel?.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel?.snapshot(undefined).content).toBeNull();
    expect(channel?.sessionCount()).toBe(0);
  });

  it("issues a session only when the environment carries a launcher secret", () => {
    const channel = productionDeps({
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: LAUNCHER_SECRET,
    }).codingAppSessionChannel;
    const attestation = mintLauncherPairingAttestation({
      secret: LAUNCHER_SECRET,
      requestId: "req_production",
      issuedAtMs: Date.now(),
    });
    const result = channel?.pair(attestation);
    expect(result?.paired).toBe(true);
    // No content source is wired in production this wave, so even a paired session reads content-free.
    if (result?.paired) expect(channel?.snapshot(result.cookieToken).content).toBeNull();
  });

  it("no production source imports the CI pairing fake (_support), so it is unreachable", () => {
    const srcRoot = join(import.meta.dirname, "..");
    const offenders = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter(
        (rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.endsWith("_support.ts"),
      )
      .filter((rel) =>
        importsCodingAppSessionSupport(rel, readFileSync(join(srcRoot, rel), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});

function importsCodingAppSessionSupport(relPath: string, content: string): boolean {
  const dir = dirname(relPath);
  const specifiers = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
  return specifiers.some((specifier) => {
    if (specifier.includes("coding-app-session/_support")) return true;
    return (
      dir.endsWith("coding-app-session") &&
      (specifier === "./_support.js" || specifier === "./_support")
    );
  });
}
