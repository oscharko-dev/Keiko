// Temporary Windows-only diagnosis for the in-memory locality carrier. It reads the fixed source
// and changes only its catch projection to a closed stage token; it never prints paths, env, query
// text, or exception bodies. Remove after the failing hosted run identifies the stage.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { join, win32 } from "node:path";

const source = readFileSync("packages/keiko-security/src/windows-local-volume.ts", "utf8");
const match = /const QUERY = String\.raw`([\s\S]*?)`;/u.exec(source);
if (match?.[1] === undefined) process.exit(2);

let query = match[1]
  .replace("try {\n  $assembly =", "try {\n  $stage = 'assembly'\n  $assembly =")
  .replace("  $api = $type.CreateType()", "  $stage = 'type'\n  $api = $type.CreateType()")
  .replace("  $handle = $create.Invoke", "  $stage = 'open'\n  $handle = $create.Invoke")
  .replace("    $tag =", "    $stage = 'tag'\n    $tag =")
  .replace("    $final =", "    $stage = 'final'\n    $final =")
  .replace("    $volume =", "    $stage = 'volume'\n    $volume =");
const exitStages = [
  [
    "if ($handle.IsInvalid) { exit 1 }",
    "if ($handle.IsInvalid) { [Console]::Out.Write('KLV_DIAG:handle'); exit 1 }",
  ],
  [
    "if (-not $tagInfo.Invoke($null, @($handle, [int]9, $tag, [uint32]8)) -or (([Runtime.InteropServices.Marshal]::ReadInt32($tag, 0) -band 0x400) -ne 0)) { exit 1 }",
    "if (-not $tagInfo.Invoke($null, @($handle, [int]9, $tag, [uint32]8)) -or (([Runtime.InteropServices.Marshal]::ReadInt32($tag, 0) -band 0x400) -ne 0)) { [Console]::Out.Write('KLV_DIAG:tag'); exit 1 }",
  ],
  [
    "if ($length -eq 0 -or $length -ge $final.Capacity) { exit 1 }",
    "if ($length -eq 0 -or $length -ge $final.Capacity) { [Console]::Out.Write('KLV_DIAG:final'); exit 1 }",
  ],
  [
    "if (-not $canonical.TrimEnd('\\').Equals($p.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { exit 1 }",
    "if (-not $canonical.TrimEnd('\\').Equals($p.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.Write('KLV_DIAG:canonical'); exit 1 }",
  ],
  [
    "if (-not $volumePath.Invoke($null, @($p, $volume, [uint32]$volume.Capacity))) { exit 1 }",
    "if (-not $volumePath.Invoke($null, @($p, $volume, [uint32]$volume.Capacity))) { [Console]::Out.Write('KLV_DIAG:volume'); exit 1 }",
  ],
  [
    "if ($kind -ne 2 -and $kind -ne 3 -and $kind -ne 6) { exit 1 }",
    "if ($kind -ne 2 -and $kind -ne 3 -and $kind -ne 6) { [Console]::Out.Write('KLV_DIAG:drive'); exit 1 }",
  ],
];
for (const [before, after] of exitStages) query = query.replace(before, after);
const catchIndex = query.lastIndexOf("} catch { exit 1 }");
if (catchIndex < 0) process.exit(3);
query = `${query.slice(0, catchIndex)}} catch { [Console]::Out.Write('KLV_DIAG:' + $stage); exit 1 }${query.slice(catchIndex + "} catch { exit 1 }".length)}`;

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
const output = result.stdout === "KEIKO_LOCAL_VOLUME_OK" ? "KLV_DIAG:success" : result.stdout;
const diagnostic =
  /^KLV_DIAG:(assembly|type|open|handle|tag|final|canonical|volume|drive|success)$/u.test(output)
    ? output
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
