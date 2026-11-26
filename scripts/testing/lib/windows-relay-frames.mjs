// The server's wire protocol to `keiko-runtime-supervisor.exe --relay-supervised` (ADR-0043 D21):
// KRP1 launch, KGG1 grants, KGB1 open and KRC1 terminate, in the framing
// `nativeRuntimeProcessBackend.ts` writes; the KGB1 run-id and policy-digest fields stay zero.
// Shared by the Windows relay proofs so each speaks the one encoding.
import { Buffer } from "node:buffer";

export const GRANT_READ = 1;
export const GRANT_MODIFY = 2;
const PRINCIPAL_TREE = 1;

function header(magic, kind, length) {
  const frame = Buffer.alloc(12);
  frame.write(magic, 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(length, 8);
  return frame;
}

function lengthPrefixed(value, terminated) {
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

// Each grant names its access (read or modify) for the tree's own SID and a path.
export function grantsFrame(grants) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(grants.length);
  const entries = grants.map(({ access, path }) =>
    Buffer.concat([Buffer.from([access, PRINCIPAL_TREE]), lengthPrefixed(path)]),
  );
  const payload = Buffer.concat([count, ...entries]);
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

export function terminateFrame() {
  return header("KRC1", 3, 0);
}
