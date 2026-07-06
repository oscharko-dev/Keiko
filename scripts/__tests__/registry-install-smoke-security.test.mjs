import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const ROOT_MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

describe("registry install smoke security posture", () => {
  it("does not disable TLS verification for npm, yarn, or Node", () => {
    const source = readFileSync(join(ROOT, "scripts", "registry-install-smoke.mjs"), "utf8");

    expect(source).toContain("strict-ssl=true");
    expect(source).toContain("enableStrictSsl: true");
    expect(source).not.toContain("strict-ssl=false");
    expect(source).not.toContain("enableStrictSsl: false");
    expect(source).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed");
  });

  it("skips yarn when the root package bundles private runtime workspaces", () => {
    const binDir = mkdtempSync(join(tmpdir(), "keiko-registry-smoke-bin-"));
    try {
      writeExecutable(
        join(binDir, "npm"),
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { join } from "node:path";',
          "const version = process.env.ROOT_VERSION;",
          "const bundled = JSON.parse(process.env.BUNDLED_DEPS ?? '[]');",
          "const root = join(process.cwd(), 'node_modules', '@oscharko-dev', 'keiko');",
          "mkdirSync(join(root, 'dist', 'cli'), { recursive: true });",
          "writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));",
          "writeFileSync(join(root, 'dist', 'index.js'), `export const SDK_VERSION = ${JSON.stringify(version)};\\n`);",
          "writeFileSync(",
          "  join(root, 'dist', 'cli', 'index.js'),",
          "  `if (process.argv.includes('--version')) console.log('${version}'); else if (process.argv.includes('--help')) console.log('help'); else process.exit(2);\\n`,",
          ");",
          "for (const name of bundled) {",
          "  const shortName = name.replace(/^@oscharko-dev\\//u, '');",
          "  const dist = join(root, 'node_modules', '@oscharko-dev', shortName, 'dist');",
          "  mkdirSync(dist, { recursive: true });",
          "  writeFileSync(join(dist, 'index.js'), 'export {};\\n');",
          "}",
        ].join("\n"),
      );
      writeExecutable(
        join(binDir, "corepack"),
        "process.stderr.write('corepack must not run for root-only bundled package\\n'); process.exit(91);",
      );

      const result = spawnSync(process.execPath, ["scripts/registry-install-smoke.mjs"], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          BUNDLED_DEPS: JSON.stringify(ROOT_MANIFEST.bundleDependencies),
          KEIKO_REGISTRY_INSTALL_PACKAGE: `${ROOT_MANIFEST.name}@${ROOT_MANIFEST.version}`,
          KEIKO_REGISTRY_URL: "https://registry.npmjs.org/",
          ROOT_VERSION: ROOT_MANIFEST.version,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "registry-install-smoke: yarn check skipped (root-only package bundles private runtime workspaces).",
      );
      expect(result.stdout).toContain(
        `registry-install-smoke: PASS - ${ROOT_MANIFEST.name}@${ROOT_MANIFEST.version} installs`,
      );
      expect(result.stderr).not.toContain("corepack must not run");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("installable package smoke optional-dependency coverage", () => {
  it("keeps an explicit optional-dependency install mode", () => {
    const source = readFileSync(join(ROOT, "scripts", "installable-package-smoke.mjs"), "utf8");
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    expect(source).toContain("--include-optional");
    expect(source).toContain("--omit=optional");
    expect(manifest.scripts["smoke:install:optional"]).toBe(
      "node scripts/installable-package-smoke.mjs --include-optional",
    );
  });

  it("keeps Windows install timeout explicit and operator-tunable", () => {
    const source = readFileSync(join(ROOT, "scripts", "installable-package-smoke.mjs"), "utf8");

    expect(source).toContain("const WINDOWS_NPM_INSTALL_TIMEOUT_MS = 600_000;");
    expect(source).toContain("KEIKO_SMOKE_INSTALL_TIMEOUT_MS");
    expect(source).toContain("must be a positive integer number of milliseconds");
  });
});

describe("release publish security posture", () => {
  it("requires TLS verification and npm provenance on the real publish path", () => {
    const source = readFileSync(join(ROOT, "scripts", "release-publish.mjs"), "utf8");
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

    expect(source).toContain("strict-ssl=false is not allowed");
    expect(source).toContain("--provenance");
    expect(workflow).toMatch(/publish:[\s\S]*permissions:[\s\S]*id-token:\s*write/u);
  });
});
