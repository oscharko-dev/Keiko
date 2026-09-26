// Post-process the exported Next.js UI bundle for the packaged local PWA runtime. Next 16's
// production output and some dependency chunks can contain ES2020+ syntax; the local customer
// install path serves these files directly to Chromium-family browsers that may lag behind current
// evergreen baselines.

import { transformAsync } from "@babel/core";
import presetEnv from "@babel/preset-env";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  rejectUiStaticRootCliOverride,
  rejectUiStaticSymlink,
  resolveUiStaticRoot,
} from "./lib/ui-static-root-boundary.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATIC_ROOT = join(repoRoot, "dist", "ui", "static");

// The SYNTAX floor Babel lowers the exported bundle to. Deliberately BELOW keiko-ui's
// `browserslist` declaration, which is the floor at which the app actually WORKS: browserslist is
// bounded by the runtime APIs the UI calls (`Array.prototype.at`, `crypto.randomUUID`,
// `AbortSignal.timeout`, …) and this pass does not polyfill them — `useBuiltIns: false` below emits
// no core-js imports, so it can only lower syntax, never add a missing builtin.
//
// Keeping this floor lower is therefore deliberate slack, not drift: transpiling further down than
// the supported range costs a little bundle size and guarantees that a browser inside the declared
// range can always PARSE the output. The dangerous direction is the opposite one — a floor ABOVE
// the declaration would emit syntax a declared-supported browser cannot parse, which is a blank
// page rather than a degraded feature. `npm run check:browser-baseline` enforces exactly that
// direction, so these two numbers can never silently cross.
export const TARGETS = {
  chrome: "79",
  edge: "79",
  firefox: "72",
  safari: "13.1",
};

async function collectJavaScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    rejectUiStaticSymlink(entry);
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
  const trustedStaticRoot = await resolveUiStaticRoot(repoRoot, staticRoot);
  const files = await collectJavaScriptFiles(trustedStaticRoot);
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

export async function runTranspileUiStaticJavaScriptCli(
  args,
  operation = transpileUiStaticJavaScript,
) {
  rejectUiStaticRootCliOverride(args[0]);
  await operation();
}

if (isMainModule(import.meta.url)) {
  await runTranspileUiStaticJavaScriptCli(process.argv.slice(2));
}
