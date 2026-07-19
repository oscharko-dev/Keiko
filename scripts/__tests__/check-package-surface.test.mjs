import assert from "node:assert/strict";
import test from "node:test";

import { NPM_PACK_STDIO_MAX_BUFFER, packFiles } from "../package-surface-pack.mjs";

function largePackJson() {
  const files = [
    {
      path: "dist/index.js",
      size: 1,
      mode: 0o644,
    },
  ];
  const padding = "x".repeat(1024 * 1024 + 32);
  return JSON.stringify([{ files, padding }]);
}

test("parses valid npm-pack JSON larger than the default spawnSync buffer", () => {
  let observed;
  const files = packFiles({
    spawnSyncImpl: (command, args, options) => {
      observed = { command, args, options };
      return {
        status: 0,
        stdout: largePackJson(),
        stderr: "",
      };
    },
    platform: "linux",
    processEnv: {
      PATH: "/bin",
      npm_command: "run-script",
      npm_lifecycle_event: "check:package-surface",
      npm_lifecycle_script: "node scripts/check-package-surface.mjs",
      npm_package_json: "/repo/package.json",
    },
    resolveHostExecutableImpl: () => "/usr/bin/npm",
  });

  assert.deepEqual(files, [{ path: "dist/index.js", size: 1, mode: 0o644 }]);
  assert.equal(observed.command, "/usr/bin/npm");
  assert.deepEqual(observed.args, ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  assert.equal(observed.options.maxBuffer, NPM_PACK_STDIO_MAX_BUFFER);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.env.PATH, "/bin");
  assert.equal(Object.hasOwn(observed.options.env, "npm_command"), false);
  assert.equal(Object.hasOwn(observed.options.env, "npm_lifecycle_event"), false);
  assert.equal(Object.hasOwn(observed.options.env, "npm_lifecycle_script"), false);
  assert.equal(Object.hasOwn(observed.options.env, "npm_package_json"), false);
});
