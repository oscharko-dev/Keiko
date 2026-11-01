import { describe, expect, it } from "vitest";

import { GateArgumentError, parseGateArguments } from "./cli.js";

const COMMON = [
  "--repository",
  "/lab/keiko",
  "--config",
  "/lab/gateway.json",
  "--state",
  "/lab/state",
  "--out",
  "/lab/out",
  "--reviewer",
  "reviewer-model",
  "--counter-checker",
  "counter-model",
];

describe("parseGateArguments", () => {
  it("reads a development iteration with its tuning inputs and defaults", () => {
    const args = parseGateArguments([
      "--set",
      "development",
      "--iteration",
      "dev-1",
      "--tuning-inputs",
      "120, 340",
      ...COMMON,
    ]);
    expect(args).toMatchObject({
      set: "development",
      variant: "product",
      iteration: "dev-1",
      tuningInputs: [120, 340],
      sampleSize: 30,
      pullRequests: undefined,
      port: 1995,
      reviewerModelId: "reviewer-model",
      counterCheckerModelId: "counter-model",
    });
  });

  it("reads an explicit pull request list, a variant, a sample size and a port", () => {
    const args = parseGateArguments([
      "--set",
      "development",
      "--iteration",
      "dev-2",
      "--variant",
      "counter-check-off",
      "--pull-requests",
      "7,9",
      "--sample",
      "12",
      "--port",
      "2001",
      ...COMMON,
    ]);
    expect(args).toMatchObject({
      variant: "counter-check-off",
      pullRequests: [7, 9],
      sampleSize: 12,
    });
    expect(args.port).toBe(2001);
  });

  it("refuses a holdout run without the explicit final-run confirmation", () => {
    expect(() => parseGateArguments(["--set", "holdout", ...COMMON])).toThrow(
      /--confirm-final-holdout/u,
    );
    const args = parseGateArguments(["--set", "holdout", "--confirm-final-holdout", ...COMMON]);
    expect(args).toMatchObject({ set: "holdout", iteration: "holdout", tuningInputs: [] });
  });

  it("refuses variants and tuning inputs outside the development set", () => {
    expect(() =>
      parseGateArguments(["--set", "seeds", "--variant", "roles-swapped", ...COMMON]),
    ).toThrow(/development set only/u);
    expect(() => parseGateArguments(["--set", "seeds", "--tuning-inputs", "4", ...COMMON])).toThrow(
      /development run/u,
    );
  });

  it.each([
    [["--set", "development", ...COMMON], /--iteration is required/u],
    [["--set", "later", ...COMMON], /--set must be one of/u],
    [["--set", "seeds", "--sample", "0", ...COMMON], /--sample must be a positive integer/u],
    [["--set", "seeds", "--port"], /--port needs a value/u],
    [["seeds"], /unexpected argument/u],
    [["--set", "seeds"], /--repository is required/u],
  ])("refuses malformed arguments %#", (argv, message) => {
    expect(() => parseGateArguments(argv)).toThrow(GateArgumentError);
    expect(() => parseGateArguments(argv)).toThrow(message);
  });
});
