import { describe, expect, it } from "vitest";
import { pollUntilDead } from "./ui-process-stop.js";

// `pollUntilDead` polls one call at a time through `runAsyncSteps`, so a long budget does not build
// a chain of pending promises. Fifty thousand polls must still end with the answer of the last one.
describe("pollUntilDead over many polls", () => {
  it("returns true once the process is gone after many polls", async () => {
    let polls = 0;
    const alive = (): boolean => {
      polls += 1;
      return polls < 50_000;
    };
    await expect(pollUntilDead(1, alive, () => Promise.resolve(), 3_600_000, 1)).resolves.toBe(
      true,
    );
    expect(polls).toBe(50_000);
  });

  it("answers with the last check when the budget runs out and it is asked to confirm", async () => {
    await expect(
      pollUntilDead(
        1,
        () => true,
        () => Promise.resolve(),
        -1,
        1,
        true,
      ),
    ).resolves.toBe(false);
  });
});
