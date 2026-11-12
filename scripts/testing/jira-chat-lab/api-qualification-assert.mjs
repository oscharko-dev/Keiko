// Measured assertions: a drop-in for `node:assert/strict` that counts every assertion that held, so
// the grader can require that a readback actually asserted something instead of trusting a count
// the recipe declared. A failed assertion throws before it is counted.
import strict from "node:assert/strict";
import { URL } from "node:url";

const meter = { assertions: 0, nativeReads: 0, readPaths: [] };
/** Shared transport plumbing (status checks, id shapes) must not make a readback look asserted. */
export const plumbingAssert = strict;
/** One independent comparison made outside the counted helpers, e.g. a proven identical refusal. */
export const recordAssertion = () => {
  meter.assertions += 1;
};

/** Assertions that held since the last `resetAssertionCount`. */
export const measuredAssertionCount = () => meter.assertions;
export const resetAssertionCount = () => {
  meter.assertions = 0;
};
/** Successful independent native reads since the last `resetNativeReadCount`. */
export const measuredNativeReadCount = () => meter.nativeReads;
export const resetNativeReadCount = () => {
  meter.nativeReads = 0;
  meter.readPaths = [];
};
/** The resolved pathname (no query) of each successful native read, for the presence proof. */
export const measuredNativeReadPaths = () => [...new Set(meter.readPaths)].slice(0, 50);
export const recordNativeRead = (path) => {
  meter.nativeReads += 1;
  if (typeof path === "string") meter.readPaths.push(new URL(path, "http://lab.invalid").pathname);
};

function counted(assertion) {
  return function countedAssertion(...args) {
    const result = assertion(...args);
    if (result instanceof Promise)
      return result.then((value) => {
        meter.assertions += 1;
        return value;
      });
    meter.assertions += 1;
    return result;
  };
}
const SKIPPED = new Set(["AssertionError", "strict", "fail"]);
const assert = Object.assign(
  counted(strict),
  Object.fromEntries(
    Object.entries(strict)
      .filter(([name, value]) => typeof value === "function" && !SKIPPED.has(name))
      .map(([name, value]) => [name, counted(value)]),
  ),
  { AssertionError: strict.AssertionError, fail: strict.fail },
);
export default assert;
