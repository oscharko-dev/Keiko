import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import { URL } from "node:url";
import { join } from "node:path";
import { NATIVE_EFFECT_RULES } from "../../lib/code-quality-policy.mjs";

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
  configureEnforcingPolicyFixture(root);
  writeFileSync(join(root, ".gitignore"), "**/dist/\n");
  return root;
}

export function fixtureOwnedPolicy(records = [], owners = ["alpha"]) {
  const { upstream, runner, rules } = JSON.parse(
    readFileSync(new URL("../../code-quality-policy.json", import.meta.url)),
  );
  // The base fixture owns alpha, not every migrated production package. Keep package activations
  // only for declared fixture owners; global production and native-host guards remain intact.
  const fixtureRules = rules.map((source) => {
    const rule = historicalNativeFixtureRule(source);
    return {
      ...rule,
      activeScopes: rule.activeScopes.filter(
        (scope) => !scope.startsWith("package:") || owners.includes(scope.slice("package:".length)),
      ),
    };
  });
  return { version: 2, upstream, runner, rules: fixtureRules, responsibilities: records };
}

function historicalNativeFixtureRule(rule) {
  if (!NATIVE_EFFECT_RULES.includes(rule.id) || !Object.hasOwn(rule, "retiredScopes")) return rule;
  if (
    rule.disposition !== "Effect-host-only" ||
    rule.activeScopes.length !== 0 ||
    !Array.isArray(rule.retiredScopes) ||
    rule.retiredScopes.length !== 1 ||
    rule.retiredScopes[0] !== "native-host"
  )
    throw new TypeError("invalid-historical-native-rule");
  const { retiredScopes, ...active } = rule;
  return { ...active, activeScopes: [...retiredScopes] };
}

export function configureEnforcingPolicyFixture(root) {
  const owners = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")).name,
    );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts/code-quality-policy.json"),
    JSON.stringify(fixtureOwnedPolicy([], owners)),
  );
  copyNativePolicyFixtureSources(root);
}

// Historical analyzer input only; the retired product owner is not restored in this checkout.
export function copyNativePolicyFixtureSources(root) {
  const owner = "native/opencode-service-host";
  mkdirSync(join(root, owner), { recursive: true });
  for (const name of ["host.mjs", "entry.mjs", "guard-seams.mjs"])
    writeFileSync(
      join(root, owner, name),
      readFileSync(
        new URL(`../fixtures/code-quality-retired-native-host/${name}.txt`, import.meta.url),
      ),
    );
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
