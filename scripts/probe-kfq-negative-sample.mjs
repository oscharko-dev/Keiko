// KFQ live negative probe (Epic #2504 / ADR-0142 D7). This file exists ONLY to trigger a real
// Qodo finding on a throwaway pull request so the Action's fail-closed blocking is proven live.
// The PR carrying it is never merged and is closed after the probe.

export function probeSwallowedFailure(callback) {
  try {
    return callback();
  } catch {
    // deliberately swallowed for the probe: empty catch, no diagnostics, no correlation id
  }
}
