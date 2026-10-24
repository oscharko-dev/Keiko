import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { isUiStaticPathContained } from "./ui-static-root-boundary.mjs";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
  ".map": "application/json",
};

async function readContainedAsset(root, file) {
  const canonical = await realpath(file);
  if (!isUiStaticPathContained(root, canonical)) return { status: 403, body: "forbidden" };
  return { status: 200, body: await readFile(file), file };
}

async function fixtureAsset(root, url) {
  const requested = decodeURIComponent((url ?? "/").split("?")[0]);
  const safe = normalize("/" + (requested === "/" ? "index.html" : requested));
  let file = join(root, safe);
  if (!isUiStaticPathContained(root, file)) return { status: 403, body: "forbidden" };
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    // Missing files still take the original extension fallback below.
  }
  try {
    return await readContainedAsset(root, file);
  } catch {
    try {
      return await readContainedAsset(root, file + ".html");
    } catch {
      return { status: 404, body: "not found" };
    }
  }
}

export async function createUiStaticFixtureServer(root) {
  const canonical = await realpath(root);
  return createServer(async (request, response) => {
    try {
      const asset = await fixtureAsset(canonical, request.url);
      response.writeHead(asset.status, {
        "content-type": asset.file
          ? MIME[extname(asset.file)] || "application/octet-stream"
          : "text/plain",
        ...(asset.status === 200 ? { "cache-control": "no-store" } : {}),
      });
      response.end(asset.body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("internal error");
    }
  });
}

export function listenUiStaticFixtureServer(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function loadThemedUiFixture(page, url, mode) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(
    ({ theme, hc }) => {
      const root = globalThis.document.documentElement;
      root.dataset.theme = theme;
      delete root.dataset.hc;
      if (hc) root.dataset.hc = hc;
    },
    { theme: mode.theme, hc: mode.hc },
  );
  await page.waitForTimeout(900);
}
