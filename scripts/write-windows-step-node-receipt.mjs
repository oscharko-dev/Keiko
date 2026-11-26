// #4492: writes the body-free build receipt of the patched Windows step Node.js next to the binary
// (see .github/workflows/windows-step-node.yml). The receipt carries digests, sizes, versions and the
// build flags only, in the shape of the other helper pins (`sha256`, `sizeBytes`, source digests), so
// the product pin can be copied from it.
//
//   node scripts/write-windows-step-node-receipt.mjs --exe <node.exe> --source-sha256 <hex> \
//     --patch <patch> --out <receipt.json> [--flag <name>=<value>]...
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { sha256 } from "./lib/digest.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function values(name) {
  const found = [];
  process.argv.forEach((entry, index) => {
    if (entry === name && process.argv[index + 1] !== undefined)
      found.push(process.argv[index + 1]);
  });
  return found;
}

function required(name) {
  const [value] = values(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function main() {
  const exe = required("--exe");
  const sourceSha256 = required("--source-sha256");
  if (!SHA256_PATTERN.test(sourceSha256)) throw new Error("--source-sha256 must be a SHA-256");
  const flags = Object.fromEntries(
    values("--flag").map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  const receipt = {
    schema: "keiko-windows-step-node-receipt-v1",
    nodeVersion: "26.13.1",
    patch: {
      id: "libuv-5181",
      upstream: "https://github.com/libuv/libuv/pull/5181",
      sha256: sha256(readFileSync(required("--patch"))),
    },
    source: { archive: "node-v26.13.1.tar.gz", sha256: sourceSha256 },
    executable: {
      path: "node.exe",
      sha256: sha256(readFileSync(exe)),
      sizeBytes: statSync(exe).size,
    },
    build: flags,
  };
  writeFileSync(required("--out"), `${JSON.stringify(receipt, undefined, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt.executable)}\n`);
}

main();
