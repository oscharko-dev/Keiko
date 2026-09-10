import type { RuntimeSupervisorLaunchRequest } from "./runtimeProcessSupervisor.js";
import {
  copyRuntimeGatewayConfinement,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";

export const MAX_PACKET_BYTES = 128 * 1024;
export const RESPONSE_HEADER_BYTES = 12;

const MAX_ARGUMENTS = 64;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_]\w{0,127}$/u;
const BASE_PROTOCOL_VERSION = 1;
const GATEWAY_CONFINEMENT_PROTOCOL_VERSION = 2;
const GATEWAY_CONFINEMENT_CAPABILITY = 1;

interface LaunchValidationDependencies {
  readonly runtimeRoots: readonly string[];
  readonly workspaceRoot: string;
  readonly safeRealFile: (path: string) => string;
  readonly safeRealDirectory: (path: string) => string;
  readonly pathIsContained: (root: string, candidate: string) => boolean;
  readonly invalidRequest: () => never;
}

export interface ValidatedLaunchPacketPaths {
  readonly executable: string;
  readonly cwd: string;
}

export function validateLaunchPacketRequest(
  request: RuntimeSupervisorLaunchRequest,
  options: LaunchValidationDependencies,
): ValidatedLaunchPacketPaths {
  const executable = options.safeRealFile(request.executable);
  const cwd = options.safeRealDirectory(request.cwd);
  if (!/^[0-9a-f]{32}$/u.test(request.recoveryHandle)) options.invalidRequest();
  if (!options.runtimeRoots.some((root) => options.pathIsContained(root, executable)))
    options.invalidRequest();
  if (!options.pathIsContained(options.workspaceRoot, cwd)) options.invalidRequest();
  if (
    request.args.length > MAX_ARGUMENTS ||
    Object.keys(request.env).length > MAX_ENVIRONMENT_ENTRIES
  )
    options.invalidRequest();
  for (const argument of request.args)
    validateText(argument, MAX_ARGUMENT_BYTES, options.invalidRequest);
  for (const [name, value] of Object.entries(request.env)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) options.invalidRequest();
    validateText(value, MAX_ENVIRONMENT_VALUE_BYTES, options.invalidRequest);
  }
  return { executable, cwd };
}

export function encodeLaunchPacket(
  request: RuntimeSupervisorLaunchRequest,
  paths: ValidatedLaunchPacketPaths,
  gatewayConfinement?: RuntimeGatewayConfinement,
): Buffer {
  const closedConfinement = closeGatewayConfinement(gatewayConfinement);
  const environment = Object.entries(request.env).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const values = [
    request.recoveryHandle,
    paths.executable,
    paths.cwd,
    ...(closedConfinement === undefined ? [] : confinementStrings(closedConfinement)),
    ...request.args,
    ...environment.flatMap(([name, value]) => [name, value]),
  ];
  const prefix = launchPrefix(request.args.length, environment.length, closedConfinement);
  const payload = encodeStrings(prefix, values);
  if (payload.length + RESPONSE_HEADER_BYTES > MAX_PACKET_BYTES) invalidRequest();
  const version =
    closedConfinement === undefined ? BASE_PROTOCOL_VERSION : GATEWAY_CONFINEMENT_PROTOCOL_VERSION;
  return Buffer.concat([protocolHeader("KRP1", 1, payload.length, version), payload]);
}

export function encodeControlPacket(kind: 2 | 3): Buffer {
  return protocolHeader("KRC1", kind, 0, BASE_PROTOCOL_VERSION);
}

export function validResponsePayloadLength(bytes: Buffer): number | undefined {
  if (bytes.subarray(0, 4).toString("ascii") !== "KRS1" || bytes.readUInt16LE(4) !== 1)
    return undefined;
  const payloadLength = bytes.readUInt32LE(8);
  return payloadLength <= 64 ? payloadLength : undefined;
}

function launchPrefix(
  argumentCount: number,
  envCount: number,
  confinement: RuntimeGatewayConfinement | undefined,
): Buffer {
  const prefix = Buffer.alloc(confinement === undefined ? 4 : 12);
  prefix.writeUInt16LE(argumentCount, 0);
  prefix.writeUInt16LE(envCount, 2);
  if (confinement !== undefined) {
    prefix.writeUInt16LE(GATEWAY_CONFINEMENT_CAPABILITY, 4);
    prefix.writeUInt16LE(confinement.addressFamily === "ipv4" ? 4 : 6, 6);
    prefix.writeUInt16LE(confinement.port, 8);
  }
  return prefix;
}

function encodeStrings(prefix: Buffer, values: readonly string[]): Buffer {
  const parts: Buffer[] = [prefix];
  for (const value of values) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(encoded.length);
    parts.push(length, encoded, Buffer.alloc(1));
  }
  return Buffer.concat(parts);
}

function protocolHeader(
  magic: string,
  kind: number,
  payloadLength: number,
  version: number,
): Buffer {
  const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
  header.write(magic, 0, "ascii");
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(kind, 6);
  header.writeUInt32LE(payloadLength, 8);
  return header;
}

function closeGatewayConfinement(
  value: RuntimeGatewayConfinement | undefined,
): RuntimeGatewayConfinement | undefined {
  if (value === undefined) return undefined;
  const closed = copyRuntimeGatewayConfinement(value);
  if (closed === undefined) invalidRequest();
  return closed;
}

function confinementStrings(value: RuntimeGatewayConfinement): readonly string[] {
  return [
    value.runId,
    value.treeBindingId,
    value.envelopeDigest,
    value.runtimeArtifactDigest,
    value.modelProfileDigest,
    value.policyDigest,
  ];
}

function validateText(value: string, maxBytes: number, fail: () => never): void {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) fail();
}

function invalidRequest(): never {
  throw new Error("native-runtime-request-invalid");
}
