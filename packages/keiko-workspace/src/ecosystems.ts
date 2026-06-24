// Language / build-system ecosystem registry (Milestone 1 of the enterprise repository-retrieval
// redesign). This is the SINGLE, extensible source of truth for "what counts as a canonical
// project manifest, a source file, a generated artifact, or a lockfile" per ecosystem, plus the
// natural-language terms that route a project-metadata question to an ecosystem.
//
// It exists because the prior retrieval pipeline hard-coded JS/TS knowledge in three independent
// places (planner intent classification, candidate bucketing, and the lexical phrase matcher), so a
// polyglot repository could not answer "Which Java version does this project use?" — a Maven
// `pom.xml` declaring `maven.compiler.release` was bucketed as `other` (score 20) and lost to a
// `README.md` (overview-doc, score 70). Adding ecosystems must mean editing THIS table, not
// scattering more language hacks across the pipeline.
//
// Hard constraints (verified against the workspace security boundary — see ignore.ts):
//   * PURE + DETERMINISTIC + OFFLINE: no IO, no clock, no RNG, no network. Classification never
//     reads file contents; iteration order is fixed by the array below so evidence ordering and
//     stableIds stay reproducible across runs and locales.
//   * DENY-LIST CLEAN: every registered manifest name/suffix is asserted disjoint from
//     DEFAULT_DENY_PATTERNS and the secret-file conventions in ecosystems.test.ts. The registry can
//     only ever RE-BUCKET a file that already survived discovery + the always-on deny gate; it can
//     never resurrect a denied/secret path (.env, *.tfvars, *.tfstate, .npmrc, *.pem/*.key,
//     kubeconfig, service-account*.json, node_modules, dist/build/out/coverage, …).
//   * ReDoS-SAFE: routing patterns compile to linear regex (escaped literals; only `[\s_-]+`
//     between words), matching the single-quantifier convention used elsewhere in this package.
//   * GENERATED MARKERS are WHOLE-SEGMENT or ANCHORED-SUFFIX only — never a bare substring — so a
//     hand-authored `src/builder.ts` is not mistaken for a `build/` artifact.

export type EcosystemId =
  | "java"
  | "kotlin"
  | "scala"
  | "groovy"
  | "maven"
  | "gradle"
  | "go"
  | "rust"
  | "python"
  | "javascript"
  | "typescript"
  | "node"
  | "deno"
  | "bun"
  | "dotnet"
  | "cpp"
  | "swift"
  | "ruby"
  | "php"
  | "terraform"
  | "docker"
  | "kubernetes"
  | "sql"
  | "protobuf"
  | "openapi"
  | "graphql";

export interface EcosystemVersionDeclaration {
  // Manifest the declaration lives in (real-case basename or descriptive glob).
  readonly file: string;
  // Human-readable description of the key/element/regex that declares the language or runtime
  // version. Used in documentation and as future excerpt-targeting hints; never executed.
  readonly signal: string;
  // A realistic one-line example of the declaration as it appears in a real manifest.
  readonly example: string;
}

export interface Ecosystem {
  readonly id: EcosystemId;
  readonly label: string;
  // Exact manifest basenames in their REAL on-disk case (e.g. "Cargo.toml", "Dockerfile"). Used
  // verbatim for the deterministic project-metadata atom injection, which does a case-sensitive
  // existence check against the real filesystem. Matching for bucketing is case-insensitive.
  readonly manifestNames: readonly string[];
  // Lowercase basename suffixes for glob-style manifests, e.g. ".csproj", ".tf". Matched with a
  // single anchored endsWith — never a substring.
  readonly manifestSuffixes: readonly string[];
  // Lowercase source-file extensions (no leading dot) owned by this ecosystem.
  readonly sourceExtensions: readonly string[];
  // Real-case lockfile basenames. Lockfiles stay gated: surfaced only for project-metadata intent
  // or when explicitly targeted (see repoSearchPolicy.policyOmissionReason).
  readonly lockfileNames: readonly string[];
  // Lowercase path SEGMENTS that mark a generated/vendored output tree to deprioritize, matched
  // whole-segment. Build dirs already denied at discovery (dist/build/out/coverage/node_modules)
  // are intentionally NOT repeated here.
  readonly generatedSegments: readonly string[];
  // Lowercase basename suffixes marking a generated FILE, matched with an anchored endsWith.
  readonly generatedSuffixes: readonly string[];
  // Curated, HIGH-PRECISION natural-language routing terms (English + German), lowercase. A space
  // matches any run of space/underscore/hyphen. Deliberately excludes generic words that collide
  // with ordinary code/overview questions ("schema", "module", "version", "service", "build", …).
  readonly routingTerms: readonly string[];
  // Lowercase literal tokens that appear ON the version-declaration line in this ecosystem's
  // manifests. Injected as extra lexical-search tokens when a routing term matches, so the matcher
  // prefers the exact declaration line for the line-range evidence.
  readonly contentTokens: readonly string[];
  readonly versionDeclarations: readonly EcosystemVersionDeclaration[];
  readonly buildCommands: readonly string[];
}

// ─── The registry ──────────────────────────────────────────────────────────────
// Array order is the deterministic iteration order for every derived pattern list.

export const ECOSYSTEMS: readonly Ecosystem[] = Object.freeze([
  {
    id: "java",
    label: "Java",
    manifestNames: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version", ".sdkmanrc"],
    manifestSuffixes: [],
    sourceExtensions: ["java"],
    lockfileNames: ["gradle.lockfile", "buildscript-gradle.lockfile"],
    generatedSegments: ["target", "generated-sources", ".gradle"],
    generatedSuffixes: [".class"],
    routingTerms: [
      "java",
      "jdk",
      "jvm",
      "jre",
      "openjdk",
      "java version",
      "java-laufzeit",
      "jakarta",
      "bytecode",
    ],
    contentTokens: [
      "maven.compiler",
      "java.version",
      "sourcecompatibility",
      "targetcompatibility",
      "languageversion",
    ],
    versionDeclarations: [
      {
        file: "pom.xml",
        signal: "<maven.compiler.release> / <maven.compiler.source> / <maven.compiler.target>",
        example: "<maven.compiler.release>21</maven.compiler.release>",
      },
      {
        file: "build.gradle",
        signal: "sourceCompatibility / JavaLanguageVersion.of(N)",
        example: "sourceCompatibility = JavaVersion.VERSION_21",
      },
      { file: ".java-version", signal: "bare major version line (jenv / sdkman)", example: "21" },
    ],
    buildCommands: ["mvn -q -DskipTests package", "./gradlew build"],
  },
  {
    id: "kotlin",
    label: "Kotlin",
    manifestNames: ["build.gradle.kts", "settings.gradle.kts", "gradle/libs.versions.toml"],
    manifestSuffixes: [],
    sourceExtensions: ["kt", "kts"],
    lockfileNames: ["gradle.lockfile"],
    generatedSegments: [".gradle"],
    generatedSuffixes: [],
    routingTerms: ["kotlin", "ktor", "kmp", "kotlin multiplatform", "coroutines", "jetbrains"],
    contentTokens: ["jvmtarget", "languageversion", "kotlin"],
    versionDeclarations: [
      {
        file: "build.gradle.kts",
        signal: 'kotlin("jvm") version "x.y.z" / kotlinOptions.jvmTarget',
        example: 'kotlin("jvm") version "2.0.20"',
      },
      {
        file: "gradle/libs.versions.toml",
        signal: 'kotlin = "x.y.z" under [versions]',
        example: 'kotlin = "2.0.20"',
      },
    ],
    buildCommands: ["./gradlew build"],
  },
  {
    id: "scala",
    label: "Scala",
    manifestNames: [
      "build.sbt",
      "project/build.properties",
      "project/plugins.sbt",
      ".scala-version",
    ],
    manifestSuffixes: [],
    sourceExtensions: ["scala", "sc"],
    lockfileNames: [],
    generatedSegments: ["target", ".bloop", ".bsp"],
    generatedSuffixes: [".tasty"],
    routingTerms: ["scala", "sbt", "akka", "dotty", "tasty", "scala 3", "scala version"],
    contentTokens: ["scalaversion", "sbt.version"],
    versionDeclarations: [
      { file: "build.sbt", signal: 'scalaVersion := "x.y.z"', example: 'scalaVersion := "3.4.2"' },
      {
        file: "project/build.properties",
        signal: "sbt.version=x.y.z",
        example: "sbt.version=1.10.1",
      },
    ],
    buildCommands: ["sbt compile"],
  },
  {
    id: "groovy",
    label: "Groovy",
    manifestNames: ["build.gradle"],
    manifestSuffixes: [".groovy"],
    sourceExtensions: ["groovy", "gvy", "gy"],
    lockfileNames: ["gradle.lockfile"],
    generatedSegments: [".gradle"],
    generatedSuffixes: [],
    routingTerms: ["groovy", "spock", "jenkinsfile", "apache groovy", "groovy version"],
    contentTokens: ["org.apache.groovy", "org.codehaus.groovy", "groovy.version"],
    versionDeclarations: [
      {
        file: "build.gradle",
        signal: "org.apache.groovy:groovy dependency version",
        example: "implementation 'org.apache.groovy:groovy:4.0.22'",
      },
    ],
    buildCommands: ["./gradlew build"],
  },
  {
    id: "maven",
    label: "Maven",
    manifestNames: [
      "pom.xml",
      ".mvn/maven.config",
      ".mvn/jvm.config",
      ".mvn/wrapper/maven-wrapper.properties",
      "mvnw",
      "mvnw.cmd",
    ],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: [],
    generatedSegments: ["target"],
    generatedSuffixes: [".jar", ".war"],
    routingTerms: [
      "maven",
      "pom.xml",
      "pom datei",
      "mvn",
      "surefire",
      "failsafe",
      "maven central",
      "groupid",
      "artifactid",
      "maven-wrapper",
    ],
    contentTokens: ["maven.compiler", "modelversion", "artifactid", "groupid"],
    versionDeclarations: [
      {
        file: "pom.xml",
        signal: "<maven.compiler.release|source|target>",
        example: "<maven.compiler.release>21</maven.compiler.release>",
      },
      {
        file: ".mvn/wrapper/maven-wrapper.properties",
        signal: "distributionUrl=.../apache-maven-x.y.z-bin.zip",
        example: "distributionUrl=https://.../apache-maven-3.9.9-bin.zip",
      },
    ],
    buildCommands: ["mvn -q -DskipTests package"],
  },
  {
    id: "gradle",
    label: "Gradle",
    manifestNames: [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradle.properties",
      "gradle/libs.versions.toml",
      "gradle/wrapper/gradle-wrapper.properties",
      "gradlew",
      "gradlew.bat",
    ],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: ["gradle.lockfile", "buildscript-gradle.lockfile", "settings-gradle.lockfile"],
    generatedSegments: [".gradle"],
    generatedSuffixes: [],
    routingTerms: [
      "gradle",
      "gradlew",
      "gradle wrapper",
      "build.gradle",
      "version catalog",
      "gradle build",
      "gradle version",
    ],
    contentTokens: [
      "distributionurl",
      "languageversion",
      "sourcecompatibility",
      "targetcompatibility",
      "jvmtarget",
    ],
    versionDeclarations: [
      {
        file: "gradle/wrapper/gradle-wrapper.properties",
        signal: "distributionUrl=.../gradle-x.y.z-bin.zip",
        example: "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip",
      },
      {
        file: "build.gradle.kts",
        signal: "java { toolchain { languageVersion = JavaLanguageVersion.of(N) } }",
        example: "languageVersion = JavaLanguageVersion.of(21)",
      },
    ],
    buildCommands: ["./gradlew build"],
  },
  {
    id: "go",
    label: "Go",
    manifestNames: ["go.mod", "go.work"],
    manifestSuffixes: [],
    sourceExtensions: ["go"],
    lockfileNames: ["go.sum", "go.work.sum"],
    generatedSegments: ["vendor"],
    generatedSuffixes: [".pb.go", "_pb.go", ".pb.gw.go", "_grpc.pb.go", "_gen.go", "_string.go"],
    routingTerms: [
      "golang",
      "go module",
      "go modul",
      "go.mod",
      "go version",
      "go toolchain",
      "goroutine",
      "gofmt",
      "gopath",
      "go-projekt",
    ],
    contentTokens: ["go", "toolchain", "module"],
    versionDeclarations: [
      {
        file: "go.mod",
        signal: "go <major.minor[.patch]> directive (language/min version)",
        example: "go 1.23.0",
      },
      {
        file: "go.mod",
        signal: "toolchain go<version> directive (pinned toolchain)",
        example: "toolchain go1.23.2",
      },
    ],
    buildCommands: ["go build ./...", "go test ./..."],
  },
  {
    id: "rust",
    label: "Rust",
    // .cargo/config.toml is intentionally omitted: the .cargo directory is on the always-on deny
    // list (credential store), so registering it would both fail the deny-clean invariant and be
    // moot (the deny gate suppresses it at discovery).
    manifestNames: ["Cargo.toml", "rust-toolchain.toml", "rust-toolchain"],
    manifestSuffixes: [],
    sourceExtensions: ["rs"],
    lockfileNames: ["Cargo.lock"],
    generatedSegments: ["target"],
    generatedSuffixes: [".rs.bk"],
    routingTerms: [
      "rust",
      "cargo",
      "cargo.toml",
      "crate",
      "rustc",
      "rustup",
      "tokio",
      "msrv",
      "rust edition",
      "rust-toolchain",
      "rust version",
      "speichersicher",
    ],
    contentTokens: ["rust-version", "edition", "channel"],
    versionDeclarations: [
      {
        file: "Cargo.toml",
        signal: "[package] rust-version (MSRV)",
        example: 'rust-version = "1.80"',
      },
      {
        file: "Cargo.toml",
        signal: "[package] edition (language edition)",
        example: 'edition = "2021"',
      },
      {
        file: "rust-toolchain.toml",
        signal: "[toolchain] channel (pinned toolchain)",
        example: 'channel = "1.80.0"',
      },
    ],
    buildCommands: ["cargo build", "cargo test"],
  },
  {
    id: "python",
    label: "Python",
    manifestNames: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      ".python-version",
      "tox.ini",
      "environment.yml",
      "conda.yaml",
    ],
    manifestSuffixes: [],
    sourceExtensions: ["py", "pyi"],
    lockfileNames: ["poetry.lock", "Pipfile.lock", "uv.lock", "pdm.lock", "conda-lock.yml"],
    generatedSegments: ["__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache"],
    generatedSuffixes: [".pyc", "_pb2.py", "_pb2_grpc.py", "_pb2.pyi"],
    routingTerms: [
      "python",
      "python version",
      "pip",
      "pytest",
      "poetry",
      "pyenv",
      "virtualenv",
      "venv",
      "conda",
      "pyproject",
      "python-laufzeit",
    ],
    contentTokens: ["requires-python", "python_requires", "python"],
    versionDeclarations: [
      {
        file: "pyproject.toml",
        signal: "[project] requires-python",
        example: 'requires-python = ">=3.11"',
      },
      { file: ".python-version", signal: "bare version line (pyenv / uv)", example: "3.12.4" },
      {
        file: "setup.cfg",
        signal: "[options] python_requires",
        example: "python_requires = >=3.9",
      },
    ],
    buildCommands: ["python -m build", "pytest"],
  },
  {
    id: "javascript",
    label: "JavaScript",
    // Includes the established build/test tool configs (vite/vitest/jest/playwright/cypress/next/
    // eslint/postcss/babel) so they remain canonical metadata, preserving the prior JS/TS behaviour.
    manifestNames: [
      "package.json",
      ".nvmrc",
      ".node-version",
      "jsconfig.json",
      ".babelrc",
      "babel.config.js",
      "vite.config.ts",
      "vite.config.mts",
      "vite.config.js",
      "vite.config.mjs",
      "vitest.config.ts",
      "vitest.config.mts",
      "vitest.config.js",
      "vitest.config.mjs",
      "vitest.setup.ts",
      "jest.config.ts",
      "jest.config.js",
      "jest.config.mjs",
      "playwright.config.ts",
      "playwright.config.js",
      "cypress.config.ts",
      "cypress.config.js",
      "next.config.ts",
      "next.config.js",
      "next.config.mjs",
      "eslint.config.ts",
      "eslint.config.js",
      "eslint.config.mjs",
      "postcss.config.js",
      "postcss.config.mjs",
    ],
    manifestSuffixes: [],
    sourceExtensions: ["js", "jsx", "mjs", "cjs"],
    lockfileNames: [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "bun.lock",
    ],
    generatedSegments: [".next", ".nuxt", ".parcel-cache"],
    generatedSuffixes: [".min.js"],
    // Routing is also handled by the planner's built-in JS/TS patterns. The registry repeats the
    // high-precision terms so matcher-side version-declaration boosts can stay registry-derived.
    routingTerms: ["javascript", "node", "node.js", "package.json", "npm", "pnpm", "yarn"],
    contentTokens: ["engines"],
    versionDeclarations: [
      {
        file: "package.json",
        signal: "engines.node (runtime range)",
        example: '"engines": { "node": ">=20" }',
      },
      { file: ".nvmrc", signal: "bare Node version line (nvm)", example: "20.11.1" },
    ],
    buildCommands: ["npm run build", "npm test"],
  },
  {
    id: "typescript",
    label: "TypeScript",
    manifestNames: ["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"],
    manifestSuffixes: [],
    sourceExtensions: ["ts", "tsx", "mts", "cts"],
    lockfileNames: [],
    generatedSegments: [],
    generatedSuffixes: [".tsbuildinfo", ".js.map", ".d.ts.map"],
    routingTerms: ["typescript", "tsconfig", "tsc", "compileroptions", "type script"],
    contentTokens: ["typescript", "compileroptions", "target"],
    versionDeclarations: [
      {
        file: "package.json",
        signal: "devDependencies.typescript (compiler version)",
        example: '"typescript": "^5.5.4"',
      },
      {
        file: "tsconfig.json",
        signal: "compilerOptions.target (emitted ECMAScript version)",
        example: '"target": "ES2022"',
      },
    ],
    buildCommands: ["tsc -b", "npm test"],
  },
  {
    id: "node",
    label: "Node.js",
    manifestNames: [
      "package.json",
      ".nvmrc",
      ".node-version",
      ".yarnrc.yml",
      "pnpm-workspace.yaml",
    ],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
    ],
    generatedSegments: [".pnpm-store"],
    generatedSuffixes: [],
    routingTerms: [
      "node",
      "node.js",
      "npm",
      "pnpm",
      "yarn",
      "package.json",
      "package manager",
      "paket manager",
      "engines.node",
    ],
    contentTokens: ["engines", "packagemanager", "volta"],
    versionDeclarations: [
      {
        file: "package.json",
        signal: "engines.node (supported runtime range)",
        example: '"engines": { "node": ">=20.0.0" }',
      },
      { file: ".nvmrc", signal: "bare Node version (nvm)", example: "v20.11.1" },
    ],
    buildCommands: ["npm ci", "npm run build"],
  },
  {
    id: "deno",
    label: "Deno",
    manifestNames: ["deno.json", "deno.jsonc", "import_map.json"],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: ["deno.lock"],
    generatedSegments: [".deno"],
    generatedSuffixes: [],
    routingTerms: ["deno", "deno.json", "jsr", "deno deploy", "deno task", "deno runtime"],
    contentTokens: ["imports", "compileroptions"],
    versionDeclarations: [
      {
        file: "deno.json",
        signal: "imports / compilerOptions.lib; runtime pinned via tooling/CI",
        example: '"imports": { "@std/": "jsr:@std/" }',
      },
    ],
    buildCommands: ["deno task build", "deno test"],
  },
  {
    id: "bun",
    label: "Bun",
    manifestNames: ["bunfig.toml", ".bun-version"],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: ["bun.lockb", "bun.lock"],
    generatedSegments: [".bun"],
    generatedSuffixes: [],
    routingTerms: ["bun", "bun.lockb", "bunfig", "bun runtime", "elysia"],
    contentTokens: ["bun", "packagemanager"],
    versionDeclarations: [
      {
        file: "package.json",
        signal: "engines.bun / packageManager (bun pin)",
        example: '"packageManager": "bun@1.1.21"',
      },
      { file: ".bun-version", signal: "bare Bun version line", example: "1.1.21" },
    ],
    buildCommands: ["bun install", "bun test"],
  },
  {
    id: "dotnet",
    label: ".NET",
    manifestNames: [
      "global.json",
      "Directory.Build.props",
      "Directory.Packages.props",
      "paket.dependencies",
    ],
    manifestSuffixes: [".csproj", ".fsproj", ".vbproj", ".sln"],
    sourceExtensions: ["cs", "fs", "vb"],
    lockfileNames: ["packages.lock.json", "paket.lock"],
    generatedSegments: ["bin", "obj", "testresults"],
    generatedSuffixes: [".g.cs", ".designer.cs", ".assemblyinfo.cs", ".nupkg"],
    routingTerms: [
      "c#",
      "csharp",
      "dotnet",
      ".net",
      "nuget",
      "msbuild",
      "csproj",
      "asp.net",
      "f#",
      "blazor",
      "global.json",
      "target framework",
      "dotnet version",
    ],
    contentTokens: ["targetframework", "langversion", "sdk"],
    versionDeclarations: [
      {
        file: "global.json",
        signal: "sdk.version (pinned .NET SDK)",
        example: '"sdk": { "version": "8.0.401" }',
      },
      {
        file: "*.csproj",
        signal: "<TargetFramework> / <TargetFrameworks> (TFM)",
        example: "<TargetFramework>net8.0</TargetFramework>",
      },
      {
        file: "*.csproj",
        signal: "<LangVersion> (C# language version)",
        example: "<LangVersion>12.0</LangVersion>",
      },
    ],
    buildCommands: ["dotnet build", "dotnet test"],
  },
  {
    id: "cpp",
    label: "C/C++",
    manifestNames: [
      "CMakeLists.txt",
      "Makefile",
      "GNUmakefile",
      "conanfile.txt",
      "conanfile.py",
      "vcpkg.json",
      "meson.build",
      "compile_commands.json",
    ],
    manifestSuffixes: [".vcxproj"],
    sourceExtensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ipp", "inl"],
    lockfileNames: ["conan.lock"],
    generatedSegments: ["cmakefiles"],
    generatedSuffixes: [".o", ".obj", ".a", ".pb.cc", ".pb.h", "moc_", "ui_"],
    routingTerms: [
      "c++",
      "cpp",
      "cmake",
      "conan",
      "vcpkg",
      "meson",
      "gcc",
      "clang",
      "c++ standard",
      "header datei",
    ],
    contentTokens: ["cmake_cxx_standard", "cmake_minimum_required", "cpp_std", "c_std"],
    versionDeclarations: [
      {
        file: "CMakeLists.txt",
        signal: "set(CMAKE_CXX_STANDARD N) / target_compile_features(cxx_std_N)",
        example: "set(CMAKE_CXX_STANDARD 20)",
      },
      {
        file: "CMakeLists.txt",
        signal: "cmake_minimum_required(VERSION x.y)",
        example: "cmake_minimum_required(VERSION 3.25)",
      },
    ],
    buildCommands: ["cmake -B build && cmake --build build", "make"],
  },
  {
    id: "swift",
    label: "Swift",
    manifestNames: ["Package.swift", "Podfile", "Cartfile", ".swift-version"],
    manifestSuffixes: [],
    sourceExtensions: ["swift"],
    lockfileNames: ["Package.resolved", "Podfile.lock", "Cartfile.resolved"],
    generatedSegments: [".build", "deriveddata", "pods", "carthage"],
    generatedSuffixes: [".swiftmodule"],
    routingTerms: [
      "swift",
      "swiftpm",
      "xcode",
      "cocoapods",
      "carthage",
      "swift-tools-version",
      "swift version",
    ],
    contentTokens: ["swift-tools-version", "swiftlanguageversions", "swiftlanguagemode"],
    versionDeclarations: [
      {
        file: "Package.swift",
        signal: "// swift-tools-version:x.y header",
        example: "// swift-tools-version:6.0",
      },
      { file: ".swift-version", signal: "bare Swift version (swiftenv)", example: "5.10" },
    ],
    buildCommands: ["swift build", "swift test"],
  },
  {
    id: "ruby",
    label: "Ruby",
    manifestNames: ["Gemfile", ".ruby-version", ".tool-versions", "Rakefile"],
    manifestSuffixes: [".gemspec"],
    sourceExtensions: ["rb", "rake", "ru"],
    lockfileNames: ["Gemfile.lock"],
    generatedSegments: ["vendor", ".bundle"],
    generatedSuffixes: [".gem"],
    routingTerms: [
      "ruby",
      "ruby version",
      "gem",
      "bundler",
      "rails",
      "rake",
      "rspec",
      "rbenv",
      "gemfile",
      "edelstein",
    ],
    contentTokens: ["required_ruby_version", "ruby"],
    versionDeclarations: [
      { file: ".ruby-version", signal: "bare Ruby version (rbenv/rvm/chruby)", example: "3.3.4" },
      { file: "Gemfile", signal: 'ruby "x.y.z" directive', example: 'ruby "3.3.4"' },
      {
        file: "*.gemspec",
        signal: "spec.required_ruby_version",
        example: 'spec.required_ruby_version = ">= 3.1"',
      },
    ],
    buildCommands: ["bundle install", "bundle exec rake"],
  },
  {
    id: "php",
    label: "PHP",
    manifestNames: ["composer.json", ".php-version", "phpunit.xml", "phpunit.xml.dist"],
    manifestSuffixes: [],
    sourceExtensions: ["php"],
    lockfileNames: ["composer.lock"],
    generatedSegments: ["vendor"],
    generatedSuffixes: [],
    routingTerms: [
      "php",
      "composer",
      "laravel",
      "symfony",
      "phpunit",
      "psr-4",
      "packagist",
      "php version",
    ],
    contentTokens: ["require", "platform", "php"],
    versionDeclarations: [
      {
        file: "composer.json",
        signal: "require.php (PHP version constraint)",
        example: '"require": { "php": ">=8.2" }',
      },
      { file: ".php-version", signal: "bare PHP version (phpenv)", example: "8.2.10" },
    ],
    buildCommands: ["composer install", "vendor/bin/phpunit"],
  },
  {
    id: "terraform",
    label: "Terraform",
    // NOTE: *.tfvars / *.tfvars.json / *.tfstate are DENIED secret files (see ignore.ts) and are
    // deliberately NOT registered as manifests — only declarative *.tf / *.tf.json configuration.
    manifestNames: [
      "versions.tf",
      "main.tf",
      "providers.tf",
      ".terraform-version",
      ".terraform.lock.hcl",
    ],
    manifestSuffixes: [".tf", ".tf.json"],
    sourceExtensions: ["hcl"],
    lockfileNames: [".terraform.lock.hcl"],
    generatedSegments: [],
    generatedSuffixes: [".tfplan"],
    routingTerms: [
      "terraform",
      "terraform version",
      "hcl",
      "opentofu",
      "tofu",
      "infrastructure as code",
      "iac",
      "infrastruktur als code",
    ],
    contentTokens: ["required_version", "required_providers"],
    versionDeclarations: [
      {
        file: "*.tf",
        signal: "terraform { required_version = ... }",
        example: 'required_version = ">= 1.9.0"',
      },
      { file: ".terraform-version", signal: "bare Terraform version (tfenv)", example: "1.9.5" },
    ],
    buildCommands: ["terraform init", "terraform plan"],
  },
  {
    id: "docker",
    label: "Docker",
    manifestNames: [
      "Dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ],
    manifestSuffixes: [".dockerfile"],
    sourceExtensions: [],
    lockfileNames: [],
    generatedSegments: [],
    generatedSuffixes: [],
    routingTerms: [
      "docker",
      "dockerfile",
      "docker compose",
      "buildkit",
      "containerd",
      "oci image",
      "base image",
      "docker image",
      "behälter",
      "abbild",
    ],
    contentTokens: ["from", "syntax="],
    versionDeclarations: [
      {
        file: "Dockerfile",
        signal: "FROM image:tag (base image / runtime version)",
        example: "FROM eclipse-temurin:21-jre",
      },
    ],
    buildCommands: ["docker build .", "docker compose up -d"],
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    // Bare *.yaml/*.yml is intentionally NOT registered (it would flood canonical-metadata); only
    // the named Kubernetes/Helm/Kustomize descriptor files are treated as canonical.
    manifestNames: [
      "kustomization.yaml",
      "kustomization.yml",
      "Chart.yaml",
      "values.yaml",
      "skaffold.yaml",
      "Chart.lock",
    ],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: ["Chart.lock"],
    generatedSegments: ["charts", "rendered"],
    generatedSuffixes: [],
    routingTerms: [
      "kubernetes",
      "k8s",
      "kubectl",
      "helm",
      "kustomize",
      "kubernetes manifest",
      "container orchestrierung",
    ],
    contentTokens: ["apiversion", "appversion", "kubeversion"],
    versionDeclarations: [
      {
        file: "Chart.yaml",
        signal: "apiVersion / appVersion / kubeVersion (Helm chart + target K8s)",
        example: 'kubeVersion: ">=1.27.0"',
      },
    ],
    buildCommands: ["kubectl apply -k .", "helm install"],
  },
  {
    id: "sql",
    label: "SQL",
    manifestNames: [
      "schema.sql",
      "flyway.conf",
      "liquibase.properties",
      "dbt_project.yml",
      "knexfile.js",
      "alembic.ini",
    ],
    manifestSuffixes: [],
    sourceExtensions: ["sql", "ddl", "dml"],
    lockfileNames: [],
    generatedSegments: ["dbt_packages", "compiled"],
    generatedSuffixes: [".dump"],
    routingTerms: [
      "flyway",
      "liquibase",
      "dbt",
      "alembic",
      "sql migration",
      "datenbankschema",
      "ddl",
    ],
    contentTokens: ["require-dbt-version", "revision"],
    versionDeclarations: [
      {
        file: "dbt_project.yml",
        signal: "version / require-dbt-version",
        example: 'require-dbt-version: ">=1.7.0"',
      },
    ],
    buildCommands: ["flyway migrate", "dbt build"],
  },
  {
    id: "protobuf",
    label: "Protocol Buffers",
    manifestNames: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"],
    manifestSuffixes: [".proto"],
    sourceExtensions: ["proto"],
    lockfileNames: ["buf.lock"],
    generatedSegments: [],
    generatedSuffixes: [
      ".pb.go",
      "_pb2.py",
      "_pb2_grpc.py",
      ".pb.cc",
      ".pb.h",
      "_pb.js",
      "_pb.d.ts",
      ".pb.swift",
      "_grpc.pb.go",
    ],
    routingTerms: [
      "protobuf",
      "protocol buffers",
      ".proto",
      "proto3",
      "proto2",
      "grpc",
      "protoc",
      "buf",
    ],
    contentTokens: ["syntax", "version"],
    versionDeclarations: [
      { file: "*.proto", signal: 'syntax = "proto2|proto3"', example: 'syntax = "proto3";' },
      { file: "buf.yaml", signal: "version (buf config schema)", example: "version: v2" },
    ],
    buildCommands: ["buf generate", "buf build"],
  },
  {
    id: "openapi",
    label: "OpenAPI",
    manifestNames: [
      "openapi.yaml",
      "openapi.yml",
      "openapi.json",
      "swagger.yaml",
      "swagger.json",
      "redocly.yaml",
    ],
    manifestSuffixes: [],
    sourceExtensions: [],
    lockfileNames: [],
    generatedSegments: ["openapi-generated"],
    generatedSuffixes: [".gen.ts"],
    routingTerms: [
      "openapi",
      "swagger",
      "redocly",
      "openapi-generator",
      "openapi spezifikation",
      "rest schnittstelle",
    ],
    contentTokens: ["openapi", "swagger", "info"],
    versionDeclarations: [
      { file: "openapi.yaml", signal: "openapi: x.y.z (spec version)", example: "openapi: 3.1.0" },
      {
        file: "swagger.yaml",
        signal: 'swagger: "2.0" (legacy spec version)',
        example: 'swagger: "2.0"',
      },
    ],
    buildCommands: ["redocly lint", "openapi-generator generate"],
  },
  {
    id: "graphql",
    label: "GraphQL",
    manifestNames: [
      "schema.graphql",
      "graphql.config.yml",
      ".graphqlrc",
      ".graphqlrc.yml",
      "codegen.yml",
      "codegen.ts",
      "apollo.config.js",
    ],
    manifestSuffixes: [".graphql", ".gql"],
    sourceExtensions: ["graphql", "gql"],
    lockfileNames: [],
    generatedSegments: ["__generated__"],
    generatedSuffixes: [".generated.ts"],
    routingTerms: [
      "graphql",
      "gql",
      "graphql-codegen",
      "apollo",
      "sdl",
      "graphql schema",
      "abfragesprache",
    ],
    contentTokens: ["schema", "generates"],
    versionDeclarations: [
      {
        file: "codegen.ts",
        signal: "generates[].plugins + schema source",
        example: "schema: ./schema.graphql",
      },
    ],
    buildCommands: ["graphql-codegen", "apollo schema:check"],
  },
]);

// ─── Derived lookup tables (built once; frozen; deterministic) ───────────────────

function lower(value: string): string {
  return value.toLowerCase();
}

function freezeSet(values: Iterable<string>): ReadonlySet<string> {
  return new Set(values);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

const CANONICAL_MANIFEST_NAMES_LC: ReadonlySet<string> = freezeSet(
  ECOSYSTEMS.flatMap((eco) => eco.manifestNames.map(lower)),
);

const CANONICAL_MANIFEST_SUFFIXES: readonly string[] = Object.freeze([
  ...new Set(ECOSYSTEMS.flatMap((eco) => eco.manifestSuffixes.map(lower))),
]);

// Real-case manifest basenames, de-duplicated and sorted, for the case-sensitive existence-check
// injection path in the grounded orchestrator. Path-shaped entries (e.g. ".mvn/wrapper/...") are
// kept verbatim; the orchestrator joins them to a metadata root.
export const CANONICAL_MANIFEST_BASENAMES: readonly string[] = Object.freeze(
  [...new Set(ECOSYSTEMS.flatMap((eco) => eco.manifestNames))].sort(),
);

const ECOSYSTEM_SOURCE_EXTENSIONS: ReadonlySet<string> = freezeSet(
  ECOSYSTEMS.flatMap((eco) => eco.sourceExtensions.map(lower)),
);

const LOCKFILE_NAMES_LC: ReadonlySet<string> = freezeSet(
  ECOSYSTEMS.flatMap((eco) => eco.lockfileNames.map(lower)),
);

const GENERATED_SEGMENTS: ReadonlySet<string> = freezeSet(
  ECOSYSTEMS.flatMap((eco) => eco.generatedSegments.map(lower)),
);

const GENERATED_SUFFIXES: readonly string[] = Object.freeze([
  ...new Set(ECOSYSTEMS.flatMap((eco) => eco.generatedSuffixes.map(lower))),
]);

// Ecosystem id per exact manifest name / suffix, for explainable ranking diagnostics.
const MANIFEST_NAME_TO_ECOSYSTEM: ReadonlyMap<string, EcosystemId> = new Map(
  ECOSYSTEMS.flatMap((eco) => eco.manifestNames.map((name) => [lower(name), eco.id] as const)),
);
const MANIFEST_SUFFIX_TO_ECOSYSTEM: readonly (readonly [string, EcosystemId])[] = Object.freeze(
  ECOSYSTEMS.flatMap((eco) =>
    eco.manifestSuffixes.map((suffix) => [lower(suffix), eco.id] as const),
  ),
);

// ─── Path helpers (pure, normalization mirrors repoSearchPolicy) ─────────────────

function normalizedPath(scopePath: string): string {
  return scopePath.split("\\").join("/").toLowerCase();
}

function basenameLc(scopePath: string): string {
  const path = normalizedPath(scopePath);
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function pathSegments(scopePath: string): readonly string[] {
  return normalizedPath(scopePath)
    .split("/")
    .filter((segment) => segment.length > 0);
}

// ─── Classification predicates ───────────────────────────────────────────────────

// True when the path is a canonical project/build/dependency manifest for any registered
// ecosystem. Case-insensitive, anchored on the basename (exact name or registered suffix).
export function isCanonicalMetadataFile(scopePath: string): boolean {
  const name = basenameLc(scopePath);
  if (CANONICAL_MANIFEST_NAMES_LC.has(name)) {
    return true;
  }
  return CANONICAL_MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// The ecosystem that classifies a path as canonical metadata, or undefined. For diagnostics only.
export function canonicalMetadataEcosystem(scopePath: string): EcosystemId | undefined {
  const name = basenameLc(scopePath);
  const exact = MANIFEST_NAME_TO_ECOSYSTEM.get(name);
  if (exact !== undefined) {
    return exact;
  }
  for (const [suffix, id] of MANIFEST_SUFFIX_TO_ECOSYSTEM) {
    if (name.endsWith(suffix)) {
      return id;
    }
  }
  return undefined;
}

// True for a source-code file extension owned by a registered ecosystem.
export function isEcosystemSourceFile(scopePath: string): boolean {
  const name = basenameLc(scopePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return ECOSYSTEM_SOURCE_EXTENSIONS.has(name.slice(dot + 1));
}

// True for a generated/vendored artifact, detected by WHOLE path segment or ANCHORED basename
// suffix. Never a bare substring, so `src/builder.ts` / `generator.go` are not affected.
export function isGeneratedArtifactPath(scopePath: string): boolean {
  if (pathSegments(scopePath).some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return true;
  }
  const name = basenameLc(scopePath);
  return GENERATED_SUFFIXES.some((suffix) =>
    suffix.endsWith("_") ? name.startsWith(suffix) : name.endsWith(suffix),
  );
}

// True for a dependency lockfile of any registered ecosystem (case-insensitive basename).
export function isEcosystemLockfile(scopePath: string): boolean {
  return LOCKFILE_NAMES_LC.has(basenameLc(scopePath));
}

// ─── Routing & matcher integration ───────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Compile a curated routing term into a linear, ReDoS-safe, case-insensitive pattern. A word
// boundary is added only on a side that ends in an alphanumeric, so terms like "c#" / ".net" /
// "c++" are matched literally. Internal spaces match any run of space/underscore/hyphen.
function termToPattern(term: string): RegExp {
  const escaped = escapeRegExp(term).replace(/\\?\s+/gu, "[\\s_-]+");
  const left = /^[a-z0-9]/iu.test(term) ? "\\b" : "";
  const right = /[a-z0-9]$/iu.test(term) ? "\\b" : "";
  return new RegExp(`${left}${escaped}${right}`, "iu");
}

export interface EcosystemPattern {
  readonly term: string;
  readonly pattern: RegExp;
}

// Project-metadata routing patterns contributed by the registry, in deterministic order. Consumed
// by the planner's intent classifier so an ecosystem question ("Which Java version…?") is routed
// to `project-metadata`. `term` carries the ecosystem id for traceability.
export const ecosystemMetadataIntentPatterns: readonly EcosystemPattern[] = Object.freeze(
  ECOSYSTEMS.flatMap((eco) =>
    eco.routingTerms.map((term) => ({ term: eco.id, pattern: termToPattern(term) })),
  ),
);

export interface EcosystemPhrase {
  readonly pattern: RegExp;
  readonly term: string;
}

export interface EcosystemVersionDeclarationPattern {
  readonly ecosystem: EcosystemId;
  readonly routePattern: RegExp;
  readonly declarationPattern: RegExp;
  readonly requiresNumeric: boolean;
}

// Lexical-search phrase boosts: when a query matches an ecosystem routing term, the matcher also
// searches for that ecosystem's manifest content tokens (e.g. "maven.compiler") so the exact
// version-declaration line wins the line-range evidence. `term` is the lowercase file token.
export const ecosystemTechnicalPhrases: readonly EcosystemPhrase[] = Object.freeze(
  ECOSYSTEMS.flatMap((eco) => {
    if (eco.routingTerms.length === 0) {
      return [];
    }
    return eco.routingTerms.flatMap((routingTerm) => {
      const pattern = termToPattern(routingTerm);
      return eco.contentTokens.map((token) => ({ pattern, term: lower(token) }));
    });
  }),
);

interface VersionTokenPattern {
  readonly token: string;
  readonly pattern: RegExp;
  readonly requiresNumeric?: boolean;
}

// Version/effective-runtime declaration line recognizers keyed by registry content tokens. These
// are intentionally narrow, anchored where the underlying manifest syntax permits it, and linear
// (no nested quantifiers). The registry still owns which ecosystems contribute which tokens.
const VERSION_DECLARATION_TOKEN_PATTERNS: readonly VersionTokenPattern[] = Object.freeze([
  {
    token: "maven.compiler",
    pattern: /\bmaven\.compiler\.(?:release|source|target)\b/iu,
  },
  { token: "java.version", pattern: /\bjava\.version\b/iu },
  { token: "sourcecompatibility", pattern: /\bsourcecompatibility\b/iu },
  { token: "targetcompatibility", pattern: /\btargetcompatibility\b/iu },
  { token: "languageversion", pattern: /\blanguageversion\b/iu },
  { token: "jvmtarget", pattern: /\bjvmtarget\b/iu },
  { token: "distributionurl", pattern: /\bdistributionurl\b/iu },
  { token: "go", pattern: /^\s*go\s+\d+(?:\.\d+){1,2}\b/iu },
  { token: "toolchain", pattern: /^\s*toolchain\s+go?\d+(?:\.\d+){1,2}\b/iu },
  { token: "rust-version", pattern: /\brust-version\b/iu },
  { token: "edition", pattern: /\bedition\b/iu },
  { token: "channel", pattern: /\bchannel\b/iu },
  { token: "requires-python", pattern: /\brequires-python\b/iu },
  { token: "python_requires", pattern: /\bpython_requires\b/iu },
  { token: "engines", pattern: /\bengines\b/iu },
  { token: "packagemanager", pattern: /\bpackagemanager\b|\bpackageManager\b/iu },
  { token: "volta", pattern: /\bvolta\b/iu },
  { token: "typescript", pattern: /"typescript"\s*:/iu },
  { token: "compileroptions", pattern: /\bcompileroptions\b/iu },
  { token: "target", pattern: /\btarget\b/iu, requiresNumeric: false },
  { token: "targetframework", pattern: /\btargetframeworks?\b/iu },
  { token: "langversion", pattern: /\blangversion\b/iu },
  { token: "sdk", pattern: /"sdk"\s*:/iu },
  { token: "cmake_cxx_standard", pattern: /\bcmake_cxx_standard\b/iu },
  { token: "cmake_minimum_required", pattern: /\bcmake_minimum_required\b/iu },
  { token: "cpp_std", pattern: /\bcpp_std_\d+\b/iu },
  { token: "c_std", pattern: /\bc_std_\d+\b/iu },
  { token: "required_version", pattern: /\brequired_version\b/iu },
  { token: "required_providers", pattern: /\brequired_providers\b/iu },
  { token: "from", pattern: /^\s*from\s+\S+/iu, requiresNumeric: false },
  { token: "syntax=", pattern: /^\s*#\s*syntax\s*=/iu, requiresNumeric: false },
  { token: "swift-tools-version", pattern: /^\s*\/\/\s*swift-tools-version\s*:/iu },
  { token: "apiversion", pattern: /\bapiversion\b/iu, requiresNumeric: false },
  { token: "appversion", pattern: /\bappversion\b/iu, requiresNumeric: false },
  { token: "kubeversion", pattern: /\bkubeversion\b/iu },
  { token: "require-dbt-version", pattern: /\brequire-dbt-version\b/iu },
  { token: "syntax", pattern: /^\s*syntax\s*=/iu, requiresNumeric: false },
  { token: "openapi", pattern: /^\s*openapi\s*:/iu },
  { token: "swagger", pattern: /^\s*swagger\s*:/iu },
  { token: "schema", pattern: /^\s*schema\s*:/iu, requiresNumeric: false },
  { token: "generates", pattern: /^\s*generates\s*:/iu, requiresNumeric: false },
  { token: "required_ruby_version", pattern: /\brequired_ruby_version\b/iu },
  { token: "ruby", pattern: /^\s*ruby\s+["']/iu },
  { token: "php", pattern: /"php"\s*:/iu },
]);

const VERSION_DECLARATION_BY_TOKEN: ReadonlyMap<string, VersionTokenPattern> = new Map(
  VERSION_DECLARATION_TOKEN_PATTERNS.map((entry) => [entry.token, entry]),
);

// Registry-derived declaration-line recognizers used by the natural-language matcher. Matching is
// two-step: route the query to an ecosystem, then apply only that ecosystem's declaration patterns
// to candidate lines. This keeps generic words such as "target" or "schema" from becoming global
// boosts.
export const ecosystemVersionDeclarationPatterns: readonly EcosystemVersionDeclarationPattern[] =
  Object.freeze(
    ECOSYSTEMS.flatMap((eco) => {
      if (eco.routingTerms.length === 0) {
        return [];
      }
      const declarationPatterns = uniqueStrings(eco.contentTokens.map(lower))
        .map((token) => VERSION_DECLARATION_BY_TOKEN.get(token))
        .filter((entry): entry is VersionTokenPattern => entry !== undefined);
      return eco.routingTerms.flatMap((routingTerm) => {
        const routePattern = termToPattern(routingTerm);
        return declarationPatterns.map((entry) => ({
          ecosystem: eco.id,
          routePattern,
          declarationPattern: entry.pattern,
          requiresNumeric: entry.requiresNumeric ?? true,
        }));
      });
    }),
  );

// Every registered manifest/lockfile pattern, for the deny-list-disjointness test in
// ecosystems.test.ts. Suffix patterns are expressed as a representative "name.suffix" form.
export function allRegisteredFilePatterns(): readonly string[] {
  const names = ECOSYSTEMS.flatMap((eco) => [...eco.manifestNames, ...eco.lockfileNames]);
  const suffixes = ECOSYSTEMS.flatMap((eco) =>
    eco.manifestSuffixes.map((suffix) => `manifest${suffix}`),
  );
  return [...new Set([...names, ...suffixes])].sort();
}
