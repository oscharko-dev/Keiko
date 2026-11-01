// Builds the Jira draft preview harness with Vite and serves it on loopback. It starts no Keiko
// server, model or Jira: it exists so layout is measured in a real browser on the real styles.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { writeProductDesignTokens } from "../../../../packages/keiko-ui/design-tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const ui = join(root, "packages", "keiko-ui");
const port = Number(process.env.KEIKO_E2E_DRAFT_PORT ?? "32384");
const out = mkdtempSync(join(tmpdir(), "keiko-jira-draft-layout-"));

// globals.css imports the generated product tokens; produce them exactly as the UI build does.
writeProductDesignTokens(root);
await build({
  root: here,
  configFile: false,
  // The product modules carry Next.js "use client" directives, which a plain bundle ignores.
  logLevel: "error",
  publicDir: join(ui, "public"),
  resolve: { alias: { "@": join(ui, "src") } },
  esbuild: { jsx: "automatic" },
  build: { outDir: out, emptyOutDir: true, minify: false, sourcemap: false },
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};
const server = createServer((request, response) => {
  const path = normalize(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  const file = join(out, path === "/" ? "index.html" : path);
  try {
    if (!file.startsWith(out) || !statSync(file).isFile()) throw new RangeError("not a file");
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(port, "127.0.0.1", ready));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
