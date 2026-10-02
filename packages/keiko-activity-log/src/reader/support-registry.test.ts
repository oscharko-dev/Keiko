import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { analyzeLogText } from "./support-analyze.js";
import { CURRENT_SUPPORT_REGISTRY, findSupportRegistry } from "./support-registry.js";

function preMoveLines(): string {
  const packed = JSON.parse(
    readFileSync(
      new URL("../activity-log-compatibility-3558.fixture.json", import.meta.url),
      "utf8",
    ),
  ) as { payload: string };
  const fixture = JSON.parse(
    gunzipSync(Buffer.from(packed.payload, "base64")).toString("utf8"),
  ) as { files: { name: string; bytes: string }[] };
  return fixture.files
    .filter((file) => file.name.endsWith(".jsonl"))
    .map((file) => Buffer.from(file.bytes, "base64").toString("utf8"))
    .join("");
}

describe("version-matched support registry", () => {
  it("reconstructs the frozen pre-move production evidence against its recorded registry", () => {
    const text = preMoveLines();
    const identity = JSON.parse(text.split("\n")[0] ?? "") as {
      registryVersion: number;
      schemaDigest: string;
      catalogDigest: string;
    };
    const registry = findSupportRegistry(identity);
    expect(registry).toBeDefined();
    if (registry === undefined) throw new TypeError("missing archived registry");
    // Without a registry each line is judged by the supported release registry it records, so
    // the pre-upgrade evidence stays evidence. An explicit registry is never overridden.
    expect(analyzeLogText(text).evidence.classification).toBe("supported");
    expect(
      analyzeLogText(text, { registry: CURRENT_SUPPORT_REGISTRY }).evidence.classification,
    ).toBe("unsupported");
    const result = analyzeLogText(text, { registry });
    expect(result.evidence.unsupportedLineCount).toBe(0);
    expect(result.malformedLineCount).toBe(0);
    expect(result.timelines.length).toBeGreaterThan(0);
    expect(result.sufficiency.status).toBe("complete");
  });

  it("refuses an unknown catalog rather than accepting a reporter schema", () => {
    expect(
      findSupportRegistry({
        registryVersion: 1,
        schemaDigest: "0".repeat(64),
        catalogDigest: "0".repeat(64),
      }),
    ).toBeUndefined();
  });
});
