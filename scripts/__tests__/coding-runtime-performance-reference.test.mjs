import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCodingPerformanceReference } from "../coding-runtime-performance-producer.mjs";
import { EXPECTED_NODE_BASELINE, EXPECTED_NPM_ENGINE } from "../check-runtime-toolchain.mjs";

function reference() {
  return JSON.parse(
    readFileSync(
      new URL("../../docs/release/2952-coding-runtime-calibration.json", import.meta.url),
    ),
  ).environment;
}

function upgrade(environment) {
  return {
    ...environment,
    runtimeVersion: `${environment.runtimeVersion}-candidate`,
    payloadSha256: environment.payloadSha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64),
  };
}

describe("coding performance reference transition", () => {
  function toolchainTransition() {
    const previous = { ...reference(), nodeVersion: "24.18.0", npmVersion: "11.16.0" };
    const current = {
      ...previous,
      nodeVersion: EXPECTED_NODE_BASELINE,
      npmVersion: EXPECTED_NPM_ENGINE,
    };
    return { previous, current };
  }

  it("admits only the exact governed Node/npm migration on the unchanged reference", () => {
    const { previous, current } = toolchainTransition();
    expect(() =>
      assertCodingPerformanceReference(previous, current, "recalibrate-toolchain"),
    ).not.toThrow();
    expect(() =>
      assertCodingPerformanceReference(current, current, "recalibrate-toolchain"),
    ).toThrow("approved-toolchain-transition-required");
    for (const drift of [{ nodeVersion: "27.0.0" }, { npmVersion: "12.0.0" }]) {
      expect(() =>
        assertCodingPerformanceReference(
          previous,
          { ...current, ...drift },
          "recalibrate-toolchain",
        ),
      ).toThrow("approved-toolchain-transition-required");
    }
  });

  it.each(Object.keys(reference()).filter((key) => !["nodeVersion", "npmVersion"].includes(key)))(
    "keeps %s pinned during a Node/npm migration",
    (field) => {
      const { previous, current } = toolchainTransition();
      expect(() =>
        assertCodingPerformanceReference(
          previous,
          { ...current, [field]: "different" },
          "recalibrate-toolchain",
        ),
      ).toThrow("recalibration-reference-environment-differs");
    },
  );

  it("keeps ordinary recalibration bound to the exact environment", () => {
    const previous = reference();
    expect(() => assertCodingPerformanceReference(previous, previous, "recalibrate")).not.toThrow();
    expect(() =>
      assertCodingPerformanceReference(previous, upgrade(previous), "recalibrate"),
    ).toThrow("recalibration-reference-environment-differs");
  });

  it("admits an explicit runtime transition on the same reference machine", () => {
    const previous = reference();
    expect(() =>
      assertCodingPerformanceReference(previous, upgrade(previous), "recalibrate-runtime"),
    ).not.toThrow();
  });

  it.each(["runtimeVersion", "payloadSha256"])("requires a changed %s", (field) => {
    const previous = reference();
    const candidate = { ...upgrade(previous), [field]: previous[field] };
    expect(() =>
      assertCodingPerformanceReference(previous, candidate, "recalibrate-runtime"),
    ).toThrow("runtime-transition-required");
  });

  it.each(
    Object.keys(reference()).filter((key) => !["runtimeVersion", "payloadSha256"].includes(key)),
  )("rejects a simultaneous change to %s", (field) => {
    const previous = reference();
    const candidate = { ...upgrade(previous), [field]: "different" };
    expect(() =>
      assertCodingPerformanceReference(previous, candidate, "recalibrate-runtime"),
    ).toThrow("recalibration-reference-environment-differs");
  });

  it("rejects additional reference fields", () => {
    const previous = reference();
    expect(() =>
      assertCodingPerformanceReference(
        previous,
        { ...upgrade(previous), unexpected: true },
        "recalibrate-runtime",
      ),
    ).toThrow("recalibration-reference-environment-differs");
  });
});
