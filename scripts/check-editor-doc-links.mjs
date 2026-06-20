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

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINK_PATTERN = /\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_PREFIX = /^(?:https?:|mailto:|tel:|#?\/\/|data:)/i;

export function collectDocFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = ["packages/keiko-editor/README.md"];
  files.push(...listMarkdown(repoRoot, "docs", (name) => name.startsWith("editor-")));
  files.push(...listMarkdownRecursive(repoRoot, "docs/keiko-editor"));
  files.push(...listMarkdown(repoRoot, "docs/release", (name) => name.startsWith("keiko-editor-")));
  return files.filter((file) => existsSync(join(repoRoot, file)));
}

function listMarkdown(repoRoot, dir, predicate) {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".md") && predicate(name))
    .map((name) => join(dir, name));
}

function listMarkdownRecursive(repoRoot, dir) {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  const out = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownRecursive(repoRoot, rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// GitHub heading-slug algorithm: lowercase, drop characters that are not word/space/hyphen, then map
// spaces to hyphens. Good enough for the simple, prose headings this doc set uses.
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

export function isWithinPath(root, candidate) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  const relativePath = relative(rootAbsolute, candidateAbsolute);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function anchorsFor(context, absoluteFile) {
  const cached = context.anchorCache.get(absoluteFile);
  if (cached !== undefined) return cached;
  const anchors = new Set();
  if (absoluteFile.endsWith(".md") && existsSync(absoluteFile)) {
    for (const line of readFileSync(absoluteFile, "utf8").split("\n")) {
      const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (match) anchors.add(slug(match[1]));
    }
  }
  context.anchorCache.set(absoluteFile, anchors);
  return anchors;
}

function fail(context, file, link, reason) {
  context.failures.push(`${file}: ${link} — ${reason}`);
}

function checkAnchor(context, file, link, targetFile, displayTargetFile, anchor) {
  if (anchor === "" || !targetFile.endsWith(".md")) return;
  if (!anchorsFor(context, targetFile).has(anchor)) {
    fail(
      context,
      file,
      link,
      `anchor "#${anchor}" not found in ${relative(context.repoRootAbsolute, displayTargetFile)}`,
    );
  }
}

function containedTarget(context, file, link, targetFile) {
  const targetAbsolute = resolve(targetFile);
  if (!isWithinPath(context.repoRootAbsolute, targetAbsolute)) {
    fail(context, file, link, "target path escapes repository");
    return undefined;
  }
  if (!existsSync(targetAbsolute)) {
    fail(context, file, link, "target path does not exist");
    return undefined;
  }
  const targetReal = realpathSync(targetAbsolute);
  if (!isWithinPath(context.repoRootReal, targetReal)) {
    fail(context, file, link, "target realpath escapes repository");
    return undefined;
  }
  return { targetAbsolute, targetReal };
}

function checkLink(context, file, absoluteDir, rawLink) {
  if (EXTERNAL_PREFIX.test(rawLink)) return;
  const [pathPart, anchor = ""] = rawLink.split("#");
  if (pathPart === "") {
    const currentFile = join(context.repoRootAbsolute, file);
    checkAnchor(context, file, rawLink, realpathSync(currentFile), currentFile, anchor);
    return;
  }
  const target = containedTarget(context, file, rawLink, resolve(absoluteDir, pathPart));
  if (target === undefined) return;
  if (statSync(target.targetReal).isDirectory()) return;
  checkAnchor(context, file, rawLink, target.targetReal, target.targetAbsolute, anchor);
}

function checkFile(context, file) {
  const absolute = join(context.repoRootAbsolute, file);
  const absoluteDir = dirname(absolute);
  const content = readFileSync(absolute, "utf8");
  for (const match of content.matchAll(LINK_PATTERN)) {
    checkLink(context, file, absoluteDir, match[1]);
  }
}

function reportResult({ failures, files, log, error }) {
  if (failures.length > 0) {
    error(`Editor documentation link check failed (${failures.length.toString()}):`);
    for (const failure of failures) {
      error(`  - ${failure}`);
    }
    return { ok: false, failures, fileCount: files.length };
  }

  log(
    `Editor documentation link check passed: ${files.length.toString()} files, all relative links and anchors resolve.`,
  );
  return { ok: true, failures, fileCount: files.length };
}

export function runEditorDocLinkCheck({
  repoRoot = DEFAULT_REPO_ROOT,
  files = collectDocFiles(repoRoot),
  log = console.log,
  error = console.error,
} = {}) {
  const repoRootAbsolute = resolve(repoRoot);
  const context = {
    repoRootAbsolute,
    repoRootReal: realpathSync(repoRootAbsolute),
    anchorCache: new Map(),
    failures: [],
  };

  for (const file of files) {
    checkFile(context, file);
  }

  return reportResult({ failures: context.failures, files, log, error });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runEditorDocLinkCheck();
  if (!result.ok) process.exit(1);
}
