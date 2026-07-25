const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
]);

function copyStringEnvironment(source, keys) {
  const environment = {};
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key].length > 0) {
      environment[key] = source[key];
    }
  }
  return environment;
}

export function createD12RuntimeEnvironment(source = process.env, additions = {}) {
  const environment = {
    ...copyStringEnvironment(source, INHERITED_ENVIRONMENT_KEYS),
    // ADR-0139 D1: the official producer measures at full sample depth so the percentiles it
    // records are meaningful. It does NOT also judge them. `ubuntu-latest` is shared hardware —
    // the lane's own comments record the ten-sample loop timing out there — so an in-measurement
    // wall-clock assertion turns one noisy neighbour into a lane that produces no evidence at all,
    // which is how every regeneration between 2026-07-19 and 2026-07-25 failed (54ms against a
    // 50ms cap). The verdict belongs to check-perf-evidence.mjs, which evaluates the SAME budgets
    // against the committed document and reports an overrun instead of destroying the run.
    KEIKO_D12_FULL_SAMPLE_DEPTH: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    TZ: "UTC",
    ...copyStringEnvironment(additions, Object.keys(additions)),
  };
  if (environment.PATH === undefined || environment.HOME === undefined) {
    throw new Error("D12 runtime environment requires explicit PATH and HOME values");
  }
  return environment;
}
