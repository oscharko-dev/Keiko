import { isAbsolute, join, resolve } from "node:path";

import {
  OPENCODE_TOOL_PROFILES,
  copyOpenCodeServiceHostApproval,
  copyOpenCodeServiceHostApprovals,
  copyOpenCodeServiceHostStartPacket,
  OPENCODE_SERVICE_HOST_FIXED_FACTS,
  OPENCODE_SERVICE_HOST_START_PACKET_FIELDS,
  OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES,
  type OpenCodeServiceHostApproval,
  type OpenCodeServiceHostStartPacket,
} from "@oscharko-dev/keiko-contracts/runtime/opencode-service-host";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import {
  attestPortableSidecarTree,
  type PortableSidecarTreeAttestation,
} from "@oscharko-dev/keiko-security/portable-tree-attestation";
import {
  portableHandoffOperationFrom,
  type PortableHandoffOperationOptions,
} from "../update-portable-handoff-tree.js";

export interface OpenCodeServiceHostLaunchInput {
  readonly payloadRoot: string;
  readonly approval: unknown;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type OpenCodeServiceHostLaunchShape =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly [string];
      readonly approval: OpenCodeServiceHostApproval;
    }
  | {
      readonly ok: false;
      readonly reason:
        "host-metadata-invalid" | "host-program-invalid" | "host-environment-invalid";
    };

/**
 * Inactive fixed program producer, not disk attestation or launch authorization. Callers must
 * separately bind the approved final tree, Node, bootstrap, platform qualification and current run
 * through the existing portable/supervisor owners before admitting this shape to an actual launch.
 */
export function buildOpenCodeServiceHostLaunchShape(
  input: OpenCodeServiceHostLaunchInput,
): OpenCodeServiceHostLaunchShape {
  const approval = copyOpenCodeServiceHostApproval(input.approval);
  if (approval === undefined) return { ok: false, reason: "host-metadata-invalid" };
  if (!isAbsolute(input.payloadRoot) || resolve(input.payloadRoot) !== input.payloadRoot) {
    return { ok: false, reason: "host-program-invalid" };
  }
  const bootstrap = join(input.payloadRoot, approval.bootstrapPath);
  if (input.args !== undefined && (input.args.length !== 1 || input.args[0] !== bootstrap)) {
    return { ok: false, reason: "host-program-invalid" };
  }
  if (!closedHostEnvironment(input.env)) return { ok: false, reason: "host-environment-invalid" };
  return Object.freeze({
    ok: true,
    executable: join(input.payloadRoot, approval.nodeExecutablePath),
    args: Object.freeze([bootstrap] as const),
    approval,
  });
}

function closedHostEnvironment(env: Readonly<Record<string, string>> | undefined): boolean {
  if (env === undefined) return true;
  // Ambient Node options/loaders or injected native libraries can substitute the fixed program
  // before bootstrap validation. The existing runtime environment owner must omit these names.
  try {
    return Reflect.ownKeys(env).every((key) => {
      if (typeof key !== "string" || /^(?:NODE_|LD_|DYLD_)/iu.test(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      return (
        descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      );
    });
  } catch {
    return false;
  }
}

export interface OpenCodeServiceHostDiskInput {
  readonly payloadRoot: string;
  readonly target: UpdatePortableTarget;
  readonly approval: unknown;
  /** Supplemental catalog metadata supplied by the existing server-owned approval owner. */
  readonly trustedSupplement: unknown;
}

export type OpenCodeServiceHostDiskReceipt =
  | {
      readonly ok: true;
      readonly kind: "supplementary-disk-byte-receipt";
      readonly payloadRoot: string;
      readonly approval: OpenCodeServiceHostApproval;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "host-metadata-invalid"
        | "host-supplement-mismatch"
        | "host-root-invalid"
        | "host-bytes-mismatch";
    };

type HostDiskSuccess = Extract<OpenCodeServiceHostDiskReceipt, { readonly ok: true }>;
const ownedDiskInputs = new WeakMap<HostDiskSuccess, OpenCodeServiceHostDiskInput>();

export interface PreparedOpenCodeServiceHostLaunch {
  readonly kind: "fixed-service-host";
  readonly executable: string;
  readonly args: readonly [string];
  readonly packet: string;
  readonly binding: OpenCodeServiceHostStartPacket;
}

const ownedPrograms = new WeakMap<
  PreparedOpenCodeServiceHostLaunch,
  OpenCodeServiceHostDiskInput
>();

/** Artifact-owned inactive preparation; a caller-supplied lookalike is never a disk receipt. */
export function prepareOpenCodeServiceHostLaunch(
  receipt: HostDiskSuccess,
  input: unknown,
  env: Readonly<Record<string, string>>,
): PreparedOpenCodeServiceHostLaunch | undefined {
  const diskInput = ownedDiskInputs.get(receipt);
  const binding = copyOpenCodeServiceHostStartPacket(input);
  if (diskInput === undefined || binding === undefined || !validHostTransport(binding))
    return undefined;
  const shape = buildOpenCodeServiceHostLaunchShape({
    payloadRoot: diskInput.payloadRoot,
    approval: diskInput.approval,
    env,
  });
  if (!shape.ok || !canonicalHostRoots(binding)) return undefined;
  const packet = JSON.stringify(binding) + "\n";
  if (Buffer.byteLength(packet, "utf8") > OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES)
    return undefined;
  const result = Object.freeze({
    kind: "fixed-service-host" as const,
    executable: shape.executable,
    args: shape.args,
    packet,
    binding,
  });
  ownedPrograms.set(result, diskInput);
  return result;
}

export function isPreparedOpenCodeServiceHostLaunch(
  value: PreparedOpenCodeServiceHostLaunch,
): boolean {
  return ownedPrograms.has(value);
}

/** Same fresh full-tree owner; the earlier supplementary receipt is not a launch-freshness cache. */
export async function reinspectPreparedOpenCodeServiceHost(
  program: PreparedOpenCodeServiceHostLaunch,
  env: Readonly<Record<string, string>>,
  options: PortableHandoffOperationOptions,
  target: UpdatePortableTarget,
): Promise<boolean> {
  const input = ownedPrograms.get(program);
  if (input?.target !== target || !closedHostEnvironment(env)) return false;
  return (await inspectOpenCodeServiceHostDisk(input, options)).ok;
}

/** Fixed builder data asset; never input-supplied source or a per-run module locator. */
export function createOpenCodeServiceHostPacketDataAsset(): string {
  return (
    `export const fields = Object.freeze(${JSON.stringify(OPENCODE_SERVICE_HOST_START_PACKET_FIELDS)});\n` +
    `export const maxBytes = ${String(OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES)};\n` +
    `export const profiles = Object.freeze(${JSON.stringify(OPENCODE_TOOL_PROFILES)});\n`
  );
}

function canonicalHostRoots(binding: OpenCodeServiceHostStartPacket): boolean {
  return [binding.workspace, binding.stateRoot].every(
    (root) => isAbsolute(root) && resolve(root) === root,
  );
}

function validHostTransport(binding: OpenCodeServiceHostStartPacket): boolean {
  const provider =
    /^(http:\/\/127\.0\.0\.1:(\d{1,5}))\/api\/coding-sidecar\/gateway\/chat\/completions$/u.exec(
      binding.providerURL,
    );
  const origin = provider?.[1];
  const port = Number(provider?.[2]);
  return (
    origin !== undefined &&
    port > 0 &&
    port <= 65535 &&
    binding.facadeURL === `${origin}/api/coding-sidecar/tool`
  );
}

export const OPENCODE_SERVICE_HOST_DISK_EVIDENCE = Object.freeze([
  [OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeExecutablePath, "nodeExecutableSha256"],
  [OPENCODE_SERVICE_HOST_FIXED_FACTS.bootstrapPath, "bootstrapSha256"],
  ["package-lock.json", "packageLockSha256"],
  ["evidence/sbom.cdx.json", "sbomSha256"],
  ["evidence/installed-package-license-inventory.json", "licenseInventorySha256"],
  ["evidence/build-provenance.json", "buildProvenanceSha256"],
] as const);

/**
 * Inactive supplementary byte inspection, never runtime selection or launch authority. All six
 * file digests come from the same fresh stable full-tree pass. IO/cancellation/deadline failures
 * propagate with the existing attestation owner's body-free logging. Archive/count/source facts
 * are matched to the trusted supplement, not measured or upgraded by this disk receipt. Platform,
 * executable suitability, current authority, final launch freshness and service lifetime remain
 * obligations of the existing portable/supervisor owners before any host activation.
 */
export async function inspectOpenCodeServiceHostDisk(
  input: OpenCodeServiceHostDiskInput,
  options: PortableHandoffOperationOptions,
): Promise<OpenCodeServiceHostDiskReceipt> {
  const approval = copyOpenCodeServiceHostApproval(input.approval);
  if (approval === undefined) return Object.freeze({ ok: false, reason: "host-metadata-invalid" });
  const trusted = copyOpenCodeServiceHostApprovals(input.trustedSupplement)?.[input.target];
  if (trusted === undefined || !sameHostSupplement(approval, trusted)) {
    return Object.freeze({ ok: false, reason: "host-supplement-mismatch" });
  }
  const payloadRoot = input.payloadRoot;
  if (!isAbsolute(payloadRoot) || resolve(payloadRoot) !== payloadRoot) {
    return Object.freeze({ ok: false, reason: "host-root-invalid" });
  }
  const attestation = await attestPortableSidecarTree(
    payloadRoot,
    approval.nodeExecutablePath,
    portableHandoffOperationFrom(options),
    OPENCODE_SERVICE_HOST_DISK_EVIDENCE.map(([path]) => path),
  );
  if (!sameHostBytes(attestation, approval)) {
    return Object.freeze({ ok: false, reason: "host-bytes-mismatch" });
  }
  const result = Object.freeze({
    ok: true,
    kind: "supplementary-disk-byte-receipt",
    payloadRoot,
    approval,
  } as const);
  ownedDiskInputs.set(
    result,
    Object.freeze({
      payloadRoot,
      target: input.target,
      approval,
      trustedSupplement: Object.freeze({ [input.target]: trusted }),
    }),
  );
  return result;
}

function sameHostSupplement(
  declared: OpenCodeServiceHostApproval,
  trusted: OpenCodeServiceHostApproval,
): boolean {
  // Both inputs are canonical owned data records; field order conveys no approval semantics.
  return Object.entries(declared).every(
    ([key, value]) => Object.getOwnPropertyDescriptor(trusted, key)?.value === value,
  );
}

function sameHostBytes(
  attestation: PortableSidecarTreeAttestation,
  approval: OpenCodeServiceHostApproval,
): boolean {
  return (
    attestation.treeSha256 === approval.payloadTreeSha256 &&
    OPENCODE_SERVICE_HOST_DISK_EVIDENCE.every(
      ([path, field]) => attestation.selectedFileSha256ByPath?.[path] === approval[field],
    )
  );
}
