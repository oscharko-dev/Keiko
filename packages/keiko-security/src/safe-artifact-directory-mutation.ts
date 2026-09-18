import { lstatSync, linkSync, readSync, renameSync, unlinkSync } from "node:fs";
import { MAX_SAFE_ARTIFACT_DIRECTORY_MUTATION_PROTOCOL_BYTES } from "./safe-artifact-directory-mutation-protocol.js";
import {
  runSafeArtifactDirectoryMutation,
  type SafeArtifactDirectoryMutationIo,
} from "./safe-artifact-directory-mutation-runtime.js";

function directoryMatches(expectedDev: bigint, expectedIno: bigint): boolean {
  try {
    const current = lstatSync(".", { bigint: true });
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expectedDev &&
      current.ino === expectedIno
    );
  } catch {
    return false;
  }
}

function readRequest(): unknown {
  const buffer = Buffer.alloc(MAX_SAFE_ARTIFACT_DIRECTORY_MUTATION_PROTOCOL_BYTES + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const count = readSync(0, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset === 0 || offset > MAX_SAFE_ARTIFACT_DIRECTORY_MUTATION_PROTOCOL_BYTES) return;
    return JSON.parse(buffer.subarray(0, offset).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const mutationIo: SafeArtifactDirectoryMutationIo = {
  directoryMatches,
  link: linkSync,
  rename: renameSync,
  unlink: unlinkSync,
};

process.exitCode = runSafeArtifactDirectoryMutation(readRequest(), mutationIo);
