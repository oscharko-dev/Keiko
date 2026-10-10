import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { createPolicyFixtureRepository } from "./code-quality-fixture.mjs";

export function createSymbolFixture() {
  const root = createPolicyFixtureRepository();
  const put = (path, value) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const options = {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    types: [],
    verbatimModuleSyntax: true,
  };
  put("package.json", {
    name: "fixture",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
  });
  put("tsconfig.build.json", { compilerOptions: { ...options, noEmit: true }, include: ["src"] });
  configureSymbolOwner(put, options);
  put(
    "src/consumer.ts",
    'import { parse as accepted } from "alpha"; import { validate as direct } from "alpha/runtime"; export const first = accepted(1); export const second = direct("x");\n',
  );
  put(".gitignore", "**/dist/\nnode_modules/\n");
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(root, "packages/alpha"), join(root, "node_modules/alpha"));
  emitSymbolFixture(root);
  return { root, put };
}

function configureSymbolOwner(put, options) {
  put("packages/alpha/tsconfig.json", {
    compilerOptions: {
      ...options,
      composite: true,
      declaration: true,
      declarationMap: true,
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src"],
  });
  put("packages/alpha/package.json", {
    name: "alpha",
    version: "0.0.0",
    type: "module",
    files: ["dist"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./runtime": { types: "./dist/owner.d.ts", import: "./dist/owner.js" },
    },
  });
  put(
    "packages/alpha/src/owner.ts",
    "export function validate(input: unknown): { ok: true; value: number } | { ok: false } { return typeof input === 'number' ? { ok: true, value: input } : { ok: false }; }\n",
  );
  put("packages/alpha/src/index.ts", 'export { validate as parse } from "./owner.js";\n');
}

export function emitSymbolFixture(root, directory = "packages/alpha") {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, directory, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new TypeError("symbol-fixture-config");
      },
    },
  );
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  if (ts.getPreEmitDiagnostics(program).length > 0) throw new TypeError("symbol-fixture-types");
  const emitted = program.emit();
  if (emitted.emitSkipped || emitted.diagnostics.length > 0)
    throw new TypeError("symbol-fixture-emit");
}

export function packSymbolFixture(root) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, "pack", "--dry-run", "--ignore-scripts", "--json", "--workspaces"],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    ),
  );
}
