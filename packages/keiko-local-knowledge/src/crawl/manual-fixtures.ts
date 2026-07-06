// Synthetic static HTML manual fixtures (Epic #1853, Issue #1876).
//
// Deterministic, hermetic, network-free fixtures that reproduce the legacy manual patterns expected
// in customer environments — index pages, nested chapters, framesets, relative + anchor links,
// duplicate links, tables, and code blocks — plus a hostile battery that exercises every denied-link
// class. They contain NO customer content, NO secrets, NO real hostnames, and NO private paths; the
// only host used is the synthetic `https://manual.test` (or bare relative paths for local manuals).

import type { InMemoryManualPage } from "./fetchers.js";

const ORIGIN = "https://manual.test";

function page(title: string, body: string): InMemoryManualPage {
  return {
    html: `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`,
  };
}

const INDEX_BODY = `
  <h1>Product Handbook</h1>
  <p>Welcome to the handbook. It documents installation, configuration, and troubleshooting.</p>
  <nav>
    <a href="chapters/install.html">Installation</a>
    <a href="chapters/config.html">Configuration</a>
    <a href="chapters/config.html#advanced">Advanced configuration</a>
    <a href="reference/api.html">API reference</a>
    <a href="chapters/install.html">Installation (duplicate)</a>
  </nav>`;

const INSTALL_BODY = `
  <h1>Installation</h1>
  <h2>Requirements</h2>
  <table><tr><th>Component</th><th>Version</th></tr><tr><td>Runtime</td><td>22</td></tr></table>
  <h2>Steps</h2>
  <p>Run the installer and follow the prompts to complete installation of the product.</p>
  <a href="../reference/api.html">See the API reference</a>
  <a href="config.html">Next: configuration</a>`;

const CONFIG_BODY = `
  <h1>Configuration</h1>
  <p>Configuration values are read from the settings file at startup and validated on load.</p>
  <h2 id="advanced">Advanced</h2>
  <pre><code>timeout = 15000
max_pages = 200</code></pre>
  <a href="install.html">Back to installation</a>`;

const API_BODY = `
  <h1>API reference</h1>
  <p>The API exposes read and write operations for managed resources over a documented contract.</p>
  <a href="../index.html">Home</a>`;

// A realistic multi-page manual whose pages are all in scope and link-reachable from the index.
export function legacyManualFixture(): ReadonlyMap<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    [`${ORIGIN}/`, page("Product Handbook", INDEX_BODY)],
    [`${ORIGIN}/chapters/install.html`, page("Installation", INSTALL_BODY)],
    [`${ORIGIN}/chapters/config.html`, page("Configuration", CONFIG_BODY)],
    [`${ORIGIN}/reference/api.html`, page("API reference", API_BODY)],
  ]);
}

const FRAMESET_INDEX = `
  <h1>Framed Manual</h1>
  <iframe src="content/toc.html"></iframe>
  <frame src="content/body.html">`;

// A frameset-style legacy manual: navigational content lives behind frame/iframe references.
export function framesetManualFixture(): ReadonlyMap<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    [`${ORIGIN}/`, page("Framed Manual", FRAMESET_INDEX)],
    [
      `${ORIGIN}/content/toc.html`,
      page("Contents", `<h1>Contents</h1><a href="body.html">Body</a>`),
    ],
    [
      `${ORIGIN}/content/body.html`,
      page("Body", `<h1>Body</h1><p>Framed body content paragraph.</p>`),
    ],
  ]);
}

// For an http manual the WHATWG URL parser normalises `../` within the origin, so filesystem
// traversal and hidden-file escapes are a LOCAL-scope concern (covered by the scope-guard unit
// suite). This http battery targets the classes that genuinely apply to a network origin.
const HOSTILE_INDEX = `
  <h1>Hostile Links</h1>
  <a href="https://evil.example/x.html">external origin</a>
  <a href="page.html?session=abc123token">query-token link</a>
  <a href="https://user:pass@manual.test/x.html">credentialed url</a>
  <a href="logout.html">logout action</a>
  <a href="mailto:ops@manual.test">mailto</a>
  <a href="javascript:steal()">javascript</a>
  <a href="assets/app.js">script asset</a>
  <a href="styles/site.css">stylesheet</a>
  <a href="safe.html">the one safe link</a>`;

// An index page linking to every denied-link class plus one legitimately in-scope page. Crawling it
// must accept exactly the index + `safe.html` and refuse the rest with stable reason codes.
export function hostileLinkFixture(): ReadonlyMap<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    [`${ORIGIN}/`, page("Hostile Links", HOSTILE_INDEX)],
    [
      `${ORIGIN}/safe.html`,
      page("Safe", `<h1>Safe</h1><p>A safe in-scope documentation page.</p>`),
    ],
    [
      `${ORIGIN}/page.html`,
      page("Query", `<h1>Query</h1><p>Reached via query variant, deduped.</p>`),
    ],
  ]);
}

// A malformed-HTML page (unclosed tags, stray brackets) the parser and link extractor must tolerate
// without throwing.
export function malformedManualFixture(): ReadonlyMap<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    [
      `${ORIGIN}/`,
      {
        html: `<html><head><title>Broken<body><h1>Broken manual<p>Unclosed paragraph
          <a href="ok.html">ok <a href=ok.html>dup unquoted</a> <div><span>text`,
      },
    ],
    [
      `${ORIGIN}/ok.html`,
      page("Ok", `<h1>Ok</h1><p>A recoverable page after malformed markup.</p>`),
    ],
  ]);
}

// A local-manual variant of the legacy fixture, keyed by root-relative path for the local fetcher.
export function localLegacyManualFixture(): ReadonlyMap<string, InMemoryManualPage> {
  return new Map<string, InMemoryManualPage>([
    ["index.html", page("Product Handbook", INDEX_BODY)],
    ["chapters/install.html", page("Installation", INSTALL_BODY)],
    ["chapters/config.html", page("Configuration", CONFIG_BODY)],
    ["reference/api.html", page("API reference", API_BODY)],
  ]);
}

export const MANUAL_FIXTURE_ORIGIN = ORIGIN;
