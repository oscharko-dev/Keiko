import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  generatedTsconfigPath,
  planChangedTypeScriptPrograms,
  readTsconfigPaths,
  removeChangedTypeScriptPrograms,
  runCli,
  writeChangedTypeScriptPrograms,
} from "../local-sonar-typescript-programs.mjs";

// The local pre-push Sonar scan ran out of its 4608 MiB bridge heap whenever a changed file belonged
// to the root tsconfig: SonarJS built that whole ~6,400-file program to type one file. The runner now
// hands SonarJS programs rooted at the changed files with the owner's compiler options.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const properties = readFileSync(join(root, "sonar-project.properties"), "utf8");

function parse(configPath) {
  const absolute = join(root, configPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(absolute));
}

function repoRelative(files) {
  return files.map((file) => relative(root, file).replaceAll("\\", "/"));
}

describe("readTsconfigPaths", () => {
  it("reads the configured tsconfigs from sonar-project.properties", () => {
    expect(readTsconfigPaths(properties)).toEqual([
      "tsconfig.json",
      "packages/keiko-ui/tsconfig.json",
      "tests/e2e/servers/tsconfig.json",
    ]);
  });

  it("fails closed when the property is missing or empty", () => {
    expect(() => readTsconfigPaths("sonar.projectKey=x\n")).toThrow(TypeError);
    expect(() => readTsconfigPaths("sonar.typescript.tsconfigPaths= , \n")).toThrow(TypeError);
  });
});

describe("planChangedTypeScriptPrograms", () => {
  const owners = [
    { configPath: "tsconfig.json", rootDir: ".", fileNames: ["src/a.ts", "src/env.d.ts"] },
    {
      configPath: "packages/ui/tsconfig.json",
      rootDir: "packages/ui",
      fileNames: ["packages/ui/src/b.tsx", "packages/ui/types.d.ts", "src/a.ts"],
    },
  ];

  it("roots one program per owner at its changed files and keeps its ambient declarations", () => {
    const plans = planChangedTypeScriptPrograms({
      changedPaths: ["src/a.ts", "packages/ui/src/b.tsx", "docs/readme.md"],
      owners,
      checkoutId: "0123456789ab",
    });
    expect(plans).toEqual([
      {
        path: ".keiko/local-sonar-tsconfig-0123456789ab.json",
        config: {
          extends: "../tsconfig.json",
          compilerOptions: { rootDir: ".." },
          include: [],
          files: ["../src/a.ts", "../src/env.d.ts"],
        },
      },
      {
        path: "packages/ui/.keiko/local-sonar-tsconfig-0123456789ab.json",
        config: {
          extends: "../tsconfig.json",
          compilerOptions: { rootDir: ".." },
          include: [],
          files: ["../src/b.tsx", "../types.d.ts"],
        },
      },
    ]);
  });

  it("produces nothing when no changed file belongs to a program", () => {
    expect(
      planChangedTypeScriptPrograms({
        changedPaths: ["docs/readme.md", "scripts/x.mjs"],
        owners,
        checkoutId: "0123456789ab",
      }),
    ).toEqual([]);
  });

  it("rejects a checkout id that could leave the .keiko directory", () => {
    expect(() => generatedTsconfigPath("tsconfig.json", "../../etc")).toThrow(TypeError);
  });
});

describe("generated programs on this repository", () => {
  const checkoutId = "feedfacecafe";
  const changedFile = "tests/e2e/support/dev-server-env.ts";

  it("types a root-owned file without loading the root program", async () => {
    try {
      const paths = await writeChangedTypeScriptPrograms({
        repoRoot: root,
        changedPaths: [changedFile, "AGENTS.md"],
        checkoutId,
      });
      expect(paths).toEqual([generatedTsconfigPath("tsconfig.json", checkoutId)]);
      const generated = parse(paths[0]);
      const owner = parse("tsconfig.json");
      expect(repoRelative(generated.fileNames)).toContain(changedFile);
      expect(generated.fileNames.length).toBeLessThan(10);
      expect(owner.fileNames.length).toBeGreaterThan(1000);
      for (const option of ["strict", "exactOptionalPropertyTypes", "module", "jsx", "types"]) {
        expect(generated.options[option]).toEqual(owner.options[option]);
      }
      expect(generated.options.rootDir).toBe(root);
      const check = spawnSync("git", ["check-ignore", "-q", paths[0]], { cwd: root });
      expect(check.status).toBe(0);
    } finally {
      removeChangedTypeScriptPrograms({ repoRoot: root, checkoutId });
    }
    expect(existsSync(join(root, generatedTsconfigPath("tsconfig.json", checkoutId)))).toBe(false);
  });

  it("reports an invalid inventory instead of guessing", async () => {
    const errors = [];
    const code = await runCli({
      argv: ["--write", checkoutId],
      repoRoot: root,
      stdin: () => '{"not":"an array"}',
      stdout: () => undefined,
      stderr: (text) => errors.push(text),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/JSON array of strings/u);
  });

  it("is wired into the local runner for the changed-file scope", () => {
    const runner = readFileSync(join(root, "docker/gates/run-sonar.sh"), "utf8");
    expect(runner).toContain('local-sonar-typescript-programs.mjs" --write "${checkout_id}"');
    expect(runner).toContain('--remove "${checkout_id}"');
    expect(runner).toContain('"-Dsonar.typescript.tsconfigPaths=${changed_tsconfigs}"');
  });
});
