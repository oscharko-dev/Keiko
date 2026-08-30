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

// IDX55 (PR #3355 review): the original readsRaw regex matched ONLY dot-property access
// (`env.SystemRoot`), so `process.env["SystemRoot"]` (computed/bracket access) and
// `process.env?.SystemRoot` (optional chaining) read the exact same raw value while sailing past
// the pin entirely. Both forms are widened here, as two SEPARATE alternatives rather than one
// do-everything regex, so each stays readable and independently testable (see the fixtures below).
//
// Dot access, with or without optional chaining: `env.SystemRoot`, `env?.SystemRoot`,
// `process.env?.WINDIR`.
const READS_RAW_DOT_ACCESS = /\b(?:process\.)?env\s*\??\.\s*(?:SystemRoot|WINDIR|windir)\b/u;
// Bracket/computed access, with or without optional chaining: `env["SystemRoot"]`,
// `env['WINDIR']`, `` env?.[`SystemRoot`] ``.
const READS_RAW_BRACKET_ACCESS =
  /\b(?:process\.)?env\s*(?:\?\.)?\s*\[\s*["'`](?:SystemRoot|WINDIR|windir)["'`]\s*\]/u;

// A raw read is only a defect when the value becomes a PATH. Forwarding it into a child process's
// env (keiko-git/src/env.ts) is legitimate and must not be flagged.
const JOINS_A_PATH = /\bjoin\s*\(|\bresolve\s*\(|System32|`\$\{[^}]*(?:SystemRoot|WINDIR)/u;

// Comments are stripped first: this very pin's own explanatory comments quote the banned pattern,
// and so does every fixed call site's comment. A scanner that flagged those would be unusable.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function joinsAPathFromRawSystemRoot(text) {
  const code = stripComments(text);
  const readsRaw = READS_RAW_DOT_ACCESS.test(code) || READS_RAW_BRACKET_ACCESS.test(code);
  return readsRaw && JOINS_A_PATH.test(code);
}

describe("trusted Windows system-root usage (whole-class pin)", () => {
  it("no product file joins a PATH from a raw SystemRoot/WINDIR read", () => {
    const offenders = [];
    for (const path of sourceFiles()) {
      if (path.endsWith(OWNER)) continue;
      const text = readFileSync(path, "utf8");
      if (joinsAPathFromRawSystemRoot(text)) offenders.push(path.slice(path.indexOf("packages/")));
    }
    expect(offenders).toEqual([]);
  });

  // IDX55 fixtures: prove the widened detection actually fires on the two forms the original
  // dot-only regex missed, rather than trusting the regex change by inspection alone.
  describe("detects a raw SystemRoot/WINDIR read regardless of access form (fixtures)", () => {
    it.each([
      ["dot access", 'const p = join(process.env.SystemRoot ?? "C:\\\\Windows", "System32");'],
      [
        "optional-chained dot access",
        'const p = join(process.env?.SystemRoot ?? "C:\\\\Windows", "System32");',
      ],
      [
        "bracket access with double quotes",
        'const p = join(process.env["SystemRoot"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "bracket access with single quotes",
        "const p = join(process.env['WINDIR'] ?? String.raw`C:\\\\Windows`, \"System32\");",
      ],
      [
        "optional-chained bracket access",
        'const p = join(process.env?.["SystemRoot"] ?? "C:\\\\Windows", "System32");',
      ],
      [
        "bare env (no process. prefix), bracket access",
        'const p = join(env["windir"] ?? "C:\\\\Windows", "System32");',
      ],
    ])("flags %s joined onto a path", (_label, snippet) => {
      expect(joinsAPathFromRawSystemRoot(snippet)).toBe(true);
    });

    it.each([
      [
        "dot access forwarded into a child env, never joined",
        "const childEnv = { ...base, SystemRoot: process.env.SystemRoot };",
      ],
      [
        "bracket access forwarded into a child env, never joined",
        'const childEnv = { ...base, SystemRoot: process.env["SystemRoot"] };',
      ],
      [
        "an unrelated env var read with the same access forms",
        'const lang = process.env.LANG; const home = process.env?.["HOME"];',
      ],
    ])("does not flag %s", (_label, snippet) => {
      expect(joinsAPathFromRawSystemRoot(snippet)).toBe(false);
    });
  });
});
