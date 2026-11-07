import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp } from "./index.js";

test("clamp keeps a value inside the range", () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-5, 1, 10), 1);
  assert.equal(clamp(50, 1, 10), 10);
});
