import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHILD_TIMEOUT_MS = 40_000;
const CHILD_OUTPUT_BYTES = 16_384;
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "..");
const SERVER_RUNTIME_PATH = resolve(
  REPOSITORY_ROOT,
  "packages/keiko-server/dist/coding-runtime/windowsPortableAuthenticode.js",
);
const HELPER_FILE_NAME = "windows-portable-authenticode-standard-token-loader.exe";
const CLOSED_HELPER_DIAGNOSTICS = [
  /^standard-token-loader:[a-z-]+\r?\n?$/u,
  /^standard-token-loader:[a-z-]+:win32-\d+\r?\n?$/u,
  /^standard-token-loader:[a-z-]+:[A-Za-z]+:hresult-[0-9A-F]{8}\r?\n?$/u,
  /^standard-token-loader:[a-z-]+:child-[0-9A-F]{8}\r?\n?$/u,
];

function closedHelperDiagnostic(stderr) {
  return typeof stderr === "string" &&
    CLOSED_HELPER_DIAGNOSTICS.some((pattern) => pattern.test(stderr))
    ? stderr.trim()
    : "unavailable";
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function assertContainedRegularFile(candidate, root, expectedName, label) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!hasApprovedPathShape(candidate, root, expectedName)) {
    throw new Error(`${label} path is not an approved absolute executable path`);
  }
  const lexicalContainment = relative(rootPath, candidatePath);
  if (
    lexicalContainment === ".." ||
    lexicalContainment.startsWith(`..${sep}`) ||
    isAbsolute(lexicalContainment)
  ) {
    throw new Error(`${label} path is not an approved absolute executable path`);
  }
  const rootReal = realpathSync(rootPath);
  const stat = lstatSync(candidatePath);
  const candidateReal = realpathSync(candidatePath);
  if (stat.isSymbolicLink() || !stat.isFile() || escapesRoot(rootReal, candidateReal)) {
    throw new Error(`${label} path escapes its approved root`);
  }
  return candidateReal;
}

function hasApprovedPathShape(candidate, root, expectedName) {
  return isAbsolute(candidate) && isAbsolute(root) && basename(candidate) === expectedName;
}

function escapesRoot(root, candidate) {
  const contained = relative(root, candidate);
  return contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained);
}

function trustedLoaderContext(helperPath, env) {
  const systemRoot = env.SystemRoot;
  const runnerTemp = env.RUNNER_TEMP;
  if (systemRoot === undefined || runnerTemp === undefined) {
    throw new Error("SystemRoot and RUNNER_TEMP are required for the Windows loader check");
  }
  const powershellPath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return {
    helperPath: assertContainedRegularFile(
      helperPath,
      runnerTemp,
      HELPER_FILE_NAME,
      "restricted-token helper",
    ),
    powershellPath: assertContainedRegularFile(
      powershellPath,
      systemRoot,
      "powershell.exe",
      "Windows PowerShell",
    ),
    serverRuntimePath: assertContainedRegularFile(
      SERVER_RUNTIME_PATH,
      REPOSITORY_ROOT,
      "windowsPortableAuthenticode.js",
      "built Authenticode runtime",
    ),
    systemRoot: realpathSync(systemRoot),
  };
}

function runRestricted(run, helper, powershell, systemRoot, script, input) {
  return run(helper, [powershell, systemRoot, encodedPowerShell(script)], {
    encoding: "utf8",
    input,
    maxBuffer: CHILD_OUTPUT_BYTES,
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
}

function assertProbeSucceeded(result, label) {
  if (result.error === undefined && result.status === 0 && result.stdout === "") return;
  throw new Error(
    `${label} failed (${result.status ?? "spawn"};${closedHelperDiagnostic(result.stderr)})`,
  );
}

function transportProbe(sentinel) {
  return (
    "$ErrorActionPreference='Stop';$s=[Console]::In.ReadToEnd();" +
    `if($s -cne '${sentinel}'){exit 23};` +
    "if($null -ne $env:TMP -or $null -ne $env:TEMP -or $null -ne $env:USERPROFILE){exit 20};" +
    "$i=[Security.Principal.WindowsIdentity]::GetCurrent();" +
    "$p=[Security.Principal.WindowsPrincipal]::new($i);" +
    "if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 22};exit 0"
  );
}

function verifierProbe(loader) {
  return (
    loader +
    "if($null -ne $env:TMP -or $null -ne $env:TEMP -or $null -ne $env:USERPROFILE){exit 20};" +
    "$i=[Security.Principal.WindowsIdentity]::GetCurrent();" +
    "$p=[Security.Principal.WindowsPrincipal]::new($i);" +
    "if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 22};" +
    "$v=[Keiko.Portable.Runtime.Rfc3161]::DecodeOid([byte[]](6,2,42,3));" +
    "if($v -cne '1.2.3'){exit 21};exit 0"
  );
}

function assertCorruptInputsDenied({ helperPath, input, powershellPath, probe, run, systemRoot }) {
  for (const invalid of [input.slice(0, -4), `A${input.slice(1)}`]) {
    const denied = runRestricted(run, helperPath, powershellPath, systemRoot, probe, invalid);
    if (denied.error !== undefined || denied.status !== 1) {
      throw new Error("restricted verifier loader accepted corrupt assembly input");
    }
  }
}

export async function checkWindowsPortableAuthenticodeLoader({
  helperPath,
  powershellPath,
  serverRuntimePath,
  systemRoot,
  run = spawnSync,
}) {
  const runtime = await import(pathToFileURL(resolve(serverRuntimePath)).href);
  const loader = runtime.windowsAuthenticodeVerifierLoaderScript();
  const input = runtime.windowsAuthenticodeVerifierAssemblyInput();
  const sentinel = "keiko-authenticode-stdin-v1";
  const transport = runRestricted(
    run,
    helperPath,
    powershellPath,
    systemRoot,
    transportProbe(sentinel),
    sentinel,
  );
  assertProbeSucceeded(transport, "restricted stdin probe");
  const probe = verifierProbe(loader);
  const valid = runRestricted(run, helperPath, powershellPath, systemRoot, probe, input);
  assertProbeSucceeded(valid, "restricted verifier loader");
  assertCorruptInputsDenied({ helperPath, input, powershellPath, probe, run, systemRoot });
}

function parseHelperArgument(argv) {
  if (argv.length !== 4 || argv[2] !== "--helper" || argv[3] === undefined) {
    throw new Error("exactly one --helper argument is required");
  }
  return argv[3];
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const context = trustedLoaderContext(parseHelperArgument(process.argv), process.env);
  await checkWindowsPortableAuthenticodeLoader(context);
  process.stdout.write("windows-portable-authenticode-loader: PASS\n");
}
