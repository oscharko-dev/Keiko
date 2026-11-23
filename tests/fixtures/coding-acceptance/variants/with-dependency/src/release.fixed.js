import semver from "semver";

/**
 * The newest stable release among `versions`, or `undefined` when there is none.
 *
 * @param {readonly string[]} versions
 * @returns {string | undefined}
 */
export function newestStable(versions) {
  const stable = versions.filter(
    (version) => semver.valid(version) !== null && semver.prerelease(version) === null,
  );
  return stable.sort(semver.rcompare)[0];
}
