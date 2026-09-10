import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sign } from "sigstore";

function outputPath(argv) {
  const [receipt, bundle] = argv.slice(2);
  if (argv.length !== 4 || !isAbsolute(receipt ?? "") || !isAbsolute(bundle ?? ""))
    return undefined;
  return { receipt: resolve(receipt), bundle: resolve(bundle) };
}

export async function signLinuxRuntimeQualification(argv = process.argv) {
  const paths = outputPath(argv);
  if (paths === undefined) return 2;
  const receipt = readFileSync(paths.receipt);
  const bundle = await sign(receipt, { tlogUpload: true });
  writeFileSync(paths.bundle, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await signLinuxRuntimeQualification();
}
