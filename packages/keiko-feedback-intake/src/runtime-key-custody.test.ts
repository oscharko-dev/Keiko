import { describe, expect, it } from "vitest";
import { assertRepositoryKeyCustody } from "./runtime-key-custody.js";
import type { PgLiveKeyIdsSnapshot } from "./postgres-live-key-snapshot.js";
import type { IntakeSecretProvider, IntakeSecretSnapshot } from "./types.js";

function provider(id: string, fill: number, calls: { value: number }): IntakeSecretProvider {
  return {
    snapshot: (): IntakeSecretSnapshot => {
      calls.value += 1;
      return {
        active: { id, key: new Uint8Array(32).fill(fill), activatedAt: new Date(0) },
        predecessors: [],
      };
    },
  };
}

describe("repository key-custody snapshots", () => {
  it("compares both custody classes with one combined bounded repository snapshot", async () => {
    const abuseCalls = { value: 0 };
    const dedupeCalls = { value: 0 };
    let repositoryCalls = 0;
    const repository = {
      liveKeyIdsSnapshot: (): Promise<PgLiveKeyIdsSnapshot> => {
        repositoryCalls += 1;
        return Promise.resolve({
          abuse: ["abuse-current", "abuse-overflow"],
          dedupe: ["dedupe-current"],
        });
      },
    };

    await expect(
      assertRepositoryKeyCustody(
        repository,
        provider("abuse-current", 1, abuseCalls),
        provider("dedupe-current", 2, dedupeCalls),
        new Date("2026-07-11T12:00:00.000Z"),
      ),
    ).rejects.toThrow("custody");
    expect({
      abuse: abuseCalls.value,
      dedupe: dedupeCalls.value,
      repository: repositoryCalls,
    }).toEqual({ abuse: 1, dedupe: 1, repository: 1 });
  });
});
