import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";
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
