import { describe, expect, it } from "vitest";
import { hash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { copyNativePolicyFixtureSources } from "./support/code-quality-fixture.mjs";

const HISTORICAL_NATIVE_SOURCES = [
  {
    name: "host.mjs",
    bytes: 12620,
    sha256: "700bb4cae8d5befdc7f6b62cd3a651fdc1c75de73256c82820863246cbd48142",
  },
  {
    name: "entry.mjs",
    bytes: 3897,
    sha256: "0181a4b900ec128a29ea58e3ea1b19ce9da26d1bda7d2f13cb093a19587a96ec",
  },
  {
    name: "guard-seams.mjs",
    bytes: 18289,
    sha256: "6f341fa12e05e3b929866057757fee95a2629c5a5285181ba6a521f8fd0e301e",
  },
];

describe("historical native analyzer fixture loader", () => {
  it("copies exact archived inputs without requiring the retired product owner", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-retired-native-policy-"));
    try {
      expect(() => copyNativePolicyFixtureSources(root)).not.toThrow();
      const owner = join(root, "native/opencode-service-host");
      expect(readdirSync(owner).sort()).toEqual(["entry.mjs", "guard-seams.mjs", "host.mjs"]);
      for (const source of HISTORICAL_NATIVE_SOURCES) {
        const bytes = readFileSync(join(owner, source.name));
        const archived = readFileSync(
          new URL(
            `./fixtures/code-quality-retired-native-host/${source.name}.txt`,
            import.meta.url,
          ),
        );
        expect(bytes).toEqual(archived);
        expect(bytes.length).toBe(source.bytes);
        expect(hash("sha256", bytes, "hex")).toBe(source.sha256);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
