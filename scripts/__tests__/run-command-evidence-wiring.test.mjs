// Pins the termination-evidence seam across EVERY production runCommand caller (PR #3354 review,
// comment 3887021650). The defect class: `onTerminated` is optional, so a production path can call
// keiko-tools' runCommand without it and a Windows timeout/abort on that path terminates with no
// activity-log evidence at all — the always-on `run_command` tool, the governed git lanes and the
// verification orchestrator all shipped exactly that way while only the direct server call sites
// were wired.
//
// The pin is FILE-scoped and fail-closed: every non-test source file that invokes keiko-tools'
// runCommand (directly, or as `deps.runCommand(...)` through an injected port) must reference the
// seam — either passing `onTerminated` at a call/deps site or forwarding a `deps.onTerminated`
// into the RunCommandDeps it builds. A new caller file without the seam fails here, and removing
// the seam from a wired file fails here. There is deliberately NO exemption list.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES_ROOT = join(process.cwd(), "packages");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sourceFiles() {
  const out = [];
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES_ROOT, pkg.name, "src");
    try {
      out.push(...walk(src));
    } catch {
      // A package without src/ carries no callers.
    }
  }
  return out.filter((path) => !/\.test\.ts$/.test(path) && !/[\\/]testing[\\/]/.test(path));
}

// A file COUNTS as a production caller when it either imports keiko-tools' runCommand (by name or
// as a namespace) and invokes it, or invokes an injected `<something>.runCommand(` port typed
// against RunCommandDeps. Files that merely define their own local helper named runCommand
// (scripts-style wrappers) import nothing from exec.js / the keiko-tools barrel and are excluded
// by the import checks.
function isProductionCaller(path, text) {
  if (path.endsWith(`${join("keiko-tools", "src", "exec.ts")}`)) return false;
  const importsExec =
    /import\s*\{[^}]*\brunCommand\b[^}]*\}\s*from\s*"(?:\.\/exec\.js|@oscharko-dev\/keiko-tools)"/s.test(
      text,
    );
  const callsDirect = /(?<![.\w])runCommand\s*\(/.test(text);
  // Namespace import — `import * as tools from "@oscharko-dev/keiko-tools"` then
  // `tools.runCommand(...)`. The import statement itself proves the alias IS keiko-tools' real
  // runCommand, so — unlike the generic port-call heuristic below — this shape needs no
  // RunCommandDeps/RunCommandInput corroboration. Without this branch a namespace-import caller
  // that never spells either type name as literal text (e.g. it forwards already-typed
  // parameters, or uses `Parameters<typeof tools.runCommand>`) is invisible to this scanner: it
  // matches neither the named-import shape above nor the RunCommand(Deps|Input)-gated port-call
  // shape below, and a runCommand call with no onTerminated seam on that path is never flagged —
  // exactly the false assurance this pin exists to prevent.
  const namespaceImport =
    /import\s*\*\s*as\s*(\w+)\s*from\s*"(?:\.\/exec\.js|@oscharko-dev\/keiko-tools)"/.exec(text);
  const callsNamespaced =
    namespaceImport !== null &&
    new RegExp(`(?<![.\\w])${namespaceImport[1]}\\s*\\.\\s*runCommand\\s*\\(`).test(text);
  const callsPort = /\.\s*runCommand\s*\(/.test(text) && /RunCommand(Deps|Input)/.test(text);
  return (importsExec && callsDirect) || callsNamespaced || callsPort;
}

describe("runCommand termination-evidence wiring (PR #3354, comment 3887021650)", () => {
  const callers = sourceFiles()
    .map((path) => ({ path, text: readFileSync(path, "utf8") }))
    .filter(({ path, text }) => isProductionCaller(path, text));

  it("finds the known production caller surface (the scanner itself is not vacuous)", () => {
    // The scanner must SEE the surface it polices. If a refactor moves these files, update the
    // list — never below the tool-host, the git lanes, and the verification orchestrator.
    const names = callers.map(({ path }) => path.split(/[\\/]/).at(-1)).sort();
    for (const required of [
      "registry.ts",
      "git-mutation-node.ts",
      "git-worktree-adapter.ts",
      "orchestrator.ts",
      "terminal.ts",
    ]) {
      expect(names).toContain(required);
    }
    expect(callers.length).toBeGreaterThanOrEqual(10);
  });

  it("every production runCommand caller references the onTerminated evidence seam", () => {
    const silent = callers
      .filter(({ text }) => !text.includes("onTerminated"))
      .map(({ path }) => path);
    expect(silent).toEqual([]);
  });
});
