// Wire frames of the runtime supervisor's `--relay-supervised` protocol (KRP1 launch, KGG1 grants,
// KGB1 open, KRC1 terminate), shared by the Windows confinement proofs that drive the real supervisor.
import { Buffer } from "node:buffer";

export function header(magic, kind, length) {
  const frame = Buffer.alloc(12);
  frame.write(magic, 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(length, 8);
  return frame;
}

export function lengthPrefixed(value, terminated) {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded, ...(terminated ? [Buffer.alloc(1)] : [])]);
}

export function launchFrame(handle, executable, cwd, args, environment) {
  const counts = Buffer.alloc(4);
  counts.writeUInt16LE(args.length, 0);
  counts.writeUInt16LE(environment.length, 2);
  const values = [handle, executable, cwd, ...args, ...environment.flat()];
  const payload = Buffer.concat([counts, ...values.map((value) => lengthPrefixed(value, true))]);
  return Buffer.concat([header("KRP1", 1, payload.length), payload]);
}

export function grantsFrame(paths) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(paths.length);
  // Each grant: access read (1), principal tree (1), then the path.
  const grants = paths.map((path) => Buffer.concat([Buffer.from([1, 1]), lengthPrefixed(path)]));
  const payload = Buffer.concat([count, ...grants]);
  return Buffer.concat([header("KGG1", 1, payload.length), payload]);
}

export function openFrame(handle, gatewayPort) {
  const frame = Buffer.alloc(540);
  header("KGB1", 1, 528).copy(frame);
  frame.write(handle, 44, "ascii");
  frame.writeUInt16LE(2, 84);
  frame.writeUInt16LE(gatewayPort, 86);
  return frame;
}
