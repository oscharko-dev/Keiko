import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bindApprovedScript,
  BOUND_SCRIPT_REFUSAL_TEXT,
  BOUND_SCRIPT_WRAPPER,
  type BoundScript,
} from "./boundScript.js";
import { scriptTableDigest } from "./detect.js";
import { makeWorkspace } from "./_support.js";
import { DEFAULT_VERIFICATION_LIMITS, type VerificationStep } from "./types.js";

// The wrapper is real POSIX shell; Windows keeps running the package manager (orchestrator.ts).
const posix = process.platform === "win32" ? describe.skip : describe;

type Scripts = Record<string, string>;
type Ws = ReturnType<typeof makeWorkspace>;

function stepOf(over: Partial<VerificationStep> = {}): VerificationStep {
  return {
    kind: "test",
    scriptName: "test",
    command: "npm",
    args: ["test"],
    limits: DEFAULT_VERIFICATION_LIMITS,
    ...over,
  };
}

function writeManifest(
  ws: Ws,
  scripts: Scripts,
  extra: Record<string, unknown> = {},
  dir = "",
): void {
  const manifest = { name: "demo", version: "1.2.3", scripts, ...extra };
  ws.writeFile(join(dir, "package.json"), JSON.stringify(manifest));
}

function bind(ws: Ws, scripts: Scripts, over: Partial<VerificationStep> = {}): BoundScript {
  return bindApprovedScript({
    step: stepOf(over),
    workspace: ws.info,
    approvedDigest: scriptTableDigest(scripts),
    nodeExecPath: process.execPath,
  });
}

function run(ws: Ws, bound: BoundScript): { status: number | null; stdout: string } {
  if (bound.kind !== "bound") throw new TypeError(`expected a bound script, got ${bound.kind}`);
  const result = spawnSync("sh", [...bound.args], {
    cwd: ws.root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...bound.env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

posix("bindApprovedScript — the approved bytes are the bytes that run", () => {
  it("runs pre, the script and post, in npm's order, with exactly the approved bytes", () => {
    const scripts = {
      pretest: "echo pre",
      test: "printf '%s|' \"a b\" 'c$d'; echo main",
      posttest: "echo post",
    };
    const ws = makeWorkspace({ scripts });
    expect(run(ws, bind(ws, scripts))).toEqual({ status: 0, stdout: "pre\na b|c$d|main\npost\n" });
  });

  it("runs only the approved bytes when package.json is edited after the bytes were read", () => {
    const scripts = { test: "echo approved" };
    const ws = makeWorkspace({ scripts });
    const bound = bind(ws, scripts);
    // The edit lands after the read, before the shell starts: the shell never reads the file.
    writeManifest(ws, { test: "echo stolen", posttest: "echo stolen" });
    expect(run(ws, bound)).toEqual({ status: 0, stdout: "approved\n" });
  });

  it("propagates the exit code of the failing phase and stops there", () => {
    const scripts = { pretest: "echo pre; exit 3", test: "echo main", posttest: "echo post" };
    const ws = makeWorkspace({ scripts });
    expect(run(ws, bind(ws, scripts))).toEqual({ status: 3, stdout: "pre\n" });
    const failing = { test: "exit 7", posttest: "echo post" };
    const other = makeWorkspace({ scripts: failing });
    expect(run(other, bind(other, failing))).toEqual({ status: 7, stdout: "" });
  });

  it("finds tools in node_modules/.bin of the package and of every ancestor, and sets npm's env", () => {
    const scripts = {
      test: 'fake-root-tool; fake-pkg-tool; echo "$npm_lifecycle_event $npm_package_name@$npm_package_version"; pwd; echo "$INIT_CWD"; echo "$npm_package_json"; echo "$npm_lifecycle_script"',
    };
    const ws = makeWorkspace();
    writeManifest(ws, {});
    writeManifest(ws, scripts, {}, "pkgs/a");
    for (const [dir, tool] of [
      ["node_modules/.bin", "fake-root-tool"],
      ["pkgs/a/node_modules/.bin", "fake-pkg-tool"],
    ] as const) {
      mkdirSync(join(ws.root, dir), { recursive: true });
      const file = join(ws.root, dir, tool);
      writeFileSync(file, `#!/bin/sh\necho ${tool}\n`);
      chmodSync(file, 0o755);
    }
    const bound = bind(ws, scripts, { cwd: "pkgs/a" });
    const { status, stdout } = run(ws, bound);
    const lines = stdout.trim().split("\n");
    expect(status).toBe(0);
    expect(lines.slice(0, 3)).toEqual(["fake-root-tool", "fake-pkg-tool", "test demo@1.2.3"]);
    expect(lines[3]?.endsWith("/pkgs/a")).toBe(true);
    expect(lines[4]).toBe(lines[3]?.slice(0, -"/pkgs/a".length));
    expect(lines[5]).toBe(`${lines[3] ?? ""}/package.json`);
    expect(lines[6]).toBe(scripts.test);
  });

  it("passes the argument vector the wrapper owns, never one built from the manifest", () => {
    const scripts = { test: "echo $1" };
    const ws = makeWorkspace({ scripts });
    const bound = bind(ws, scripts);
    expect(bound.kind === "bound" && bound.args.slice(0, 3)).toEqual([
      "-c",
      BOUND_SCRIPT_WRAPPER,
      "keiko-script",
    ]);
  });

  it("reports a manifest that no longer matches the approval", () => {
    const scripts = { test: "echo approved" };
    const ws = makeWorkspace({ scripts });
    writeManifest(ws, { test: "echo stolen" });
    expect(bind(ws, scripts)).toEqual({ kind: "changed" });
    expect(bind(ws, { ...scripts, pretest: "echo x" })).toEqual({ kind: "changed" });
  });
});

posix("bindApprovedScript — refusals", () => {
  const scripts = { test: "echo hi" };

  it.each([
    [".npmrc", "script-shell=/bin/zsh\n", "script-shell-configured"],
    [".npmrc", "ignore-scripts = maybe\n", "ignore-scripts-configured"],
    [".npmrc", "script_shell=/bin/zsh\n", "script-shell-configured"],
    [".npmrc", "enable-pre-post-scripts=false\n", "package-manager-configuration"],
  ])("refuses a project %s that sets %s", (file, text, reason) => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(file, text);
    expect(bind(ws, scripts)).toEqual({ kind: "refused", reason });
  });

  it("refuses a nested package whose own .npmrc sets script-shell", () => {
    const ws = makeWorkspace();
    writeManifest(ws, scripts, {}, "pkgs/a");
    ws.writeFile("pkgs/a/.npmrc", "script-shell=/bin/zsh\n");
    expect(bind(ws, scripts, { cwd: "pkgs/a" })).toEqual({
      kind: "refused",
      reason: "script-shell-configured",
    });
  });

  it.each([
    [{ "script-shell": "/bin/zsh" }, "script-shell-configured"],
    [{ "ignore-scripts": "sometimes" }, "ignore-scripts-configured"],
    [{ nested: { a: 1 } }, "package-config-unsupported"],
  ])("refuses a package.json config %j", (config, reason) => {
    const ws = makeWorkspace();
    writeManifest(ws, scripts, { config });
    expect(bind(ws, scripts)).toEqual({ kind: "refused", reason });
  });

  it("exports primitive package.json config the way npm does", () => {
    const ws = makeWorkspace();
    writeManifest(ws, scripts, { config: { port: 8080 } });
    const bound = bind(ws, scripts);
    expect(bound.kind === "bound" && bound.env.npm_package_config_port).toBe("8080");
  });

  it("refuses yarn and pnpm scripts that have a lifecycle pair, whose order the version decides", () => {
    const withPre = { test: "echo hi", pretest: "echo pre" };
    const ws = makeWorkspace({ scripts: withPre });
    for (const command of ["yarn", "pnpm"]) {
      expect(bind(ws, withPre, { command, args: ["run", "test"] })).toEqual({
        kind: "refused",
        reason: "lifecycle-order-unknown",
      });
    }
    const plain = makeWorkspace({ scripts });
    expect(bind(plain, scripts, { command: "pnpm", args: ["run", "test"] }).kind).toBe("bound");
  });
});

posix(
  "bindApprovedScript — ignore-scripts keeps the named script and skips its pre and post",
  () => {
    const scripts = { pretest: "echo pre", test: "echo main", posttest: "echo post" };

    it.each([
      ["an .npmrc", ".npmrc", "; comment\nignore-scripts = true\n"],
      ["a bare .npmrc key", ".npmrc", "ignore-scripts\n"],
    ])("runs the script alone under %s", (_name, file, text) => {
      const ws = makeWorkspace({ scripts });
      ws.writeFile(file, text);
      expect(run(ws, bind(ws, scripts))).toEqual({ status: 0, stdout: "main\n" });
    });

    it("runs the script alone under package.json config, and a later false restores the pair", () => {
      const ws = makeWorkspace();
      writeManifest(ws, scripts, { config: { "ignore-scripts": true } });
      expect(run(ws, bind(ws, scripts))).toEqual({ status: 0, stdout: "main\n" });
      ws.writeFile(".npmrc", "ignore-scripts=true\n");
      writeManifest(ws, scripts, { config: { "ignore-scripts": "false" } });
      expect(run(ws, bind(ws, scripts)).stdout).toBe("pre\nmain\npost\n");
    });

    it("lets the package folder's .npmrc override the workspace's", () => {
      const ws = makeWorkspace();
      writeManifest(ws, {});
      writeManifest(ws, scripts, {}, "pkgs/a");
      ws.writeFile(".npmrc", "ignore-scripts=true\n");
      ws.writeFile("pkgs/a/.npmrc", "ignore-scripts=false\n");
      expect(run(ws, bind(ws, scripts, { cwd: "pkgs/a" })).stdout).toBe("pre\nmain\npost\n");
    });

    it("still refuses yarn and pnpm, whose handling is not verified here", () => {
      const ws = makeWorkspace({ scripts });
      ws.writeFile(".npmrc", "ignore-scripts=true\n");
      for (const command of ["yarn", "pnpm"]) {
        expect(bind(ws, scripts, { command, args: ["run", "test"] })).toEqual({
          kind: "refused",
          reason: "ignore-scripts-configured",
        });
      }
    });
  },
);

posix("bindApprovedScript — package manager fidelity", () => {
  const scripts = { test: "echo hi" };
  const yarn = { command: "yarn", args: ["run", "test"] };

  it.each([
    [".yarnrc.yml", "scriptShell: /bin/zsh\n", "script-shell-configured"],
    [".yarnrc.yml", "enableScripts: false\n", "package-manager-configuration"],
    [".yarnrc.yml", "nodeLinker: pnp\n", "yarn-pnp-unsupported"],
    [".yarnrc", "script-shell /bin/zsh\n", "script-shell-configured"],
    [".yarnrc", "ignore-scripts true\n", "ignore-scripts-configured"],
    [".pnp.cjs", "// pnp\n", "yarn-pnp-unsupported"],
    [".pnp.loader.mjs", "// pnp\n", "yarn-pnp-unsupported"],
  ])("refuses a yarn project with %s holding %j", (file, text, reason) => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(file, text);
    expect(bind(ws, scripts, yarn)).toEqual({ kind: "refused", reason });
  });

  it("refuses a Plug'n'Play project whichever manager runs it", () => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(".pnp.cjs", "// pnp\n");
    expect(bind(ws, scripts)).toEqual({ kind: "refused", reason: "yarn-pnp-unsupported" });
  });

  it("accepts a yarn project that links node_modules", () => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(".yarnrc.yml", "nodeLinker: node-modules\n");
    expect(bind(ws, scripts, yarn).kind).toBe("bound");
  });

  it("ignores keys inside an ini [section], which npm does not read as top-level configuration", () => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(".npmrc", "registry=https://example.invalid/\n[scoped]\nscript-shell=/bin/zsh\n");
    expect(bind(ws, scripts).kind).toBe("bound");
  });

  it("reads only the package folder's .npmrc for npm, as npm does with that folder as prefix", () => {
    const ws = makeWorkspace();
    writeManifest(ws, {});
    writeManifest(ws, scripts, {}, "pkgs/a");
    ws.writeFile(".npmrc", "script-shell=/bin/zsh\n");
    expect(bind(ws, scripts, { cwd: "pkgs/a" }).kind).toBe("bound");
  });
});

posix("bindApprovedScript — what can be started", () => {
  it.each([
    ["a NUL character", { test: "echo a\u0000b" }],
    ["a script beyond the argument bound", { test: "x".repeat(70_000) }],
  ])("refuses %s before any spawn", (_name, scripts) => {
    const ws = makeWorkspace({ scripts });
    expect(bind(ws, scripts)).toEqual({ kind: "refused", reason: "script-not-runnable" });
  });

  it("sets NODE as npm does, and no user agent that would need the user's config", () => {
    const scripts = { test: "echo hi" };
    const ws = makeWorkspace({ scripts });
    const bound = bind(ws, scripts);
    expect(bound.kind === "bound" && bound.env.NODE).toBe(process.execPath);
    expect(bound.kind === "bound" && "npm_config_user_agent" in bound.env).toBe(false);
  });

  it("gives every refusal a plain sentence with a next step", () => {
    for (const sentence of Object.values(BOUND_SCRIPT_REFUSAL_TEXT)) {
      expect(sentence).toMatch(/^[A-Z].*[.]$/u);
      expect(sentence).toMatch(/run the check|start the check|shorten|remove|use plain|set it/u);
    }
  });
});

posix("bindApprovedScript — node-linker is read per package manager", () => {
  const scripts = { test: "echo hi" };
  const pnpm = { command: "pnpm", args: ["run", "test"] };
  const yarn = { command: "yarn", args: ["run", "test"] };

  it.each(["hoisted", "isolated"])(
    "accepts pnpm `.npmrc` node-linker=%s and runs it bound",
    (linker) => {
      const ws = makeWorkspace({ scripts });
      ws.writeFile(".npmrc", `node-linker=${linker}\n`);
      expect(run(ws, bind(ws, scripts, pnpm))).toEqual({ status: 0, stdout: "hi\n" });
    },
  );

  it.each([
    ["pnpm", pnpm, "node-linker=pnp\n", ".npmrc", "yarn-pnp-unsupported"],
    ["pnpm", pnpm, "node-linker=whatever\n", ".npmrc", "package-manager-configuration"],
    ["yarn", yarn, "nodeLinker: pnp\n", ".yarnrc.yml", "yarn-pnp-unsupported"],
    ["yarn", yarn, "nodeLinker: pnpm\n", ".yarnrc.yml", "package-manager-configuration"],
  ])("refuses a %s project with %j in %s", (_name, step, text, file, reason) => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(file, text);
    expect(bind(ws, scripts, step)).toEqual({ kind: "refused", reason });
  });

  it("accepts yarn nodeLinker: node-modules and lets npm ignore the key", () => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(".yarnrc.yml", "nodeLinker: node-modules\n");
    expect(bind(ws, scripts, yarn).kind).toBe("bound");
    const other = makeWorkspace({ scripts });
    other.writeFile(".npmrc", "node-linker=pnp\n");
    expect(bind(other, scripts).kind).toBe("bound");
  });

  it("refuses a package.json config key that cannot be an environment name", () => {
    const ws = makeWorkspace();
    writeManifest(ws, scripts, { config: { "a=b": "x" } });
    expect(bind(ws, scripts)).toEqual({ kind: "refused", reason: "package-config-unsupported" });
  });
});

posix("bindApprovedScript — the manager version settles the lifecycle scripts", () => {
  const scripts = { pretest: "echo pre", test: "echo main", posttest: "echo post" };
  const withManager = (packageManager: string | undefined, dir?: string): Ws => {
    const ws = makeWorkspace();
    writeManifest(
      ws,
      dir === undefined ? scripts : {},
      packageManager === undefined ? {} : { packageManager },
    );
    if (dir !== undefined) writeManifest(ws, scripts, {}, dir);
    return ws;
  };
  const step = (command: string, cwd?: string): Partial<VerificationStep> => ({
    command,
    args: ["run", "test"],
    ...(cwd === undefined ? {} : { cwd }),
  });

  it.each([
    ["pnpm@8.6.0", "pnpm", "pre\nmain\npost\n"],
    ["pnpm@10.2.0", "pnpm", "pre\nmain\npost\n"],
    ["yarn@4.1.0", "yarn", "main\n"],
    ["yarn@2.4.3", "yarn", "main\n"],
    ["yarn@1.22.19", "yarn", "pre\nmain\npost\n"],
  ])("with %s, runs %s bound and in that manager's order", (version, command, output) => {
    const ws = withManager(version);
    expect(run(ws, bind(ws, scripts, step(command)))).toEqual({ status: 0, stdout: output });
  });

  it.each([
    [undefined, "pnpm"],
    ["pnpm@6.35.1", "pnpm"],
    ["pnpm@7.33.0", "pnpm"],
    [undefined, "yarn"],
    ["npm@10.0.0", "yarn"],
    ["pnpm@8.6.0", "yarn"],
  ])("refuses a script with a lifecycle pair when the version is %s for %s", (version, command) => {
    const ws = withManager(version);
    expect(bind(ws, scripts, step(command))).toEqual({
      kind: "refused",
      reason: "lifecycle-order-unknown",
    });
  });

  it("reads the version from the workspace root for a nested package", () => {
    const ws = withManager("pnpm@9.1.0", "pkgs/a");
    expect(run(ws, bind(ws, scripts, step("pnpm", "pkgs/a"))).stdout).toBe("pre\nmain\npost\n");
    const berry = withManager("yarn@4.1.0", "pkgs/a");
    expect(run(berry, bind(berry, scripts, step("yarn", "pkgs/a"))).stdout).toBe("main\n");
  });
});

posix("bindApprovedScript — host paths and nested YAML", () => {
  const scripts = { test: "echo hi" };

  it("hands the step the host's Node.js and package manager paths only when it runs on the host", () => {
    const ws = makeWorkspace({ scripts });
    const container = bindApprovedScript({
      step: stepOf(),
      workspace: ws.info,
      approvedDigest: scriptTableDigest(scripts),
    });
    expect(container.kind === "bound" && Object.keys(container.env)).not.toContain("NODE");
    expect(container.kind === "bound" && Object.keys(container.env)).not.toContain(
      "npm_node_execpath",
    );
    const host = bind(ws, scripts);
    expect(host.kind === "bound" && host.env.npm_node_execpath).toBe(process.execPath);
  });

  it("ignores a nested enableScripts key of a yarnrc.yml, which is not a top-level setting", () => {
    const ws = makeWorkspace({ scripts });
    ws.writeFile(".yarnrc.yml", "plugins:\n  - path: x\n    enableScripts: false\n");
    expect(bind(ws, scripts, { command: "yarn", args: ["run", "test"] }).kind).toBe("bound");
    ws.writeFile(".yarnrc.yml", "enableScripts: false\n");
    expect(bind(ws, scripts, { command: "yarn", args: ["run", "test"] })).toEqual({
      kind: "refused",
      reason: "package-manager-configuration",
    });
  });
});

posix("bindApprovedScript — pnpm's enablePrePostScripts (documented default: true)", () => {
  const scripts = { pretest: "echo pre", test: "echo main", posttest: "echo post" };
  const pnpm = { command: "pnpm", args: ["run", "test"] };
  const full = "pre\nmain\npost\n";
  const refused = { kind: "refused", reason: "lifecycle-order-unknown" };

  function pnpmWorkspace(
    packageManager: string | undefined,
    extra: Record<string, unknown> = {},
  ): Ws {
    const ws = makeWorkspace();
    writeManifest(ws, scripts, {
      ...(packageManager === undefined ? {} : { packageManager }),
      ...extra,
    });
    return ws;
  }

  it("runs pre, main and post by default for pnpm 8 and later", () => {
    const ws = pnpmWorkspace("pnpm@10.2.0");
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe(full);
  });

  it.each([
    ["pnpm-workspace.yaml", "enablePrePostScripts: false\n"],
    [".npmrc", "enable-pre-post-scripts=false\n"],
  ])("runs main only when %s sets it to false", (file, text) => {
    const ws = pnpmWorkspace("pnpm@10.2.0");
    ws.writeFile(file, text);
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe("main\n");
  });

  it("runs main only when package.json#pnpm sets it to false, also without a version", () => {
    const ws = pnpmWorkspace(undefined, { pnpm: { enablePrePostScripts: false } });
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe("main\n");
  });

  it.each([
    ["pnpm-workspace.yaml", "packages:\n  - pkgs/*\nenablePrePostScripts: true\n"],
    [".npmrc", "enable-pre-post-scripts=true\n"],
  ])("runs the pair, bound and in npm order, when %s sets it to true", (file, text) => {
    const ws = pnpmWorkspace("pnpm@7.33.0");
    ws.writeFile(file, text);
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe(full);
  });

  it("runs the pair when package.json#pnpm sets it to true, whatever the version", () => {
    const ws = pnpmWorkspace(undefined, { pnpm: { enablePrePostScripts: true } });
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe(full);
  });

  it.each(["pnpm@7.33.0", undefined, "pnpm@6.35.1", "npm@10.0.0"])(
    "refuses a script with a pair when nothing is set and the version is %s",
    (version) => {
      const ws = pnpmWorkspace(version);
      expect(bind(ws, scripts, pnpm)).toEqual(refused);
    },
  );

  it("runs a script without a pre or post whatever the version, since nothing can differ", () => {
    const plain = { test: "echo main" };
    const ws = makeWorkspace();
    writeManifest(ws, plain);
    expect(run(ws, bind(ws, plain, pnpm)).stdout).toBe("main\n");
  });

  it("ignores a nested enablePrePostScripts, which is not a top-level setting", () => {
    const ws = pnpmWorkspace("pnpm@10.2.0");
    ws.writeFile("pnpm-workspace.yaml", "catalog:\n  enablePrePostScripts: false\n");
    expect(run(ws, bind(ws, scripts, pnpm)).stdout).toBe(full);
  });

  it("refuses a value of the setting that is not a boolean", () => {
    const ws = pnpmWorkspace("pnpm@10.2.0", { pnpm: { enablePrePostScripts: "sometimes" } });
    expect(bind(ws, scripts, pnpm)).toEqual({
      kind: "refused",
      reason: "package-manager-configuration",
    });
  });

  it("reads the root manifest once for a nested package: its packageManager and its pnpm key", () => {
    const ws = makeWorkspace();
    writeManifest(ws, {}, { packageManager: "pnpm@10.2.0", pnpm: { enablePrePostScripts: false } });
    writeManifest(ws, scripts, {}, "pkgs/a");
    expect(run(ws, bind(ws, scripts, { ...pnpm, cwd: "pkgs/a" })).stdout).toBe("main\n");
  });
});
