import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateDebugLaunchPolicy, type DebugLaunchPolicy } from "./debug-launch-policy.js";

const policy: DebugLaunchPolicy = {
  nodeExecutable: "/opt/runtime/node",
  npmExecutable: "/opt/runtime/npm",
  shellExecutable: "/opt/runtime/sh",
  npmUserConfig: "/opt/provisioning/npm-user-config",
  npmGlobalConfig: "/opt/provisioning/npm-global-config",
  cwd: "/keiko-execution-root",
  env: { HOME: "/tmp/home", PATH: "/opt/runtime" },
  layer1Allowed: () => true,
};
const catalogArgs = [
  "--ignore-scripts",
  `--script-shell=${policy.shellExecutable}`,
  `--userconfig=${policy.npmUserConfig}`,
  `--globalconfig=${policy.npmGlobalConfig}`,
  "--location=global",
  "run",
  "start",
];

describe("debug launch Layer-2 policy", () => {
  it("executes the selected script with distinct empty configs and the approved shell", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-debug-npm-policy-"));
    try {
      const home = join(root, "home");
      const markers = join(root, "markers");
      const userConfig = join(root, "npm-user-config");
      const globalConfig = join(root, "npm-global-config");
      const hostileGlobalConfig = join(root, "hostile-global-config");
      const hostileRuntime = join(root, "hostile-runtime.cjs");
      const approvedShell = join(root, "approved-shell");
      mkdirSync(home);
      mkdirSync(markers);
      writeFileSync(userConfig, "");
      writeFileSync(globalConfig, "");
      writeFileSync(
        hostileRuntime,
        `require("node:fs").writeFileSync("${join(markers, "runtime")}", "x");`,
      );
      const hostileConfig = `script-shell=/definitely-missing\nnode-options=--require=${hostileRuntime}\n`;
      writeFileSync(hostileGlobalConfig, hostileConfig);
      writeFileSync(join(home, ".npmrc"), hostileConfig);
      writeFileSync(
        approvedShell,
        `#!/bin/sh\nprintf approved > "${join(markers, "shell")}"\nexec /bin/sh "$@"\n`,
      );
      chmodSync(approvedShell, 0o755);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            preprobe: `node -e "require('node:fs').writeFileSync('${join(markers, "pre")}', 'x')"`,
            probe: `node -e "require('node:fs').writeFileSync('${join(markers, "main")}', 'x')"`,
            postprobe: `node -e "require('node:fs').writeFileSync('${join(markers, "post")}', 'x')"`,
          },
        }),
      );
      writeFileSync(join(root, ".npmrc"), hostileConfig);
      const npmVersion = spawnSync("npm", ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(npmVersion.status).toBe(0);
      expect(npmVersion.stdout.trim()).toBe("11.16.0");
      const result = spawnSync(
        "npm",
        [
          "--ignore-scripts",
          `--script-shell=${approvedShell}`,
          `--userconfig=${userConfig}`,
          `--globalconfig=${globalConfig}`,
          "--location=global",
          "run",
          "probe",
        ],
        {
          cwd: root,
          env: {
            HOME: home,
            PATH: process.env.PATH ?? "",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(markers, "main"))).toBe(true);
      expect(existsSync(join(markers, "shell"))).toBe(true);
      expect(existsSync(join(markers, "pre"))).toBe(false);
      expect(existsSync(join(markers, "post"))).toBe(false);
      expect(existsSync(join(markers, "runtime"))).toBe(false);
      expect(result.stderr).not.toContain("definitely-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a closed file projection after Layer-1 approval", () => {
    expect(
      validateDebugLaunchPolicy(
        {
          kind: "file",
          executable: policy.nodeExecutable,
          args: ["/keiko-execution-root/app.js"],
          target: "/keiko-execution-root/app.js",
          cwd: policy.cwd,
          env: policy.env,
        },
        policy,
      ),
    ).toEqual({ allowed: true });
  });

  it("accepts the same exact environment independent of insertion order", () => {
    const env = { PATH: "/opt/runtime", HOME: "/tmp/home" };
    expect(
      validateDebugLaunchPolicy(
        {
          kind: "file",
          executable: policy.nodeExecutable,
          args: ["/keiko-execution-root/app.js"],
          target: "/keiko-execution-root/app.js",
          cwd: policy.cwd,
          env,
        },
        policy,
      ),
    ).toEqual({ allowed: true });
  });

  it("accepts only the fixed npm tuple", () => {
    expect(
      validateDebugLaunchPolicy(
        {
          kind: "catalog",
          executable: policy.npmExecutable,
          args: catalogArgs,
          scriptName: "start",
          shell: policy.shellExecutable,
          cwd: policy.cwd,
          env: policy.env,
        },
        policy,
      ),
    ).toEqual({ allowed: true });
  });

  it.each(["0", "9", "A", "Z", "a", "z", "build", "test:unit", "lint.fix", "build_ui-2"])(
    "accepts the closed script name %s",
    (scriptName) => {
      const args = [...catalogArgs.slice(0, -1), scriptName];
      expect(
        validateDebugLaunchPolicy(
          {
            kind: "catalog",
            executable: policy.npmExecutable,
            args,
            scriptName,
            shell: policy.shellExecutable,
            cwd: policy.cwd,
            env: policy.env,
          },
          policy,
        ),
      ).toEqual({ allowed: true });
    },
  );

  it.each(["", "-build", ".build", ":build", "build!", "build script", "build\n", "búild"])(
    "rejects the unsafe script name %j",
    (scriptName) => {
      const args = [...catalogArgs.slice(0, -1), scriptName];
      expect(
        validateDebugLaunchPolicy(
          {
            kind: "catalog",
            executable: policy.npmExecutable,
            args,
            scriptName,
            shell: policy.shellExecutable,
            cwd: policy.cwd,
            env: policy.env,
          },
          policy,
        ).allowed,
      ).toBe(false);
    },
  );

  it.each([
    { executable: "/workspace/npm" },
    { shell: "/workspace/sh" },
    { scriptName: "-hostile" },
    { args: ["--ignore-scripts", `--script-shell=${policy.shellExecutable}`, "run", "other"] },
    { args: ["--ignore-scripts", `--script-shell=${policy.shellExecutable}`, "run"] },
    { args: ["--ignore-scripts", "--script-shell=/workspace/sh", "run", "start"] },
    {
      args: ["--ignore-scripts=false", `--script-shell=${policy.shellExecutable}`, "run", "start"],
    },
    { args: catalogArgs.slice(0, -1) },
    { args: ["--ignore-scripts", "wrong", "wrong", "wrong", "wrong", "wrong", "wrong"] },
  ])("rejects catalog structural drift %#", (drift) => {
    const execution = {
      kind: "catalog" as const,
      executable: policy.npmExecutable,
      args: catalogArgs,
      scriptName: "start",
      shell: policy.shellExecutable,
      cwd: policy.cwd,
      env: policy.env,
      ...drift,
    };
    expect(validateDebugLaunchPolicy(execution, policy)).toEqual({
      allowed: false,
      reason: "STRUCTURE_DRIFT",
    });
  });

  it.each([
    { env: { HOME: "/tmp/home" } },
    { env: { ...policy.env, EXTRA: "x" } },
    { env: { HOME: "/tmp/home", PATH: "/different" } },
    { args: ["/keiko-execution-root/other.js"] },
  ])("rejects same-shape file env or argument drift %#", (drift) => {
    const execution = {
      kind: "file" as const,
      executable: policy.nodeExecutable,
      args: ["/keiko-execution-root/app.js"],
      target: "/keiko-execution-root/app.js",
      cwd: policy.cwd,
      env: policy.env,
      ...drift,
    };
    expect(validateDebugLaunchPolicy(execution, policy)).toEqual({
      allowed: false,
      reason: "STRUCTURE_DRIFT",
    });
  });

  it.each([
    { args: ["--require", "evil", "/keiko-execution-root/app.js"] },
    { executable: "/workspace/node" },
    { cwd: "/workspace/other" },
    { env: { PATH: "/workspace/bin" } },
  ])("rejects file execution drift", (drift) => {
    expect(
      validateDebugLaunchPolicy(
        {
          kind: "file",
          executable: policy.nodeExecutable,
          args: ["/keiko-execution-root/app.js"],
          target: "/keiko-execution-root/app.js",
          cwd: policy.cwd,
          env: policy.env,
          ...drift,
        },
        policy,
      ).allowed,
    ).toBe(false);
  });

  it("requires independent Layer-1 command approval", () => {
    const layer1Allowed = vi.fn(() => false);
    expect(
      validateDebugLaunchPolicy(
        {
          kind: "file",
          executable: policy.nodeExecutable,
          args: ["/keiko-execution-root/app.js"],
          target: "/keiko-execution-root/app.js",
          cwd: policy.cwd,
          env: policy.env,
        },
        { ...policy, layer1Allowed },
      ),
    ).toEqual({ allowed: false, reason: "LAYER1_DENIED" });
    expect(layer1Allowed).toHaveBeenCalledOnce();
  });

  it("runs every independent policy denial in one mutation-complete test", () => {
    const catalog = {
      kind: "catalog" as const,
      executable: policy.npmExecutable,
      args: catalogArgs,
      scriptName: "start",
      shell: policy.shellExecutable,
      cwd: policy.cwd,
      env: policy.env,
    };
    const invalidCatalog = [
      { ...catalog, executable: "/wrong" },
      { ...catalog, shell: "/wrong" },
      { ...catalog, scriptName: "-bad" },
      { ...catalog, scriptName: "bad!" },
      { ...catalog, args: [...catalog.args, "extra"] },
      { ...catalog, args: ["--ignore-scripts", "--script-shell=/wrong", "run", "start"] },
      {
        ...catalog,
        args: catalog.args.map((value) =>
          value.startsWith("--userconfig=") ? "--userconfig=/wrong" : value,
        ),
      },
      {
        ...catalog,
        args: catalog.args.map((value) =>
          value.startsWith("--globalconfig=") ? "--globalconfig=/wrong" : value,
        ),
      },
      {
        ...catalog,
        args: ["--ignore-scripts", `--script-shell=${policy.shellExecutable}`, "run", "other"],
      },
    ];
    const file = {
      kind: "file" as const,
      executable: policy.nodeExecutable,
      args: ["/keiko-execution-root/app.js"],
      target: "/keiko-execution-root/app.js",
      cwd: policy.cwd,
      env: policy.env,
    };
    const invalidFile = [
      { ...file, executable: "/wrong" },
      { ...file, cwd: "/wrong" },
      { ...file, args: ["/keiko-execution-root/other.js"] },
      { ...file, env: { HOME: "/tmp/home" } },
      { ...file, env: { ...policy.env, EXTRA: "x" } },
    ];
    for (const execution of [...invalidCatalog, ...invalidFile]) {
      expect(validateDebugLaunchPolicy(execution, policy).allowed).toBe(false);
    }
  });
});
