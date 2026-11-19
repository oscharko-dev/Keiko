import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenarioDirectory, scenarioSetManifest } from "../testing/memory-lab/scenario.mjs";
import { INSTRUMENT_FILES } from "../testing/memory-lab/instrument.mjs";

const root = fileURLToPath(new URL("../testing/memory-lab/controls", import.meta.url));
const binding = JSON.parse(readFileSync(join(root, "bindings.json"), "utf8"));

describe("preregistered public Memory lab controls", () => {
  it.each(binding.controls)(
    "preserves the byte and raw/loaded corpus bindings for $label",
    (control) => {
      const directory = join(root, control.label);
      const files = readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .sort();
      expect(files).toEqual(control.files.map((file) => file.file).sort());
      const raw = control.files.map((file) => {
        const bytes = readFileSync(join(directory, file.file));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
        return JSON.parse(bytes.toString("utf8"));
      });
      expect(scenarioSetManifest(raw).setDigest).toBe(control.rawSetDigest);
      const loaded = scenarioSetManifest(loadScenarioDirectory(directory));
      expect(loaded.count).toBe(control.scenarioCount);
      expect(loaded.setDigest).toBe(control.loadedSetDigest);
      expect(
        new Set([control.rawSetDigest, control.loadedSetDigest]).has(control.registeredDigest),
      ).toBe(true);
    },
  );

  it("keeps these explicit control sets separate from the default corpus and instrument", () => {
    const defaults = loadScenarioDirectory(
      fileURLToPath(new URL("../testing/memory-lab/scenarios", import.meta.url)),
    );
    const defaultIds = new Set(defaults.map((scenario) => scenario.id));
    for (const control of binding.controls) {
      for (const scenario of loadScenarioDirectory(join(root, control.label))) {
        expect(defaultIds.has(scenario.id)).toBe(false);
      }
    }
    expect(INSTRUMENT_FILES.some((file) => file.startsWith("controls/"))).toBe(false);
  });
});
