// Decides whether a change set is documentation only, for CI cost scoping (Issue #2699).
//
// Deliberately conservative and allow-listed: a path is documentation only when it matches one of
// the patterns below. Anything unrecognised — a new top-level file, a config, a script, a lockfile —
// makes the whole change set non-documentation, so an unfamiliar path can only ever cause MORE
// checking, never less. Skipping a gate for something that turns out to be code is the one failure
// mode this must not have.

const DOCUMENTATION_PATTERNS = Object.freeze([
  /^docs\/(?!qa\/package-coverage-baseline\.json$)(?!release\/).*\.md$/u,
  /^docs\/adr\/.*\.md$/u,
  /^[^/]*\.md$/u,
  // CODEOWNERS is deliberately NOT here. It is governance configuration: a change to it changes who
  // must approve what, so it must never buy a reduced check matrix.
  /^\.github\/(?:ISSUE_TEMPLATE\/.*|pull_request_template\.md)$/u,
  /^LICENSE$/u,
]);

/**
 * True when every changed path is documentation. An empty change set is NOT documentation-only:
 * that means detection failed, and the safe answer is to run everything.
 */
export function isDocumentationOnlyChange(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return false;
  return changedPaths.every(
    (path) =>
      typeof path === "string" &&
      path.length > 0 &&
      DOCUMENTATION_PATTERNS.some((pattern) => pattern.test(path)),
  );
}
