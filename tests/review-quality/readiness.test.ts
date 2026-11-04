import { describe, expect, it, vi } from "vitest";

import { type GateArguments, parseGateArguments } from "./cli.js";
import {
  preparedReadiness,
  probeUntilReady,
  type ReadinessProbe,
  startReadiness,
} from "./readiness.js";

const COMMON = [
  ...["--repository", "/r", "--config", "/c", "--state", "/s", "--out", "/o"],
  ...["--reviewer", "reviewer", "--counter-checker", "counter"],
  ...["--set", "holdout", "--confirm-final-holdout", "--resume-since", "2026-11-02T17:35:00Z"],
];
const READY = { reviewer: "200/ready", counter: "200/partial" };
const DOWN = { reviewer: "503/unavailable", counter: "200/ready" };

function args(...extra: string[]): GateArguments {
  return parseGateArguments([...COMMON, ...extra]);
}

describe("probeUntilReady", () => {
  it("returns the first outcomes in which every model passed", async () => {
    const probe = vi.fn<ReadinessProbe>().mockResolvedValueOnce(DOWN).mockResolvedValue(READY);
    await expect(probeUntilReady(args(), probe, 0)).resolves.toEqual(READY);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("throws after the fifth failed attempt, so no review runs", async () => {
    const probe = vi.fn<ReadinessProbe>().mockResolvedValue(DOWN);
    await expect(probeUntilReady(args(), probe, 0)).rejects.toThrow(/no review ran/u);
    expect(probe).toHaveBeenCalledTimes(5);
  });
});

describe("readiness of a re-scored replay", () => {
  it("probes nothing and records null, even when every probe would fail", async () => {
    const probe = vi.fn<ReadinessProbe>().mockRejectedValue(new Error("the lab is off"));
    const rescore = args("--rescore");
    await expect(startReadiness(rescore, probe)).resolves.toBeNull();
    await expect(preparedReadiness(rescore, probe, 0)).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("still probes an ordinary resumed replay", async () => {
    const probe = vi.fn<ReadinessProbe>().mockResolvedValue(READY);
    await expect(startReadiness(args(), probe)).resolves.toEqual(READY);
    await expect(preparedReadiness(args(), probe, 0)).resolves.toEqual(READY);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
