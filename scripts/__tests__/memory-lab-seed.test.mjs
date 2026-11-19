// The seed of a lab scenario (#4207): the plan is pure and deterministic, the validator is strict, and
// the store really holds what was planned, encrypted with the key the server will use, with the
// backdated timestamps, the correction edge and the reinforcement the scenario asked for.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT, importBuilt } from "../testing/coding-workbench-lab/lab-common.mjs";
import { validateScenario } from "../testing/memory-lab/scenario.mjs";
import {
  LOCAL_MEMORY_USER_ID,
  MEMORY_TYPES,
  describePlan,
  fillerBody,
  fillerBodies,
  planSeed,
} from "../testing/memory-lab/seed-plan.mjs";
import { seedVault } from "../testing/memory-lab/seed-store.mjs";
import { startScriptedModelServer } from "../testing/memory-lab/scripted-model.mjs";
import { scriptedEmbedderProvider } from "../testing/memory-lab/embedder.mjs";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 86_400_000;
const PROJECT = "/work/project";

function chain() {
  return {
    records: [
      {
        key: "old",
        body: "Rosa wanted the report as a PDF file.",
        type: "preference",
        scope: "project",
        status: "superseded",
        ageDays: 90,
        earlier: "before",
      },
      {
        key: "new",
        body: "Rosa wants the report as a Markdown file.",
        type: "preference",
        scope: "user",
        status: "accepted",
        ageDays: 10,
        pinned: true,
        origin: "stated",
        supersedes: "old",
        accessCount: 3,
        lastAccessDays: 2,
        truth: "now",
      },
    ],
    filler: [{ count: 5, status: "accepted", minAgeDays: 1, maxAgeDays: 30, seed: 3 }],
  };
}

function scenario(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "seed-fixture-en",
    language: "en",
    class: "update",
    difficulty: "plain",
    description: "Seed fixture.",
    truth: [{ key: "now", seed: "Rosa wants Markdown.", must: false, terms: [["Markdown"]] }],
    superseded: [{ key: "before", terms: [["PDF"]] }],
    seed: chain(),
    turns: [],
    probes: [
      { id: "p", question: "Which format?", expect: { kind: "answer", terms: [["Markdown"]] } },
    ],
    ...overrides,
  };
}

describe("planning a seed", () => {
  it("is deterministic: the same seed and the same clock plan the same records", () => {
    const first = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    const second = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    expect(second).toEqual(first);
    expect(first.records).toHaveLength(7);
    expect(new Set(first.records.map((record) => record.id)).size).toBe(7);
  });

  it("backdates a record by its age and scopes it as the product scopes a person and a project", () => {
    const { records } = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    const [old, current] = records;
    expect(current.createdAt).toBe(NOW - 10 * DAY);
    expect(current.scope).toEqual({ kind: "user", userId: LOCAL_MEMORY_USER_ID });
    expect(current.pinned).toBe(true);
    expect(old.scope).toEqual({ kind: "project", projectId: PROJECT });
    expect(old.createdAt).toBe(NOW - 90 * DAY);
  });

  it("builds the correction chain: an edge from the replaced record to its successor, closed validity", () => {
    const plan = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    const [old, current] = plan.records;
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0]).toMatchObject({
      kind: "supersedes",
      fromMemoryId: old.id,
      toMemoryId: current.id,
      createdAt: current.createdAt,
    });
    // The replaced fact ends when its successor began, as the product's own supersession closes it.
    expect(old.validity).toEqual({ validFrom: old.createdAt, validUntil: current.createdAt });
    expect(old.updatedAt).toBe(current.createdAt);
    expect(current.validity.validUntil).toBeUndefined();
  });

  it("records the reinforcement a record carries, at the age of its last access", () => {
    const plan = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    expect(plan.access).toEqual([
      { id: plan.records[1].id, count: 3, lastAccessedAt: NOW - 2 * DAY },
    ]);
  });

  it("generates filler that is deterministic, unique, within its age range and prefix-stable", () => {
    const group = { count: 40, status: "archived", minAgeDays: 5, maxAgeDays: 50, seed: 9 };
    const a = planSeed({ filler: [group] }, { nowMs: NOW, projectId: PROJECT });
    const b = planSeed({ filler: [{ ...group, count: 20 }] }, { nowMs: NOW, projectId: PROJECT });
    expect(new Set(a.records.map((record) => record.body)).size).toBe(40);
    expect(a.records.every((record) => record.status === "archived")).toBe(true);
    for (const record of a.records) {
      const ageDays = (NOW - record.createdAt) / DAY;
      expect(ageDays).toBeGreaterThanOrEqual(5);
      expect(ageDays).toBeLessThanOrEqual(50);
    }
    expect(b.records.map((record) => record.body)).toEqual(
      a.records.slice(0, 20).map((record) => record.body),
    );
    expect(fillerBody(9, 0)).not.toBe(fillerBody(10, 0));
  });

  it("describes a plan in counts only", () => {
    const description = describePlan(planSeed(chain(), { nowMs: NOW, projectId: PROJECT }));
    expect(description).toEqual({
      total: 7,
      explicit: 2,
      filler: 5,
      byStatus: { superseded: 1, accepted: 6 },
      byScope: { project: 1, user: 6 },
      supersedesEdges: 1,
      reinforced: 1,
    });
  });

  it("keeps its memory types in step with the contracts' closed list", async () => {
    const contracts = await import(
      pathToFileURL(join(REPO_ROOT, "packages", "keiko-contracts", "dist", "memory-contracts.js"))
        .href
    );
    expect([...MEMORY_TYPES]).toEqual([...contracts.MEMORY_TYPES]);
  });
});

describe("validating a seed", () => {
  const refused = (patch, message) =>
    expect(() => validateScenario(scenario(patch))).toThrow(message);
  const withSeed = (change) => {
    const seed = chain();
    change(seed);
    return { seed };
  };

  it("accepts a well-formed seed and lets such a scenario have no turn", () => {
    expect(validateScenario(scenario()).seed.records).toHaveLength(2);
  });

  it("still refuses a scenario with neither a turn nor a seed", () => {
    refused({ seed: undefined }, "turns must be a non-empty array");
  });

  it("refuses a field it does not know, a typo would otherwise measure something else", () => {
    refused(
      withSeed((seed) => {
        seed.records[0].ageDay = 3;
      }),
      "unknown field: ageDay",
    );
    refused({ seed: { records: chain().records, extra: 1 } }, "seed has an unknown field: extra");
  });

  it("refuses an empty seed, a bad status, a bad type and a negative age", () => {
    refused({ seed: {} }, "at least one record or filler group");
    refused(
      withSeed((seed) => {
        seed.records[0].status = "forgotten";
      }),
      "status must be one of",
    );
    refused(
      withSeed((seed) => {
        seed.records[1].type = "memo";
      }),
      "type must be one of",
    );
    refused(
      withSeed((seed) => {
        seed.records[1].ageDays = -1;
      }),
      "ageDays must be a number of days",
    );
  });

  it("refuses a correction chain that contradicts itself", () => {
    refused(
      withSeed((seed) => {
        seed.records[0].status = "accepted";
      }),
      "which is not status superseded",
    );
    refused(
      withSeed((seed) => {
        seed.records[1].supersedes = "missing";
      }),
      "names no other seed record",
    );
    refused(
      withSeed((seed) => {
        seed.records[1].ageDays = 120;
      }),
      "newer than this one",
    );
  });

  it("refuses a supersedes cycle among records of equal age, and keeps an equal-age chain valid", () => {
    // The failure this pins: both records are superseded and equally old, so the status and the age
    // check each pass in both directions and the planner wrote a cyclic history.
    const equal = (change) =>
      withSeed((seed) => {
        seed.records.push({
          key: "older",
          body: "Rosa wanted the report as a Word file.",
          type: "preference",
          scope: "project",
          status: "superseded",
          ageDays: 90,
        });
        change(seed.records);
      });
    refused(
      equal((records) => {
        records[0].supersedes = "older";
        records[2].supersedes = "old";
      }),
      "forms a cycle",
    );
    // An acyclic chain of equal age is valid: older <- old <- new.
    const chained = scenario(
      equal((records) => {
        records[0].supersedes = "older";
      }),
    );
    expect(validateScenario(chained).seed.records).toHaveLength(3);
  });

  it("refuses a link whose body the fact's own terms do not match", () => {
    refused(
      withSeed((seed) => {
        seed.records[1].body = "Rosa wants nothing in particular.";
      }),
      "does not match the terms of truth now",
    );
    refused(
      withSeed((seed) => {
        seed.records[0].earlier = "nowhere";
      }),
      "names no superseded key",
    );
  });

  it("refuses a reinforcement that predates the record or is not a count", () => {
    refused(
      withSeed((seed) => {
        seed.records[1].lastAccessDays = 30;
      }),
      "cannot be older than the record itself",
    );
    refused(
      withSeed((seed) => {
        seed.records[1].accessCount = 1.5;
      }),
      "accessCount must be an integer",
    );
  });

  it("refuses filler that is out of bounds or whose bodies a scenario term would match", () => {
    refused(
      withSeed((seed) => {
        seed.filler[0].count = 6000;
      }),
      "count must be an integer between 1 and 5000",
    );
    refused(
      withSeed((seed) => {
        seed.filler[0].minAgeDays = 60;
      }),
      "minAgeDays exceeds maxAgeDays",
    );
    // A term every filler body contains would turn the filler into stored facts the scorer judges.
    refused(
      {
        truth: [{ key: "now", seed: "x", must: false, terms: [["gehoert"]] }],
        superseded: [],
        seed: { filler: chain().filler },
      },
      "a seed filler body matches a term list",
    );
    expect(fillerBodies(chain().filler)).toHaveLength(5);
  });
});

describe("placing a seed in a vault", () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function openVault(memoryDir, vaultKey) {
    const vault = await importBuilt("keiko-memory-vault", "index.js");
    return vault.createMemoryVault({
      memoryDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      vaultKey,
    });
  }

  it("stores what was planned, readable only with the key it was placed with, then opens as an ordinary store", async () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-seed-store-"));
    const key = randomBytes(32);
    const plan = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
    const placed = await seedVault({
      subjectRoot: REPO_ROOT,
      memoryDir: directory,
      vaultKey: key,
      plan,
    });
    expect(placed).toEqual({ inserted: 7, embedded: 0 });
    const vault = await openVault(directory, key);
    try {
      const old = vault.getMemory(plan.records[0].id);
      const current = vault.getMemory(plan.records[1].id);
      expect(old).toMatchObject({ status: "superseded", createdAt: NOW - 90 * DAY });
      expect(current).toMatchObject({
        status: "accepted",
        pinned: true,
        createdAt: NOW - 10 * DAY,
      });
      expect(vault.listIncomingEdges(current.id).map((edge) => edge.kind)).toEqual(["supersedes"]);
      const stats = vault.getAccessStats([current.id]).get(current.id);
      expect(stats).toMatchObject({ accessCount: 3, lastAccessedAt: NOW - 2 * DAY });
      expect(vault.listMemoryCenterPage({ limit: 50, offset: 0 }).total).toBe(7);
      expect(vault.countAcceptedMemoriesMissingEmbedding()).toBe(6);
    } finally {
      vault.close();
    }
  });

  it("embeds only the accepted records through the configured embedding model, and fails when it cannot", async () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-seed-embed-"));
    const fixture = await startScriptedModelServer({ embedder: true });
    try {
      const configPath = join(directory, "gateway.json");
      writeFileSync(
        configPath,
        JSON.stringify({ providers: [scriptedEmbedderProvider(fixture.baseUrl)] }),
      );
      const env = { KEIKO_MODEL_MEMORY_LAB_EMBEDDER_API_KEY: "lab" };
      const key = randomBytes(32);
      const plan = planSeed(chain(), { nowMs: NOW, projectId: PROJECT });
      const embedding = { configPath, env };
      const placed = await seedVault({
        subjectRoot: REPO_ROOT,
        memoryDir: join(directory, "memory"),
        vaultKey: key,
        plan,
        embedding,
      });
      // Six accepted records (one chain record and five filler); the superseded one is not embedded.
      expect(placed).toEqual({ inserted: 7, embedded: 6 });
      expect(fixture.embeddingCalls()).toBe(6);
      const vault = await openVault(join(directory, "memory"), key);
      try {
        expect(vault.countAcceptedMemoriesMissingEmbedding()).toBe(0);
      } finally {
        vault.close();
      }
      // The red half: a configuration without an embedding model cannot embed, so seeding refuses.
      writeFileSync(configPath, JSON.stringify({ providers: [] }));
      await expect(
        seedVault({
          subjectRoot: REPO_ROOT,
          memoryDir: join(directory, "none"),
          vaultKey: key,
          plan,
          embedding,
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise((resolve) => {
        fixture.close(() => resolve());
        fixture.closeAllConnections();
      });
    }
  });
});
