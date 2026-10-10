import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { URL } from "node:url";
import { join } from "node:path";

export function createPolicyFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "keiko-policy-inventory-"));
  mkdirSync(join(root, "packages/alpha/src"), { recursive: true });
  for (const [path, value] of Object.entries({
    "package.json": { name: "fixture", workspaces: ["packages/*"] },
    "package-lock.json": { lockfileVersion: 3 },
    "tsconfig.json": { include: ["packages/alpha/src/**/*.ts"] },
    "tsconfig.build.json": { include: ["packages/alpha/src/index.ts"] },
    "packages/alpha/package.json": { name: "alpha", exports: "./dist/index.js" },
    "packages/alpha/tsconfig.json": {
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    },
  }))
    writeFileSync(join(root, path), JSON.stringify(value));
  writeFileSync(join(root, "packages/alpha/src/index.ts"), "export const value = 1;");
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "--initial-branch=fixture"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Create hermetic policy inventory",
  ]);
  return root;
}

export function createRuntimePolicyFixture(helper, linkage = "runtime") {
  const root = createPolicyFixtureRepository();
  configureRuntimeFixture(root);
  writeFileSync(
    join(root, "packages/alpha/package.json"),
    JSON.stringify({
      name: "alpha",
      version: "0.0.0",
      type: "module",
      files: ["dist"],
      exports: linkage === "public" ? "./dist/testing/logic.js" : "./dist/index.js",
    }),
  );
  mkdirSync(join(root, "packages/alpha/src", helper, ".."), { recursive: true });
  writeFileSync(
    join(root, "packages/alpha/src", helper),
    "export interface Marker { value: number }\nexport function maximum(): number { return Reflect.apply(Math.max, null, [1, 2]); }\n",
  );
  const target = `./${helper.replace(/\.ts$/u, ".js")}`;
  const entry = runtimeFixtureEntry(linkage, target);
  writeFileSync(join(root, "packages/alpha/src/index.ts"), entry);
  if (linkage === "transitive")
    writeFileSync(
      join(root, "packages/alpha/src/relay.ts"),
      `export { maximum } from "${target}";`,
    );
  emitRuntimeFixture(root);
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts/code-quality-policy.json"),
    readFileSync(new URL("../../code-quality-policy.json", import.meta.url)),
  );
  writeFileSync(join(root, ".gitignore"), "**/dist/\n");
  return root;
}

function emitRuntimeFixture(root) {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, "packages/alpha/tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic() {
        throw new TypeError("invalid-runtime-fixture");
      },
    },
  );
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const emitted = program.emit();
  if (diagnostics.length > 0 || emitted.emitSkipped || emitted.diagnostics.length > 0) {
    throw new TypeError("runtime-fixture-build-failed");
  }
  rmSync(join(root, "packages/alpha/dist/.tsbuildinfo"), { force: true });
}

function configureRuntimeFixture(root) {
  const config = JSON.parse(readFileSync(new URL("../../../tsconfig.base.json", import.meta.url)));
  Object.assign(config.compilerOptions, {
    composite: true,
    declaration: true,
    rootDir: "src",
    outDir: "dist",
    tsBuildInfoFile: "dist/.tsbuildinfo",
    types: [],
  });
  config.include = ["src"];
  config.exclude = ["dist", "**/*.test.ts"];
  writeFileSync(join(root, "packages/alpha/tsconfig.json"), JSON.stringify(config));
}

function runtimeFixtureEntry(linkage, target) {
  if (linkage === "runtime") return `export { maximum } from "${target}";`;
  if (linkage === "late-alias" || linkage === "wrapped-alias") {
    const value =
      linkage === "wrapped-alias" ? `(("${target}" as const) satisfies string)!` : `"${target}"`;
    return `export async function maximum(): Promise<number> { const alias = (helperPath); const module = await import((alias)); return module.maximum(); } const helperPath = ${value};`;
  }
  if (linkage === "transitive") return 'export { maximum } from "./relay.js";';
  if (linkage === "type")
    return `import type { Marker } from "${target}"; export const value: Marker = { value: 1 };`;
  if (linkage === "named-type")
    return `import { type Marker } from "${target}"; export const value: Marker = { value: 1 };`;
  if (linkage === "named-type-export")
    return `export { type Marker } from "${target}"; export const value = 1;`;
  return "export const value = 1;";
}
