import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  OPENCODE_SERVICE_HOST_START_PACKET_FIELDS,
  OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES,
  type OpenCodeServiceHostApproval,
} from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { attestPortableSidecarTreeSync } from "@oscharko-dev/keiko-security/portable-tree-attestation";
import type { PortableHandoffOperationOptions } from "../update-portable-handoff-tree.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

import {
  buildOpenCodeServiceHostLaunchShape,
  prepareOpenCodeServiceHostLaunch,
  reinspectPreparedOpenCodeServiceHost,
  createOpenCodeServiceHostPacketDataAsset,
  OPENCODE_SERVICE_HOST_DISK_EVIDENCE,
  inspectOpenCodeServiceHostDisk,
  type OpenCodeServiceHostDiskInput,
} from "./opencodeServiceHostArtifact.js";

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

describe("closed fixed-host environment inputs", () => {
  it("refuses a revoked environment without substituting a validation exception", () => {
    const { proxy, revoke } = Proxy.revocable<Record<string, string>>({}, {});
    revoke();
    expect(
      buildOpenCodeServiceHostLaunchShape({
        payloadRoot: PAYLOAD,
        approval: fixture(),
        env: proxy,
      }),
    ).toEqual({ ok: false, reason: "host-environment-invalid" });
  });

  it("refuses accessor environment inputs without reading them", () => {
    let reads = 0;
    const env: Record<string, string> = {};
    Object.defineProperty(env, "OPENCODE_DISABLE_PROJECT_CONFIG", {
      enumerable: true,
      get(): string {
        reads += 1;
        throw new Error("accessor must not run");
      },
    });
    expect(
      buildOpenCodeServiceHostLaunchShape({
        payloadRoot: PAYLOAD,
        approval: fixture(),
        env,
      }),
    ).toEqual({ ok: false, reason: "host-environment-invalid" });
    expect(reads).toBe(0);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EVIDENCE = OPENCODE_SERVICE_HOST_DISK_EVIDENCE;

function producedDiskApproval(payloadRoot: string): OpenCodeServiceHostApproval {
  const produced = attestPortableSidecarTreeSync(
    payloadRoot,
    "runtime/node",
    Date.now() + 5_000,
    undefined,
    EVIDENCE.map(([path]) => path),
  );
  const digests = Object.fromEntries(
    EVIDENCE.map(([path, field]) => [field, produced.selectedFileSha256ByPath?.[path]]),
  );
  return {
    ...fixture(),
    ...digests,
    payloadTreeSha256: produced.treeSha256,
  } as OpenCodeServiceHostApproval;
}

function diskFixture(): {
  input: OpenCodeServiceHostDiskInput;
  approval: OpenCodeServiceHostApproval;
} {
  const payloadRoot = mkdtempSync(join(tmpdir(), "keiko-host-disk-"));
  roots.push(payloadRoot);
  mkdirSync(join(payloadRoot, "runtime"));
  mkdirSync(join(payloadRoot, "evidence"));
  // Byte-only fixture: no executable/version/platform/source qualification. Current host/guard
  // bytes are real published producers; other files are inert and never executed or installed.
  const bootstrap = readFileSync(
    new URL("../../../../native/opencode-service-host/host.mjs", import.meta.url),
  );
  const guard = readFileSync(
    new URL("../../../../native/opencode-service-host/guard-seams.mjs", import.meta.url),
  );
  for (const [path] of EVIDENCE)
    writeFileSync(join(payloadRoot, path), path === "host.mjs" ? bootstrap : "inert byte fixture");
  writeFileSync(join(payloadRoot, "guard-seams.mjs"), guard);
  const approval = producedDiskApproval(payloadRoot);
  return {
    input: {
      payloadRoot,
      target: approval.platformTarget,
      approval,
      trustedSupplement: { [approval.platformTarget]: approval },
    },
    approval,
  };
}

function options(
  extra: Partial<PortableHandoffOperationOptions> = {},
): PortableHandoffOperationOptions {
  return { deadline: Date.now() + 5_000, ...extra };
}

function declaredAndTrusted(
  input: OpenCodeServiceHostDiskInput,
  approval: OpenCodeServiceHostApproval,
): OpenCodeServiceHostDiskInput {
  return { ...input, approval, trustedSupplement: { [approval.platformTarget]: approval } };
}

describe("inactive original-host supplementary disk-byte receipt", () => {
  it("binds the same fresh full tree and all six selected files to the trusted target supplement", async () => {
    const { input, approval } = diskFixture();
    const result = await inspectOpenCodeServiceHostDisk(input, options());
    expect(result).toEqual({
      ok: true,
      kind: "supplementary-disk-byte-receipt",
      payloadRoot: input.payloadRoot,
      approval,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("expected supplementary byte receipt");
    expect(Object.isFrozen(result.approval)).toBe(true);
    expect(result.approval).not.toBe(approval);
    expect(result.approval.moduleIntegrity).toBe("npm-sri");
    expect(result.approval.sourceBuildProvenance).toBe("reference-only");
    expect(result).not.toHaveProperty("launchAuthorized");
    expect(result).not.toHaveProperty("platformQualified");
  });

  it("owns immutable root and approval snapshots across asynchronous inspection", async () => {
    const { input, approval } = diskFixture();
    const sourceApproval = { ...approval };
    const sourceInput = { ...declaredAndTrusted(input, sourceApproval) };
    const pending = inspectOpenCodeServiceHostDisk(sourceInput, options());
    sourceApproval.payloadTreeSha256 = "0".repeat(64);
    sourceInput.payloadRoot = resolve(tmpdir(), "substituted-root");
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      kind: "supplementary-disk-byte-receipt",
      payloadRoot: input.payloadRoot,
      approval,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(sourceApproval)).toBe(false);
  });

  it("does not confuse equivalent metadata key order with a different supplement", async () => {
    const { input, approval } = diskFixture();
    const reordered = Object.fromEntries(Object.entries(approval).reverse());
    expect(
      (await inspectOpenCodeServiceHostDisk({ ...input, approval: reordered }, options())).ok,
    ).toBe(true);
  });

  it("never promotes valid historical metadata to a receipt for current factory bytes", async () => {
    const { input } = diskFixture();
    const historical = fixture() as OpenCodeServiceHostApproval;
    expect(
      buildOpenCodeServiceHostLaunchShape({ payloadRoot: input.payloadRoot, approval: historical })
        .ok,
    ).toBe(true);
    expect(
      await inspectOpenCodeServiceHostDisk(declaredAndTrusted(input, historical), options()),
    ).toEqual({ ok: false, reason: "host-bytes-mismatch" });
  });

  it("recomputes changed non-selected module bytes after a successful inspection", async () => {
    const { input } = diskFixture();
    expect((await inspectOpenCodeServiceHostDisk(input, options())).ok).toBe(true);
    writeFileSync(join(input.payloadRoot, "guard-seams.mjs"), "module changed after discovery");
    expect(await inspectOpenCodeServiceHostDisk(input, options())).toEqual({
      ok: false,
      reason: "host-bytes-mismatch",
    });
  });

  it.each(EVIDENCE)(
    "rejects a trusted wrong selected digest for %s even with the correct full tree",
    async (_path, field) => {
      const { input, approval } = diskFixture();
      const wrong = { ...approval, [field]: "0".repeat(64) };
      expect(
        await inspectOpenCodeServiceHostDisk(declaredAndTrusted(input, wrong), options()),
      ).toEqual({ ok: false, reason: "host-bytes-mismatch" });
    },
  );

  it.each(EVIDENCE)(
    "requires selected file %s even when the catalog matches the remaining tree",
    async (path) => {
      const { input, approval } = diskFixture();
      rmSync(join(input.payloadRoot, path));
      const remaining = attestPortableSidecarTreeSync(
        input.payloadRoot,
        "runtime/node",
        Date.now() + 5_000,
      );
      await expect(
        inspectOpenCodeServiceHostDisk(
          declaredAndTrusted(input, { ...approval, payloadTreeSha256: remaining.treeSha256 }),
          options(),
        ),
      ).rejects.toMatchObject({ kind: "integrity" });
    },
  );

  it.each([
    "archiveSha256",
    "nodeArchiveSha256",
    "builderSha256",
    "payloadFileCount",
    "payloadSizeBytes",
    "archiveSizeBytes",
  ] as const)(
    "requires exact trusted %s metadata without claiming to measure that fact",
    async (field) => {
      const { input, approval } = diskFixture();
      const current = approval[field];
      const declared = {
        ...approval,
        [field]: typeof current === "string" ? "0".repeat(64) : current + 1,
      };
      expect(
        await inspectOpenCodeServiceHostDisk({ ...input, approval: declared }, options()),
      ).toEqual({ ok: false, reason: "host-supplement-mismatch" });
    },
  );

  it("rejects an absent or different catalog target before touching disk", async () => {
    const { input } = diskFixture();
    rmSync(input.payloadRoot, { recursive: true });
    expect(
      await inspectOpenCodeServiceHostDisk({ ...input, trustedSupplement: {} }, options()),
    ).toEqual({ ok: false, reason: "host-supplement-mismatch" });
    expect(
      await inspectOpenCodeServiceHostDisk({ ...input, target: "linux-x64" }, options()),
    ).toEqual({ ok: false, reason: "host-supplement-mismatch" });
  });

  it("refuses invalid declared metadata and noncanonical root before traversal", async () => {
    const { input } = diskFixture();
    expect(
      await inspectOpenCodeServiceHostDisk(
        { ...input, approval: { ...fixture(), bootstrapPath: "alternative.mjs" } },
        options(),
      ),
    ).toEqual({ ok: false, reason: "host-metadata-invalid" });
    expect(
      await inspectOpenCodeServiceHostDisk({ ...input, payloadRoot: "relative-root" }, options()),
    ).toEqual({ ok: false, reason: "host-root-invalid" });
    expect(
      await inspectOpenCodeServiceHostDisk(
        { ...input, payloadRoot: `${input.payloadRoot}/` },
        options(),
      ),
    ).toEqual({ ok: false, reason: "host-root-invalid" });
  });

  it.each(["symbolic", "hard"] as const)(
    "refuses an actual %s file link instead of accepting matching bytes",
    async (kind) => {
      const { input } = diskFixture();
      const path = join(input.payloadRoot, "runtime/node");
      const outside = mkdtempSync(join(tmpdir(), "keiko-host-outside-"));
      roots.push(outside);
      const source = join(outside, "node");
      writeFileSync(source, readFileSync(path));
      rmSync(path);
      if (kind === "symbolic") symlinkSync(source, path);
      else linkSync(source, path);
      const events: SecurityLogEvent[] = [];
      await expect(
        inspectOpenCodeServiceHostDisk(
          input,
          options({
            securityLogSink: {
              write(event): void {
                events.push(event);
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ kind: "integrity" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        op: "security.portable-tree-attestation.failed",
        errorKind: "validation-failed",
        extra: { driver: "async" },
      });
      const persisted = expectRegisteredActivityLogLine(
        "security.portable-tree-attestation.failed",
        formatActivityLogProofLine(events[0] ?? {}),
      );
      expect(persisted.driver).toBe("async");
      expect(JSON.stringify(events)).not.toContain(input.payloadRoot);
      expect(JSON.stringify(events)).not.toContain(source);
    },
  );

  it("refuses a symbolic payload root and propagates a missing-root error", async () => {
    const { input } = diskFixture();
    const outside = mkdtempSync(join(tmpdir(), "keiko-host-alias-"));
    roots.push(outside);
    const alias = join(outside, "payload");
    symlinkSync(input.payloadRoot, alias, "dir");
    await expect(
      inspectOpenCodeServiceHostDisk({ ...input, payloadRoot: alias }, options()),
    ).rejects.toMatchObject({ kind: "integrity" });
    rmSync(input.payloadRoot, { recursive: true });
    await expect(inspectOpenCodeServiceHostDisk(input, options())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["cancel", "deadline"] as const)(
    "retains the actual %s failure and owner logging",
    async (kind) => {
      const { input } = diskFixture();
      const controller = new AbortController();
      if (kind === "cancel") controller.abort();
      const events: SecurityLogEvent[] = [];
      await expect(
        inspectOpenCodeServiceHostDisk(
          input,
          options({
            signal: controller.signal,
            deadline: kind === "deadline" ? 1 : Date.now() + 5_000,
            securityLogSink: {
              write(event): void {
                events.push(event);
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ kind: kind === "cancel" ? "cancelled" : "timeout" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        op: "security.portable-tree-attestation.failed",
        errorKind: kind === "cancel" ? "cancelled" : "timeout",
        extra: { driver: "async" },
      });
      const persisted = expectRegisteredActivityLogLine(
        "security.portable-tree-attestation.failed",
        formatActivityLogProofLine(events[0] ?? {}),
      );
      expect(persisted.errorKind).toBe(kind === "cancel" ? "cancelled" : "timeout");
    },
  );

  it.each(["cancel", "deadline"] as const)(
    "cannot issue a receipt when %s occurs during actual full-tree IO",
    async (kind) => {
      const { input } = diskFixture();
      writeFileSync(join(input.payloadRoot, "z-padding.bin"), Buffer.alloc(5 * 1024 * 1024));
      const admitted = declaredAndTrusted(input, producedDiskApproval(input.payloadRoot));
      const controller = new AbortController();
      let clock = 1;
      let yielded = false;
      await expect(
        inspectOpenCodeServiceHostDisk(
          admitted,
          options({
            signal: controller.signal,
            deadline: 2,
            now: (): number => clock,
            yieldControl(): Promise<void> {
              yielded = true;
              if (kind === "cancel") controller.abort();
              else clock = 3;
              return Promise.resolve();
            },
          }),
        ),
      ).rejects.toMatchObject({ kind: kind === "cancel" ? "cancelled" : "timeout" });
      expect(yielded).toBe(true);
    },
  );

  it("does not evaluate a declared metadata accessor or a catalog target accessor", async () => {
    const { input, approval } = diskFixture();
    let reads = 0;
    const declared = { ...approval };
    Object.defineProperty(declared, "bootstrapSha256", {
      enumerable: true,
      get(): string {
        reads += 1;
        throw new Error("foreign accessor must not run");
      },
    });
    const catalog = {};
    Object.defineProperty(catalog, approval.platformTarget, {
      enumerable: true,
      get(): OpenCodeServiceHostApproval {
        reads += 1;
        throw new Error("foreign accessor must not run");
      },
    });
    expect(
      await inspectOpenCodeServiceHostDisk({ ...input, approval: declared }, options()),
    ).toEqual({ ok: false, reason: "host-metadata-invalid" });
    expect(
      await inspectOpenCodeServiceHostDisk({ ...input, trustedSupplement: catalog }, options()),
    ).toEqual({ ok: false, reason: "host-supplement-mismatch" });
    expect(reads).toBe(0);
  });

  it("does not return partial byte evidence when content changes during traversal", async () => {
    const { input } = diskFixture();
    writeFileSync(join(input.payloadRoot, "z-padding.bin"), Buffer.alloc(5 * 1024 * 1024));
    const admitted = declaredAndTrusted(input, producedDiskApproval(input.payloadRoot));
    let changed = false;
    await expect(
      inspectOpenCodeServiceHostDisk(
        admitted,
        options({
          yieldControl(): Promise<void> {
            if (!changed) {
              changed = true;
              writeFileSync(
                join(input.payloadRoot, "runtime/node"),
                "changed after original digest",
              );
            }
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toMatchObject({ kind: "integrity" });
    expect(changed).toBe(true);
  });
});

function startBinding(): Record<string, unknown> {
  return {
    workspace: resolve(tmpdir(), "accepted-workspace"),
    stateRoot: resolve(tmpdir(), "private-state"),
    password: "p".repeat(43),
    providerURL: "http://127.0.0.1:1983/api/coding-sidecar/gateway/chat/completions",
    facadeURL: "http://127.0.0.1:1983/api/coding-sidecar/tool",
    providerCapability: "m".repeat(32),
    facadeCapability: "t".repeat(32),
    mode: "supervised-coding",
    runId: "accepted-run",
    configDigest: "f".repeat(64),
  };
}

describe("inactive artifact-owned fixed host packet", () => {
  it("captures the same independently inspected identity and one immutable bounded LF packet", async () => {
    const { input } = diskFixture();
    const receipt = await inspectOpenCodeServiceHostDisk(input, options());
    if (!receipt.ok) throw new Error("Expected byte receipt");
    const binding = startBinding();
    const output = prepareOpenCodeServiceHostLaunch(receipt, binding, {});
    expect(output).toBeDefined();
    expect(output?.args).toEqual([join(input.payloadRoot, "host.mjs")]);
    expect(output?.executable).toBe(join(input.payloadRoot, "runtime/node"));
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output?.binding)).toBe(true);
    expect(output?.packet).toBe(JSON.stringify(output?.binding) + "\n");
    expect(Buffer.byteLength(output?.packet ?? "")).toBeLessThanOrEqual(
      OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES,
    );
    binding.password = "late-substitution";
    expect(output?.binding.password).toBe("p".repeat(43));
    expect(prepareOpenCodeServiceHostLaunch({ ...receipt }, startBinding(), {})).toBeUndefined();
  });
  it("refuses oversized UTF8, substituted program environment and unbound transports", async () => {
    const { input } = diskFixture();
    const receipt = await inspectOpenCodeServiceHostDisk(input, options());
    if (!receipt.ok) throw new Error("Expected byte receipt");
    for (const extra of [
      { providerCapability: "ä".repeat(4096), facadeCapability: "ö".repeat(4096) },
      { providerURL: "http://remote.invalid/api/coding-sidecar/gateway/chat/completions" },
      { facadeURL: "http://127.0.0.1:1984/api/coding-sidecar/tool" },
      { workspace: "relative" },
    ])
      expect(
        prepareOpenCodeServiceHostLaunch(receipt, { ...startBinding(), ...extra }, {}),
      ).toBeUndefined();
    expect(
      prepareOpenCodeServiceHostLaunch(receipt, startBinding(), {
        NODE_OPTIONS: "--import other.mjs",
      }),
    ).toBeUndefined();
  });
  it("recomputes current bytes and rejects changed tree or wrong platform without caching the receipt", async () => {
    const { input } = diskFixture();
    const receipt = await inspectOpenCodeServiceHostDisk(input, options());
    if (!receipt.ok) throw new Error("Expected byte receipt");
    const output = prepareOpenCodeServiceHostLaunch(receipt, startBinding(), {});
    if (output === undefined) throw new Error("Expected fixed program");
    await expect(
      reinspectPreparedOpenCodeServiceHost(output, {}, options(), input.target),
    ).resolves.toBe(true);
    await expect(
      reinspectPreparedOpenCodeServiceHost(output, {}, options(), "windows-x64"),
    ).resolves.toBe(false);
    writeFileSync(join(input.payloadRoot, "guard-seams.mjs"), "mutated module");
    await expect(
      reinspectPreparedOpenCodeServiceHost(output, {}, options(), input.target),
    ).resolves.toBe(false);
  });
  it("produces the fixed builder data asset from the same canonical packet constants", async () => {
    const source = createOpenCodeServiceHostPacketDataAsset();
    const asset = (await import(
      "data:text/javascript;base64," + Buffer.from(source).toString("base64")
    )) as {
      readonly fields: readonly string[];
      readonly maxBytes: number;
    };
    expect(asset.fields).toEqual(OPENCODE_SERVICE_HOST_START_PACKET_FIELDS);
    expect(Object.isFrozen(asset.fields)).toBe(true);
    expect(asset.maxBytes).toBe(OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES);
    expect(source).not.toContain("process.env");
  });
});
