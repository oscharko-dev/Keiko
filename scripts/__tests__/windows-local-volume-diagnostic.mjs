// Temporary Windows-only diagnosis for the in-memory locality carrier. It reads the fixed source
// and changes only its catch projection to a closed stage token; it never prints paths, env, query
// text, or exception bodies. Remove after the failing hosted run identifies the stage.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { join, win32 } from "node:path";

const source = readFileSync(
  "packages/keiko-security/src/windows-local-volume.ts",
  "utf8",
).replaceAll("\r\n", "\n");
const match = /const QUERY = String\.raw`([\s\S]*?)`;/u.exec(source);
if (match?.[1] === undefined) process.exit(2);

let query = match[1];
function replaceOnce(before, after) {
  const index = query.indexOf(before);
  if (index < 0 || query.indexOf(before, index + before.length) >= 0) process.exit(7);
  query = `${query.slice(0, index)}${after}${query.slice(index + before.length)}`;
}
replaceOnce(
  "$encoded = [Console]::In.ReadLine()",
  "$stage = 'read'; mark $stage\n$encoded = [Console]::In.ReadLine()\n$stage = 'input'; mark $stage",
);
replaceOnce(
  "if ([string]::IsNullOrWhiteSpace($p) -or",
  "$stage = 'decode'; mark $stage\nif ([string]::IsNullOrWhiteSpace($p) -or",
);
replaceOnce(
  "$p = [IO.Path]::GetFullPath($p)",
  "$stage = 'path'; mark $stage\n$p = [IO.Path]::GetFullPath($p)\n$stage = 'fullpath'; mark $stage\n$iterations = 0",
);
replaceOnce(
  "while (-not [IO.Directory]::Exists($p)) {",
  "$stage = 'directory'; mark $stage\nwhile (-not [IO.Directory]::Exists($p)) {\n  if ($iterations -eq 0) { $stage = 'ancestor'; mark $stage }\n  $iterations += 1\n  if ($iterations -gt 128) { mark 'ancestor-limit'; exit 1 }",
);
replaceOnce(
  "try {\n  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly",
  "$stage = 'existing'; mark $stage\ntry {\n  $stage = 'assembly'; mark $stage\n  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly",
);
replaceOnce(
  "  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('KeikoLocalVolume')), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "  $stage = 'assembly-name'; mark $stage\n  $name = New-Object Reflection.AssemblyName('KeikoLocalVolume')\n  $stage = 'assembly-define'; mark $stage\n  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)",
);
replaceOnce(
  "  $module = $assembly.DefineDynamicModule('KeikoLocalVolume')",
  "  $stage = 'module'; mark $stage\n  $module = $assembly.DefineDynamicModule('KeikoLocalVolume')",
);
replaceOnce(
  "  $type = $module.DefineType('KeikoLocalVolumeApi', [Reflection.TypeAttributes]'Public, Abstract, Sealed')",
  "  $stage = 'type'; mark $stage\n  $type = $module.DefineType('KeikoLocalVolumeApi', [Reflection.TypeAttributes]'Public, Abstract, Sealed')",
);
replaceOnce(
  "  $handle = $create.Invoke",
  "  $stage = 'open'; mark $stage\n  $handle = $create.Invoke",
);
replaceOnce("    $tag =", "    $stage = 'tag'; mark $stage\n    $tag =");
replaceOnce("    $final =", "    $stage = 'final'; mark $stage\n    $final =");
replaceOnce("    $volume =", "    $stage = 'volume'; mark $stage\n    $volume =");
replaceOnce("[Console]::Out.Write('KEIKO_LOCAL_VOLUME_OK')", "mark 'success'");
query = `function mark($value) { [Console]::Out.Write('K:' + $value + ';'); [Console]::Out.Flush() }\n${query}`;
const exitStages = [
  [
    "if ([string]::IsNullOrWhiteSpace($encoded) -or $encoded.Length -gt 65536) { exit 1 }",
    "if ([string]::IsNullOrWhiteSpace($encoded) -or $encoded.Length -gt 65536) { mark 'input'; exit 1 }",
  ],
  [
    "try { $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) } catch { exit 1 }",
    "try { $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) } catch { mark 'decode'; exit 1 }",
  ],
  [
    "if ([string]::IsNullOrWhiteSpace($p) -or $p.StartsWith('\\\\') -or $p.StartsWith('//')) { exit 1 }",
    "if ([string]::IsNullOrWhiteSpace($p) -or $p.StartsWith('\\\\') -or $p.StartsWith('//')) { mark 'decode'; exit 1 }",
  ],
  [
    "if ([string]::IsNullOrEmpty($parent) -or $parent -eq $p) { exit 1 }",
    "if ([string]::IsNullOrEmpty($parent) -or $parent -eq $p) { mark 'path'; exit 1 }",
  ],
  ["if ($handle.IsInvalid) { exit 1 }", "if ($handle.IsInvalid) { mark 'handle'; exit 1 }"],
  [
    "if (-not $tagInfo.Invoke($null, @($handle, [int]9, $tag, [uint32]8)) -or (([Runtime.InteropServices.Marshal]::ReadInt32($tag, 0) -band 0x400) -ne 0)) { exit 1 }",
    "if (-not $tagInfo.Invoke($null, @($handle, [int]9, $tag, [uint32]8)) -or (([Runtime.InteropServices.Marshal]::ReadInt32($tag, 0) -band 0x400) -ne 0)) { mark 'tag'; exit 1 }",
  ],
  [
    "if ($length -eq 0 -or $length -ge $final.Capacity) { exit 1 }",
    "if ($length -eq 0 -or $length -ge $final.Capacity) { mark 'final'; exit 1 }",
  ],
  [
    "if (-not $canonical.TrimEnd('\\').Equals($p.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { exit 1 }",
    "if (-not $canonical.TrimEnd('\\').Equals($p.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { mark 'canonical'; exit 1 }",
  ],
  [
    "if (-not $volumePath.Invoke($null, @($p, $volume, [uint32]$volume.Capacity))) { exit 1 }",
    "if (-not $volumePath.Invoke($null, @($p, $volume, [uint32]$volume.Capacity))) { mark 'volume'; exit 1 }",
  ],
  [
    "if ($kind -ne 2 -and $kind -ne 3 -and $kind -ne 6) { exit 1 }",
    "if ($kind -ne 2 -and $kind -ne 3 -and $kind -ne 6) { mark 'drive'; exit 1 }",
  ],
];
for (const [before, after] of exitStages) replaceOnce(before, after);
const catchIndex = query.lastIndexOf("} catch { exit 1 }");
if (catchIndex < 0) process.exit(3);
query = `${query.slice(0, catchIndex)}} catch { mark $stage; exit 1 }${query.slice(catchIndex + "} catch { exit 1 }".length)}`;

const systemRoot = process.env.SystemRoot;
if (process.platform !== "win32" || systemRoot === undefined) process.exit(4);
const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const root = process.argv[2];
if (root === undefined) process.exit(5);
const result = spawnSync(
  executable,
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(query, "utf16le").toString("base64"),
  ],
  {
    encoding: "utf8",
    env: {
      SystemRoot: win32.normalize(systemRoot),
      WINDIR: win32.normalize(systemRoot),
      SystemDrive: systemRoot.slice(0, 2),
    },
    input: `${Buffer.from(root, "utf8").toString("base64")}\n`,
    maxBuffer: 256,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  },
);
const output = result.stdout ?? "";
const stages = [
  ...output.matchAll(
    /K:(read|input|decode|path|fullpath|directory|ancestor|ancestor-limit|existing|assembly|assembly-name|assembly-define|module|type|open|handle|tag|final|canonical|volume|drive|success);/gu,
  ),
];
const lastStage = stages.at(-1)?.[1];
const diagnostic =
  result.error?.code === "ETIMEDOUT"
    ? `KLV_DIAG:timeout-${lastStage ?? "none"}`
    : lastStage !== undefined
      ? `KLV_DIAG:${lastStage}`
      : result.error?.code === "ENOBUFS"
        ? "KLV_DIAG:overflow"
        : result.error !== undefined
          ? "KLV_DIAG:spawn-error"
          : result.status === null
            ? "KLV_DIAG:null-status"
            : result.stderr !== ""
              ? "KLV_DIAG:stderr"
              : result.stdout === ""
                ? "KLV_DIAG:empty"
                : "KLV_DIAG:stdout-other";
process.stdout.write(`${diagnostic}\n`);
