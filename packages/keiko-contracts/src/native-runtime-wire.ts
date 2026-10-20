export const MAX_PACKET_BYTES = 128 * 1024;
export const RESPONSE_HEADER_BYTES = 12;
export const MAX_APP_CONTROL_PAYLOAD_BYTES = 200;

export type NativeAppControlKind = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

const APP_CONTROL_PAYLOAD_BYTES = new Map<number, number>([
  [1, 40],
  [2, MAX_APP_CONTROL_PAYLOAD_BYTES],
  [3, 36],
  [4, 32],
  [5, 96],
  [6, 32],
  [7, 32],
  [8, 32],
  [9, 32],
  [10, 34],
]);

export interface NativeAppControlFrame {
  readonly kind: NativeAppControlKind;
  readonly payload: Buffer;
}

export interface NativeAppHandoffBinding {
  readonly activationId: string;
  readonly planSha256: string;
  readonly coordinatorSha256: string;
  readonly launchId: string;
}

function isAppControlKind(value: number): value is NativeAppControlKind {
  return APP_CONTROL_PAYLOAD_BYTES.has(value);
}

export function nativeAppControlFrameLength(header: Buffer): number {
  if (
    header.length !== RESPONSE_HEADER_BYTES ||
    header.subarray(0, 4).toString("ascii") !== "KHU1" ||
    header.readUInt16LE(4) !== 1
  )
    throw new Error("native-app-control-header-refused");
  const kind = header.readUInt16LE(6);
  if (!isAppControlKind(kind) || header.readUInt32LE(8) !== APP_CONTROL_PAYLOAD_BYTES.get(kind))
    throw new Error("native-app-control-kind-or-length-refused");
  return RESPONSE_HEADER_BYTES + header.readUInt32LE(8);
}

export function encodeNativeAppControlFrame(kind: NativeAppControlKind, payload: Buffer): Buffer {
  if (payload.length !== APP_CONTROL_PAYLOAD_BYTES.get(kind))
    throw new Error("native-app-control-payload-refused");
  const bytes = Buffer.alloc(RESPONSE_HEADER_BYTES + payload.length);
  bytes.write("KHU1", "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(payload.length, 8);
  payload.copy(bytes, RESPONSE_HEADER_BYTES);
  return bytes;
}

export function decodeNativeAppControlFrame(bytes: Buffer): NativeAppControlFrame {
  const length = nativeAppControlFrameLength(bytes.subarray(0, RESPONSE_HEADER_BYTES));
  const kind = bytes.readUInt16LE(6);
  if (bytes.length !== length || !isAppControlKind(kind))
    throw new Error("native-app-control-frame-refused");
  return { kind, payload: Buffer.from(bytes.subarray(RESPONSE_HEADER_BYTES)) };
}

export function encodeNativeAppHandoffStart(
  binding: NativeAppHandoffBinding,
  monotonicDeadlineMs: bigint,
): Buffer {
  if (
    !/^[a-f0-9]{32}$/u.test(binding.activationId) ||
    !/^[a-f0-9]{32}$/u.test(binding.launchId) ||
    !/^[a-f0-9]{64}$/u.test(binding.planSha256) ||
    !/^[a-f0-9]{64}$/u.test(binding.coordinatorSha256) ||
    monotonicDeadlineMs <= 0n ||
    monotonicDeadlineMs > 0xffffffffffffffffn
  )
    throw new Error("native-app-control-binding-refused");
  const payload = Buffer.alloc(MAX_APP_CONTROL_PAYLOAD_BYTES);
  payload.write(
    binding.activationId + binding.planSha256 + binding.coordinatorSha256 + binding.launchId,
    "ascii",
  );
  payload.writeBigUInt64LE(monotonicDeadlineMs, 192);
  return encodeNativeAppControlFrame(2, payload);
}

const MAX_ARGUMENTS = 64;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_]\w{0,127}$/u;

export interface NativeRuntimeLaunchPacketInput {
  readonly recoveryHandle: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ValidatedLaunchPacketPaths {
  readonly executable: string;
  readonly cwd: string;
}

export function validateNativeRuntimeLaunchPacketInput(
  request: NativeRuntimeLaunchPacketInput,
  paths: ValidatedLaunchPacketPaths,
  fail: () => never = invalidRequest,
): void {
  if (!/^[0-9a-f]{32}$/u.test(request.recoveryHandle)) fail();
  validateLaunchArguments(request.args, fail);
  validateText(paths.executable, MAX_PACKET_BYTES, fail);
  validateText(paths.cwd, MAX_PACKET_BYTES, fail);
  if (Object.keys(request.env).length > MAX_ENVIRONMENT_ENTRIES) fail();
  for (const [name, value] of Object.entries(request.env)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) fail();
    validateText(value, MAX_ENVIRONMENT_VALUE_BYTES, fail);
  }
}

export function encodeLaunchPacket(
  request: NativeRuntimeLaunchPacketInput,
  paths: ValidatedLaunchPacketPaths,
): Buffer {
  // The final wrapper may have replaced originally validated arguments. Preserve the native
  // helper's exact limits before sending any packet or spawning that helper.
  validateNativeRuntimeLaunchPacketInput(request, paths);
  const environment = Object.entries(request.env).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const values = [
    request.recoveryHandle,
    paths.executable,
    paths.cwd,
    ...request.args,
    ...environment.flatMap(([name, value]) => [name, value]),
  ];
  const payload = encodeStrings(values, request.args.length, environment.length);
  if (payload.length + RESPONSE_HEADER_BYTES > MAX_PACKET_BYTES) invalidRequest();
  return Buffer.concat([protocolHeader("KRP1", 1, payload.length), payload]);
}

export function encodeControlPacket(kind: 2 | 3): Buffer {
  return protocolHeader("KRC1", kind, 0);
}

/** App-role data follows KRP on its private pipe; native control processes never inherit it. */
export function encodeAppEnvironmentPacket(
  environment: Readonly<Record<string, string | undefined>>,
): Buffer {
  const values: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) invalidRequest();
    validateText(value, MAX_ENVIRONMENT_VALUE_BYTES, invalidRequest);
    values.push(`${name}=${value}`);
  }
  if (values.length > 4096) invalidRequest();
  const payload = encodeStrings(values, 0, values.length);
  if (payload.length + RESPONSE_HEADER_BYTES > MAX_PACKET_BYTES) invalidRequest();
  return Buffer.concat([protocolHeader("KAE1", 1, payload.length), payload]);
}

export function validResponsePayloadLength(bytes: Buffer): number | undefined {
  if (bytes.subarray(0, 4).toString("ascii") !== "KRS1" || bytes.readUInt16LE(4) !== 1)
    return undefined;
  const payloadLength = bytes.readUInt32LE(8);
  return payloadLength <= 64 ? payloadLength : undefined;
}

function encodeStrings(values: readonly string[], argumentCount: number, envCount: number): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16LE(argumentCount, 0);
  prefix.writeUInt16LE(envCount, 2);
  const parts: Buffer[] = [prefix];
  for (const value of values) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(encoded.length);
    parts.push(length, encoded, Buffer.alloc(1));
  }
  return Buffer.concat(parts);
}

function protocolHeader(magic: string, kind: number, payloadLength: number): Buffer {
  const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
  header.write(magic, 0, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(kind, 6);
  header.writeUInt32LE(payloadLength, 8);
  return header;
}

function validateText(value: string, maxBytes: number, fail: () => never): void {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) fail();
}

function validateLaunchArguments(args: readonly string[], fail: () => never): void {
  if (args.length > MAX_ARGUMENTS) fail();
  for (const argument of args) validateText(argument, MAX_ARGUMENT_BYTES, fail);
}

function invalidRequest(): never {
  throw new Error("native-runtime-request-invalid");
}
