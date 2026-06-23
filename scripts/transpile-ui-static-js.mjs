// Post-process the exported Next.js UI bundle for the packaged local PWA runtime. Next 16's
// production output and some dependency chunks can contain ES2020+ syntax; the local customer
// install path serves these files directly to Chromium-family browsers that may lag behind current
// evergreen baselines.

import { transformAsync } from "@babel/core";
import presetEnv from "@babel/preset-env";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATIC_ROOT = join(repoRoot, "dist", "ui", "static");

const TARGETS = {
  chrome: "79",
  edge: "79",
  firefox: "72",
  safari: "13.1",
};

async function collectJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

async function transformJavaScript(file) {
  const source = await readFile(file, "utf8");
  const result = await transformAsync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    browserslistConfigFile: false,
    comments: false,
    compact: true,
    sourceMaps: false,
    presets: [
      [
        presetEnv,
        {
          targets: TARGETS,
          modules: false,
          useBuiltIns: false,
        },
      ],
    ],
  });

  if (typeof result?.code !== "string" || result.code.length === 0) {
    throw new Error(`Babel returned no code for ${file}`);
  }
  if (result.code !== source) {
    await writeFile(file, result.code, "utf8");
    return true;
  }
  return false;
}

export async function transpileUiStaticJavaScript(staticRoot = DEFAULT_STATIC_ROOT) {
  const files = await collectJavaScriptFiles(staticRoot);
  let changed = 0;
  for (const file of files) {
    if (await transformJavaScript(file)) {
      changed += 1;
    }
  }
  console.log(
    `UI static JavaScript transpile: ${String(changed)} of ${String(
      files.length,
    )} file(s) updated for Chromium/Edge 79+`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await transpileUiStaticJavaScript(process.argv[2] ?? DEFAULT_STATIC_ROOT);
}
