export const MAX_PACKET_BYTES = 128 * 1024;
export const RESPONSE_HEADER_BYTES = 12;

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
