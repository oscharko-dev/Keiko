import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildOpenCodeServiceHostLaunchShape } from "./opencodeServiceHostArtifact.js";

const PAYLOAD = resolve(tmpdir(), "keiko-qualified-payload");
const BOOTSTRAP = join(PAYLOAD, "host.mjs");

function fixture(): Record<string, unknown> {
  return (
    JSON.parse(
      readFileSync(
        new URL(
          "../../../keiko-contracts/src/opencode-service-host.private-qualified.fixture.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { readonly approval: Record<string, unknown> }
  ).approval;
}

describe("inactive fixed original OpenCode service-host launch shape", () => {
  it("derives one fixed Node program and bootstrap from the canonical approval", () => {
    const approval = fixture();
    const result = buildOpenCodeServiceHostLaunchShape({ payloadRoot: PAYLOAD, approval });
    expect(result).toEqual({
      ok: true,
      executable: join(PAYLOAD, "runtime/node"),
      args: [BOOTSTRAP],
      approval,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("expected fixed host program");
    expect(Object.isFrozen(result.args)).toBe(true);
    expect(Object.isFrozen(result.approval)).toBe(true);
  });

  it.each([
    [],
    ["-e", "process.exit(0)"],
    ["--eval=process.exit(0)"],
    ["--import", BOOTSTRAP],
    ["--require", BOOTSTRAP],
    ["--loader", BOOTSTRAP],
    [BOOTSTRAP, "--import=arbitrary.mjs"],
    [join(PAYLOAD, "alternative.mjs")],
  ])("rejects a substituted Node program %j", (...args) => {
    expect(
      buildOpenCodeServiceHostLaunchShape({ payloadRoot: PAYLOAD, approval: fixture(), args }),
    ).toEqual({ ok: false, reason: "host-program-invalid" });
  });

  it.each([
    "NODE_OPTIONS",
    "node_options",
    "NODE_PATH",
    "NODE_DEBUG",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
  ])("refuses ambient %s before bootstrap", (name) => {
    expect(
      buildOpenCodeServiceHostLaunchShape({
        payloadRoot: PAYLOAD,
        approval: fixture(),
        env: { [name]: "injected" },
      }),
    ).toEqual({ ok: false, reason: "host-environment-invalid" });
  });

  it("accepts only the fixed explicit argument and retains source/byte distinctions", () => {
    const output = buildOpenCodeServiceHostLaunchShape({
      payloadRoot: PAYLOAD,
      approval: fixture(),
      args: [BOOTSTRAP],
      env: { OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
    });
    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error("expected fixed host program");
    expect(output.approval.sourceBuildProvenance).toBe("reference-only");
    expect(output.approval.moduleIntegrity).toBe("npm-sri");
  });

  it("refuses invalid metadata and noncanonical payload roots", () => {
    expect(
      buildOpenCodeServiceHostLaunchShape({
        payloadRoot: PAYLOAD,
        approval: { ...fixture(), bootstrapPath: "other.mjs" },
      }),
    ).toEqual({ ok: false, reason: "host-metadata-invalid" });
    for (const payloadRoot of ["relative", "/qualified/../payload", "/qualified/payload/"]) {
      expect(buildOpenCodeServiceHostLaunchShape({ payloadRoot, approval: fixture() })).toEqual({
        ok: false,
        reason: "host-program-invalid",
      });
    }
  });
});
