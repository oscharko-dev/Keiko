import assert from "node:assert/strict";

/** Catalog JSON may use null prototypes. Compare its JSON value, preserving every array element. */
export function assertQualificationJson(actual, expected, message) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(actual)),
    JSON.parse(JSON.stringify(expected)),
    message,
  );
}
