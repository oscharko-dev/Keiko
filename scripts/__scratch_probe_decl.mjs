import ts from "typescript";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const repoRoot = "/Users/oscharko/Projects/keiko-3384-work";
const specifier = join(repoRoot, "dist", "index.js").replaceAll("\\", "/");
const probeFile = join(repoRoot, "__keiko-public-api-probe__.ts").replaceAll("\\", "/");
const probeText =
  `export * from ${JSON.stringify("./dist/index.js")};\n` +
  `export type __Probe = typeof import(${JSON.stringify("./dist/index.js")});\n`;

const compilerOptions = {
  baseUrl: repoRoot,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  module: ts.ModuleKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  typeRoots: [join(repoRoot, "node_modules", "@types")],
  types: ["node"],
};

const host = ts.createCompilerHost(compilerOptions, true);
host.readFile = (fileName) => {
  if (fileName === probeFile) return probeText;
  return ts.sys.readFile(fileName);
};
host.fileExists = (fileName) => fileName === probeFile || ts.sys.fileExists(fileName);

const program = ts.createProgram([probeFile], compilerOptions, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  console.error("DIAGNOSTICS:");
  for (const d of diagnostics.slice(0, 30)) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    console.error(message);
  }
}
const sourceFile = program.getSourceFile(probeFile);
if (!sourceFile) {
  console.error("no source file");
  process.exit(1);
}
const checker = program.getTypeChecker();
const symbol = checker.getSymbolAtLocation(sourceFile);
if (!symbol) {
  console.error("no module symbol");
  process.exit(1);
}
const names = checker
  .getExportsOfModule(symbol)
  .map((item) => item.getName())
  .filter((item) => item !== "__Probe")
  .sort((a, b) => a.localeCompare(b));

const contract = JSON.parse(readFileSync(join(repoRoot, "scripts", "root-package-surface.contract.json"), "utf8"));
const expected = contract.declarationExports;
const expectedSet = new Set(expected);
const actualSet = new Set(names);
const missing = expected.filter((n) => !actualSet.has(n));
const unexpected = names.filter((n) => !expectedSet.has(n));
console.log("actual count", names.length);
console.log("missing", missing.length, missing);
console.log("unexpected", unexpected.length, unexpected);
