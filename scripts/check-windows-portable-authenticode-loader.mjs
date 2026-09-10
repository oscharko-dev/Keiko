import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CHILD_TIMEOUT_MS = 40_000;
const CHILD_OUTPUT_BYTES = 16_384;
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

function parseArguments(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${String(key)}`);
    if (key === "--helper") values.helperPath = value;
    else if (key === "--powershell") values.powershellPath = value;
    else if (key === "--runtime") values.serverRuntimePath = value;
    else if (key === "--system-root") values.systemRoot = value;
    else throw new Error(`unknown argument ${String(key)}`);
  }
  if (Object.values(values).length !== 4)
    throw new Error("all loader check arguments are required");
  return values;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await checkWindowsPortableAuthenticodeLoader(parseArguments(process.argv));
  process.stdout.write("windows-portable-authenticode-loader: PASS\n");
}
