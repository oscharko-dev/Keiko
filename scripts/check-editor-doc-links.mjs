// Keiko Editor documentation link gate (Issue #1208).
//
// The repository has no general Markdown link checker, so this is the targeted local equivalent the
// editor-documentation issue requires (Expected Verification: "Markdown link check or targeted
// equivalent"; Acceptance Criterion: "Links are valid"). It validates every relative Markdown link in
// the Keiko Editor documentation set:
//
//   1. Relative link targets resolve to a file that exists on disk.
//   2. In-document and cross-document `#anchor` fragments match a heading in the target Markdown file
//      (GitHub-style heading slugs), so a renamed or removed heading is caught.
//
// External links (http/https/mailto/tel) and protocol-relative URLs are intentionally not fetched —
// this gate is deterministic and offline, like the rest of the Keiko verification surface. Run it with
// `npm run check:editor-doc-links`; a broken link or dangling anchor exits non-zero and names the
// offending file, link, and reason.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The curated Keiko Editor documentation set this gate owns.
const DOC_FILES = collectDocFiles();

const LINK_PATTERN = /\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_PREFIX = /^(?:https?:|mailto:|tel:|#?\/\/|data:)/i;
const failures = [];

function collectDocFiles() {
  const files = ["packages/keiko-editor/README.md"];
  files.push(...listMarkdown("docs", (name) => name.startsWith("editor-")));
  files.push(...listMarkdownRecursive("docs/keiko-editor"));
  files.push(...listMarkdown("docs/release", (name) => name.startsWith("keiko-editor-")));
  return files.filter((file) => existsSync(join(repoRoot, file)));
}

function listMarkdown(dir, predicate) {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".md") && predicate(name))
    .map((name) => join(dir, name));
}

function listMarkdownRecursive(dir) {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownRecursive(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// GitHub heading-slug algorithm: lowercase, drop characters that are not word/space/hyphen, then map
// spaces to hyphens. Good enough for the simple, prose headings this doc set uses.
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

const anchorCache = new Map();

function anchorsFor(absoluteFile) {
  const cached = anchorCache.get(absoluteFile);
  if (cached !== undefined) return cached;
  const anchors = new Set();
  if (absoluteFile.endsWith(".md") && existsSync(absoluteFile)) {
    for (const line of readFileSync(absoluteFile, "utf8").split("\n")) {
      const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (match) anchors.add(slug(match[1]));
    }
  }
  anchorCache.set(absoluteFile, anchors);
  return anchors;
}

function fail(file, link, reason) {
  failures.push(`${file}: ${link} — ${reason}`);
}

function checkAnchor(file, link, targetFile, anchor) {
  if (anchor === "" || !targetFile.endsWith(".md")) return;
  if (!anchorsFor(targetFile).has(anchor)) {
    fail(file, link, `anchor "#${anchor}" not found in ${relative(repoRoot, targetFile)}`);
  }
}

function checkLink(file, absoluteDir, rawLink) {
  if (EXTERNAL_PREFIX.test(rawLink)) return;
  const [pathPart, anchor = ""] = rawLink.split("#");
  if (pathPart === "") {
    checkAnchor(file, rawLink, join(repoRoot, file), anchor);
    return;
  }
  const targetFile = resolve(absoluteDir, pathPart);
  if (!existsSync(targetFile)) {
    fail(file, rawLink, "target path does not exist");
    return;
  }
  if (statSync(targetFile).isDirectory()) return;
  checkAnchor(file, rawLink, targetFile, anchor);
}

function checkFile(file) {
  const absolute = join(repoRoot, file);
  const absoluteDir = dirname(absolute);
  const content = readFileSync(absolute, "utf8");
  for (const match of content.matchAll(LINK_PATTERN)) {
    checkLink(file, absoluteDir, match[1]);
  }
}

for (const file of DOC_FILES) {
  checkFile(file);
}

if (failures.length > 0) {
  console.error(`Editor documentation link check failed (${failures.length.toString()}):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Editor documentation link check passed: ${DOC_FILES.length.toString()} files, all relative links and anchors resolve.`,
);
