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
