import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";
import type { RuntimeGatewayConfinement } from "@oscharko-dev/keiko-sandbox";
import {
  validateNativeRuntimeLaunchPacketInput,
  encodeLaunchPacket as encodeNativeLaunchPacket,
  type ValidatedLaunchPacketPaths,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
export {
  MAX_PACKET_BYTES,
  RESPONSE_HEADER_BYTES,
  encodeControlPacket,
  validResponsePayloadLength,
  type ValidatedLaunchPacketPaths,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";

export function encodeLaunchPacket(
  request: RuntimeSupervisorLaunchRequest,
  paths: ValidatedLaunchPacketPaths,
): Buffer {
  return encodeNativeLaunchPacket(request, paths);
}

/** KGB1 open, as validated by gateway_request.c. The supervisor supplies the
 * per-connection nonce and its own kernel job handle after creating the suspended root. */
export function encodeWindowsGatewayOpen(
  policy: RuntimeGatewayConfinement,
  recoveryHandle: string,
): Buffer {
  const frame = Buffer.alloc(540);
  frame.write("KGB1");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(1, 6);
  frame.writeUInt32LE(frame.length - 12, 8);
  frame.write(recoveryHandle, 44);
  frame.writeUInt16LE(policy.addressFamily === "ipv4" ? 2 : 23, 84);
  frame.writeUInt16LE(policy.port, 86);
  frame.writeUInt16LE(policy.runId.length, 88);
  [
    policy.treeBindingId,
    policy.envelopeDigest,
    policy.runtimeArtifactDigest,
    policy.modelProfileDigest,
    policy.policyDigest,
  ].forEach((digest, index) => frame.write(digest, 92 + index * 64));
  frame.write(policy.runId, 412);
  return frame;
}

/**
 * What the per-tree AppContainer of a confined Windows run may reach on disk (#4068). The tree's own
 * SID gets the runtime and its private state, and both are revoked when the tree ends. A
 * Keiko-managed worktree is granted once to a capability derived from its identity, so a run does
 * not walk the whole repository; only runs of that worktree carry the capability.
 */
export type WindowsFilesystemGrant =
  | {
      readonly path: string;
      readonly access: "read" | "modify";
      readonly principal: "tree";
    }
  | {
      readonly path: string;
      readonly access: "read";
      readonly principal: "capability";
      readonly capability: string;
    };

export const WINDOWS_FILESYSTEM_GRANTS_MAX = 8;
const WINDOWS_GRANT_CAPABILITY = /^keiko\.workspace\.[a-f0-9]{32}$/u;

export function validWindowsGrantCapability(value: string): boolean {
  return WINDOWS_GRANT_CAPABILITY.test(value);
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function encodeWindowsGrant(grant: WindowsFilesystemGrant): Buffer {
  const head = Buffer.from([
    grant.access === "modify" ? 2 : 1,
    grant.principal === "capability" ? 2 : 1,
  ]);
  return grant.principal === "capability"
    ? Buffer.concat([head, lengthPrefixed(grant.path), lengthPrefixed(grant.capability)])
    : Buffer.concat([head, lengthPrefixed(grant.path)]);
}

/** KGG1 grants, read by gateway_grants.c after the broker named the tree's SID and before the
 * suspended root exists. An empty list is a valid frame: the confined launch always sends one. */
export function encodeWindowsGatewayGrants(grants: readonly WindowsFilesystemGrant[]): Buffer {
  if (grants.length > WINDOWS_FILESYSTEM_GRANTS_MAX) throw new RangeError("windows-grants-invalid");
  const count = Buffer.alloc(2);
  count.writeUInt16LE(grants.length);
  const payload = Buffer.concat([count, ...grants.map(encodeWindowsGrant)]);
  const header = Buffer.alloc(12);
  header.write("KGG1");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 6);
  header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

interface LaunchValidationDependencies {
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly safeRealFile: (path: string) => string;
  readonly safeRealDirectory: (path: string) => string;
  readonly pathIsContained: (root: string, candidate: string) => boolean;
  readonly invalidRequest: () => never;
}

export function validateLaunchPacketRequest(
  request: RuntimeSupervisorLaunchRequest,
  options: LaunchValidationDependencies,
): ValidatedLaunchPacketPaths {
  const executable = options.safeRealFile(request.executable);
  const cwd = options.safeRealDirectory(request.cwd);
  if (!options.runtimeRoots.some((root) => options.pathIsContained(root, executable)))
    options.invalidRequest();
  if (!options.pathIsContained(options.workspaceRoot, cwd)) options.invalidRequest();
  validateNativeRuntimeLaunchPacketInput(request, { executable, cwd }, options.invalidRequest);
  return { executable, cwd };
}
