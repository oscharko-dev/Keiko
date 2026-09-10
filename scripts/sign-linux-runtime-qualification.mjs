import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sign } from "sigstore";

const DEFAULT_SIGNING_DEPENDENCIES = Object.freeze({
  readFile: readFileSync,
  signReceipt: sign,
  writeFile: writeFileSync,
});

function outputPath(argv) {
  const [receipt, bundle] = argv.slice(2);
  if (argv.length !== 4 || !isAbsolute(receipt ?? "") || !isAbsolute(bundle ?? ""))
    return undefined;
  return { receipt: resolve(receipt), bundle: resolve(bundle) };
}

export async function signLinuxRuntimeQualification(
  argv = process.argv,
  dependencies = DEFAULT_SIGNING_DEPENDENCIES,
) {
  const paths = outputPath(argv);
  if (paths === undefined) return 2;
  const receipt = dependencies.readFile(paths.receipt);
  const bundle = await dependencies.signReceipt(receipt, { tlogUpload: true });
  dependencies.writeFile(paths.bundle, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return 0;
}

export async function runSignLinuxRuntimeQualificationCli(
  argv = process.argv,
  dependencies = DEFAULT_SIGNING_DEPENDENCIES,
  stderr = process.stderr,
) {
  try {
    return await signLinuxRuntimeQualification(argv, dependencies);
  } catch {
    stderr.write("linux-runtime-qualification-signing: redacted failure\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSignLinuxRuntimeQualificationCli();
}
