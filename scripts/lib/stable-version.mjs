// Stable release versions (MAJOR.MINOR.PATCH, an optional leading "v", no prerelease), shared by
// the release-impact gate and the support registry history so both read release tags identically.

/** The three numeric components, or undefined for anything that is not a stable version. */
export function parseStableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareStableVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return 0;
}
