// Decides whether a change set can affect the Windows CI smoke matrix leg (#3519).
//
// Deliberately conservative and fail-open: paths that are unknown to this classifier are treated
// as Windows-relevant. A path may return false only when it is part of a known surface already
// covered by the Linux/macOS lanes or by other required jobs.

const WINDOWS_RELEVANT_PATTERNS = Object.freeze([
  /^\.github\/workflows\/ci\.yml$/u,
  /^native\//u,
  /^packages\/keiko-git\/src\/git-executable(?:\.test)?\.ts$/u,
  /^packages\/keiko-security\/src\/windows-[^/]+(?:\.test)?\.ts$/u,
  /^packages\/keiko-tools\/src\/windows-shell(?:\.test)?\.ts$/u,
  /^packages\/keiko-server\/src\/update-portable-handoff(?:-[^/]+)?(?:\.test)?\.ts$/u,
  /^packages\/keiko-server\/src\/update-portable-windows-[^/]+(?:\.test)?\.ts$/u,
  /^packages\/keiko-server\/src\/coding-runtime\/windows[^/]*(?:\.test)?\.ts$/u,
  /^packages\/keiko-server\/src\/coding-runtime\/windows-[^/]+\.cs$/u,
  /^scripts\/check-windows-[^/]+$/u,
  /^scripts\/windows-[^/]+$/u,
  /^scripts\/verify-windows-[^/]+$/u,
  /^scripts\/generate-windows-[^/]+$/u,
  /^scripts\/qualify-windows-[^/]+$/u,
  /^scripts\/build-windows-[^/]+$/u,
  /^scripts\/build-secure-workspace-read\.mjs$/u,
  /^scripts\/build-runtime-supervisor\.mjs$/u,
  /^scripts\/stage-portable-runtime\.mjs$/u,
  /^scripts\/lib\/windows-[^/]+\.mjs$/u,
  /^scripts\/native-quality\/windows-[^/]+$/u,
  /^scripts\/__tests__\/windows-[^/]+$/u,
  /^scripts\/__tests__\/check-windows-[^/]+$/u,
  /^scripts\/__tests__\/generate-windows-[^/]+$/u,
  /^scripts\/__tests__\/qualify-windows-[^/]+$/u,
  /^scripts\/__tests__\/verify-windows-[^/]+$/u,
  /^scripts\/__tests__\/build-runtime-supervisor\.test\.mjs$/u,
  /^scripts\/__tests__\/build-secure-workspace-read\.test\.mjs$/u,
  /^scripts\/__tests__\/check-windows-native-quality\.test\.mjs$/u,
  /^scripts\/__tests__\/fixtures\/windows-[^/]+\.json$/u,
]);

const KNOWN_IRRELEVANT_PATTERNS = Object.freeze([
  /^docs\//u,
  /^[^/]+\.md$/u,
  /^\.github\/(?:ISSUE_TEMPLATE\/.*|pull_request_template\.md)$/u,
  /^\.github\/(?:dependabot\.yml|zizmor\.yml)$/u,
  /^\.coderabbit\.yaml$/u,
  /^\.gitleaks\.toml$/u,
  /^\.gitignore$/u,
  /^\.prettier(?:ignore|rc(?:\.json)?)$/u,
  /^eslint\.config\./u,
  /^package(?:-lock)?\.json$/u,
  /^release-impact\.catalog\.json$/u,
  /^tsconfig(?:\.[^/]+)?\.json$/u,
  /^vitest\.config\.ts$/u,
  /^packages\/keiko-ui\//u,
  /^src\//u,
  /^tests\//u,
]);

function isRecognizedIrrelevantPath(path) {
  return KNOWN_IRRELEVANT_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * True when any changed path needs the Windows smoke matrix leg. Empty or malformed change sets
 * are relevant because they mean detection failed.
 */
export function isWindowsRelevantChange(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((path) => {
    if (typeof path !== "string" || path.length === 0) return true;
    if (WINDOWS_RELEVANT_PATTERNS.some((pattern) => pattern.test(path))) return true;
    return !isRecognizedIrrelevantPath(path);
  });
}
