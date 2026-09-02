import type { WorkspaceLanguage } from "./types.js";

export const LANGUAGE_MARKERS: readonly (readonly [WorkspaceLanguage, readonly string[]])[] = [
  ["typescript", ["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"]],
  ["javascript", ["package.json", "jsconfig.json"]],
  ["java", ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"]],
  ["kotlin", ["build.gradle.kts", "settings.gradle.kts"]],
  ["scala", ["build.sbt", ".scala-version"]],
  ["groovy", ["build.gradle", "settings.gradle"]],
  ["go", ["go.mod", "go.work"]],
  ["rust", ["Cargo.toml", "rust-toolchain.toml", "rust-toolchain"]],
  ["python", ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]],
  ["csharp", ["global.json", "Directory.Build.props"]],
  ["cpp", ["CMakeLists.txt"]],
  ["swift", ["Package.swift"]],
  ["ruby", ["Gemfile"]],
  ["php", ["composer.json"]],
  ["sql", ["schema.sql"]],
  ["terraform", ["main.tf", "versions.tf", "providers.tf"]],
  ["protobuf", ["buf.yaml", "buf.gen.yaml"]],
  [
    "openapi",
    ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"],
  ],
  ["graphql", ["schema.graphql"]],
];

const EXTENSION_LANGUAGES: Readonly<Partial<Record<string, WorkspaceLanguage>>> = {
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  csx: "csharp",
  cxx: "cpp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  go: "go",
  gradle: "groovy",
  graphql: "graphql",
  groovy: "groovy",
  gql: "graphql",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  proto: "protobuf",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sql: "sql",
  swift: "swift",
  tf: "terraform",
  tfvars: "terraform",
  ts: "typescript",
  tsx: "typescript",
  vb: "vb",
};

const FILE_NAME_LANGUAGES: readonly (readonly [RegExp, WorkspaceLanguage])[] = [
  [/^(openapi|swagger)\.(?:ya?ml|json)$/u, "openapi"],
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function languageForFileName(name: string): WorkspaceLanguage | undefined {
  const lower = name.toLowerCase();
  for (const [pattern, language] of FILE_NAME_LANGUAGES) {
    if (pattern.test(lower)) {
      return language;
    }
  }
  return EXTENSION_LANGUAGES[extensionOf(lower)];
}
