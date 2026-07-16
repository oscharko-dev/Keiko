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
    // ADR-0139 D1: the official producer is a controlled measurement context, so the browser
    // suites enforce their wall-clock budgets here; required CI runners leave the flag unset
    // and only record the measured values.
    KEIKO_ENFORCE_WALL_CLOCK_BUDGETS: "1",
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
