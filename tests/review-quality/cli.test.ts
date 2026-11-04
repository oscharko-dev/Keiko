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

  it("reads the instant a resumed replay continues from, and keeps it off the seed gate", () => {
    const resumed = parseGateArguments([
      "--set",
      "holdout",
      "--confirm-final-holdout",
      "--resume-since",
      "2026-11-02T17:35:00Z",
      ...COMMON,
    ]);
    expect(resumed.resumeSinceMs).toBe(Date.parse("2026-11-02T17:35:00Z"));
    expect(parseGateArguments(["--set", "seeds", ...COMMON]).resumeSinceMs).toBeUndefined();
    expect(() =>
      parseGateArguments(["--set", "seeds", "--resume-since", "2026-11-02T17:35:00Z", ...COMMON]),
    ).toThrow(/not the seed gate/u);
    for (const value of ["yesterday", "2026-11-02", "2026-13-45T99:00:00Z"]) {
      expect(() =>
        parseGateArguments([
          "--set",
          "holdout",
          "--confirm-final-holdout",
          "--resume-since",
          value,
          ...COMMON,
        ]),
      ).toThrow(/ISO 8601 instant/u);
    }
  });

  it("reads a legacy configuration digest only for a resumed run and only in sha256 form", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const resumed = [
      "--set",
      "holdout",
      "--confirm-final-holdout",
      "--resume-since",
      "2026-11-02T17:35:00Z",
      ...COMMON,
    ];
    expect(parseGateArguments(resumed).resumeLegacyDigest).toBeUndefined();
    expect(
      parseGateArguments([...resumed, "--resume-legacy-digest", digest]).resumeLegacyDigest,
    ).toBe(digest);
    expect(() =>
      parseGateArguments([
        "--set",
        "holdout",
        "--confirm-final-holdout",
        "--resume-legacy-digest",
        digest,
        ...COMMON,
      ]),
    ).toThrow(/belongs to a resumed run/u);
    for (const value of ["a".repeat(64), "sha256:abc", `sha256:${"G".repeat(64)}`]) {
      expect(() => parseGateArguments([...resumed, "--resume-legacy-digest", value])).toThrow(
        /sha256: configuration digest/u,
      );
    }
  });

  it("reads prior reuse keys and the re-score flag only for a resumed run", () => {
    const resumed = [
      "--set",
      "holdout",
      "--confirm-final-holdout",
      "--resume-since",
      "2026-11-02T17:35:00Z",
      ...COMMON,
    ];
    expect(parseGateArguments(resumed)).toMatchObject({ resumePriorKeys: [], rescore: false });
    expect(
      parseGateArguments([
        ...resumed,
        "--resume-prior-keys",
        "0123456789ab,ba9876543210",
        "--rescore",
      ]),
    ).toMatchObject({ resumePriorKeys: ["0123456789ab", "ba9876543210"], rescore: true });
    expect(() => parseGateArguments([...resumed, "--resume-prior-keys", "0123456789AB"])).toThrow(
      /twelve-character hex/u,
    );
    for (const flag of [["--rescore"], ["--resume-prior-keys", "0123456789ab"]]) {
      expect(() =>
        parseGateArguments(["--set", "holdout", "--confirm-final-holdout", ...flag, ...COMMON]),
      ).toThrow(/belongs to a resumed run/u);
    }
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
