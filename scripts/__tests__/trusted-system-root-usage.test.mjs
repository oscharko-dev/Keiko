// Every Windows system path in product code must come from the ONE trusted decision in
// keiko-security (`resolveWindowsSystemDirectory` / `resolveWindowsSystemBinary` / the
// `windowsSystemRoot` re-export), never from a raw `process.env.SystemRoot` read.
//
// This is a whole-class pin, and it exists because the class was declared fixed while a
// counter-example shipped: PR #3354 introduced the shared resolver and its commit message said the
// class was closed, but `native-file-dialog/adapter.ts` still did
//
//   const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
//   return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
//
// — no validation at all, on a path that is then SPAWNED. A reviewer had to find it by hand. A raw
// read accepts every substitution the resolver rejects: UNC (`\\attacker\share`), device paths
// (`\\?\C:\Windows`), root-relative (`\Windows`, which resolves against the CURRENT drive),
// bare-relative (the process cwd, i.e. the workspace), `..` traversal, control characters, cmd.exe
// metacharacters and NTFS alternate-data-stream colons.
//
// Reading SystemRoot to FORWARD it as a child-process environment variable is a different thing and
// stays allowed — keiko-git/src/env.ts does exactly that. Only a raw read that feeds a PATH is
// banned, which is why the pattern below looks for the read and the file is then checked for a join.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES_ROOT = join(process.cwd(), "packages");

// The owning module itself, which must read the environment to validate it.
const OWNER = join("keiko-security", "src", "windows-system-directory.ts");

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (pkg.isDirectory()) walk(join(PACKAGES_ROOT, pkg.name, "src"));
  }
  return out;
}

describe("trusted Windows system-root usage (whole-class pin)", () => {
  it("no product file joins a PATH from a raw SystemRoot/WINDIR read", () => {
    const offenders = [];
    for (const path of sourceFiles()) {
      if (path.endsWith(OWNER)) continue;
      const text = readFileSync(path, "utf8");
      // Strip comments first: this very pin's own explanatory comments quote the banned pattern,
      // and so does the fixed call site's comment. A scanner that flagged those would be unusable.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      const readsRaw = /\b(?:process\.)?env\s*\.\s*(?:SystemRoot|WINDIR|windir)\b/u.test(code);
      if (!readsRaw) continue;
      // A raw read is only a defect when the value becomes a PATH. Forwarding it into a child
      // process's env (keiko-git/src/env.ts) is legitimate and must not be flagged.
      const joinsAPath =
        /\bjoin\s*\(|\bresolve\s*\(|System32|`\$\{[^}]*(?:SystemRoot|WINDIR)/u.test(code);
      if (joinsAPath) offenders.push(path.slice(path.indexOf("packages/")));
    }
    expect(offenders).toEqual([]);
  });
});
