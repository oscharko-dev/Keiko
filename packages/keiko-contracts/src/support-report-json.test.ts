import { describe, expect, it } from "vitest";
import { canonicalSupportJson } from "./support-report-json.js";

describe("canonical support JSON ordering", () => {
  it("uses ascending array-index keys before UTF-16-sorted ordinary object keys", () => {
    expect(
      canonicalSupportJson({ z: true, "10": "ten", "9": "nine", "01": "one", A: null, a: false }),
    ).toBe('{"9":"nine","10":"ten","01":"one","A":null,"a":false,"z":true}');
  });

  it("keeps the ECMAScript array-index boundary and nested ordering deterministic", () => {
    expect(
      canonicalSupportJson({
        z: { "10": true, "9": false },
        "4294967295": "ordinary",
        "4294967294": "index",
        "01": null,
      }),
    ).toBe('{"4294967294":"index","01":null,"4294967295":"ordinary","z":{"9":false,"10":true}}');
  });
});
