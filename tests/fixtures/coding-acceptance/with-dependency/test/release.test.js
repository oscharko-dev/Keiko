import assert from "node:assert/strict";
import { test } from "node:test";

import { newestStable } from "../src/release.js";

test("the newest stable release is chosen by version, not by text", () => {
  assert.equal(newestStable(["1.2.0", "1.10.0", "1.9.3"]), "1.10.0");
});

test("a pre-release is never the newest stable release", () => {
  assert.equal(newestStable(["1.2.0", "2.0.0-rc.1"]), "1.2.0");
});

test("no stable release gives undefined", () => {
  assert.equal(newestStable(["2.0.0-rc.1"]), undefined);
});
