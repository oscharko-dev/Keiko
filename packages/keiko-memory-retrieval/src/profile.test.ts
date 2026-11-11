import { describe, expect, it } from "vitest";

import {
  PROFILE_EXCLUDED_MEMORY_TAG,
  STANDING_FACT_RETENTION_POLICY_KEY,
  type MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

import { estimateTokens } from "./context.js";
import {
  DEFAULT_STANDING_PROFILE_CAPS,
  selectStandingProfile,
  standingProfileSuccession,
  standingProfileWithout,
  type StandingProfileCandidate,
} from "./profile.js";
import { buildRecord, projectScope, type BuildRecordOptions } from "./_support.js";

const NOW = 10_000;

function candidate(options: BuildRecordOptions, confirmations = 0): StandingProfileCandidate {
  return {
    record: buildRecord({ status: "accepted", type: "preference", ...options }),
    confirmations,
  };
}

function ids(candidates: readonly StandingProfileCandidate[]): readonly string[] {
  return selectStandingProfile(candidates, NOW).entries.map((entry) => entry.id);
}

describe("selectStandingProfile", () => {
  it("orders by pin, then confirmations, then the newest statement, then the id", () => {
    const candidates = [
      candidate({ id: "b-old", createdAt: 100 }, 2),
      candidate({ id: "pinned", createdAt: 50, pinned: true }),
      candidate({ id: "a-new", createdAt: 300 }, 2),
      candidate({ id: "z-tie", createdAt: 200 }, 1),
      candidate({ id: "y-tie", createdAt: 200 }, 1),
    ];
    expect(ids(candidates)).toEqual(["pinned", "a-new", "b-old", "y-tie", "z-tie"]);
    // Input order never changes the outcome.
    expect(ids([...candidates].reverse())).toEqual(ids(candidates));
  });

  it("keeps a stated preference ahead of any number of newer learned facts", () => {
    const facts = Array.from({ length: 10_000 }, (_, index) =>
      candidate({ id: `f${String(index)}`, type: "semantic-fact", createdAt: 5_000 + index }, 3),
    );
    const tables = candidate({ id: "tables", body: "Bevorzugt Tabellen.", createdAt: 1 });
    expect(ids([...facts, tables])[0]).toBe("tables");
  });

  it("takes only the person's own accepted, unsuppressed facts of the standing types", () => {
    const profile = selectStandingProfile(
      [
        candidate({ id: "keep", type: "procedural" }),
        candidate({ id: "fact", type: "semantic-fact" }),
        candidate({ id: "pinned-fact", type: "semantic-fact", pinned: true }),
        candidate({ id: "project", scope: projectScope() }),
        candidate({ id: "episode", type: "episodic" }),
        candidate({ id: "proposed", status: "proposed" }),
        candidate({ id: "superseded", status: "superseded" }),
        candidate({ id: "expired", validFrom: 0, validUntil: NOW }),
        candidate({ id: "excluded", tags: [PROFILE_EXCLUDED_MEMORY_TAG] }),
      ],
      NOW,
    );
    expect(profile.entries.map((entry) => entry.id)).toEqual(["pinned-fact", "keep"]);
    expect(profile.dropped).toEqual({
      "not-private": 1,
      "not-standing-type": 2,
      "not-accepted": 2,
      suppressed: 1,
      excluded: 1,
    });
  });

  it("takes a fact capture marked standing, and no other retention hint", () => {
    const marked = (id: string, policyKey: string): StandingProfileCandidate => ({
      record: {
        ...buildRecord({ id, status: "accepted", type: "semantic-fact" }),
        retentionHint: { policyKey },
      },
      confirmations: 0,
    });
    expect(
      ids([marked("role", STANDING_FACT_RETENTION_POLICY_KEY), marked("kept", "legal-hold")]),
    ).toEqual(["role"]);
  });

  it("passes a fact's place in the profile, or its removal, to the fact that supersedes it", () => {
    const record = (options: BuildRecordOptions): MemoryRecord =>
      buildRecord({ status: "accepted", ...options });
    const successor = record({ type: "semantic-fact", tags: ["db"] });
    const standingMark = { retentionHint: { policyKey: STANDING_FACT_RETENTION_POLICY_KEY } };
    expect(standingProfileSuccession(record({ type: "preference" }), successor)).toEqual(
      standingMark,
    );
    expect(
      standingProfileSuccession(record({ type: "episodic", pinned: true }), successor),
    ).toEqual(standingMark);
    expect(standingProfileSuccession(record({ type: "episodic" }), successor)).toEqual({});
    expect(
      standingProfileSuccession(
        record({ type: "preference", tags: [PROFILE_EXCLUDED_MEMORY_TAG] }),
        successor,
      ),
    ).toEqual({ ...standingMark, tags: ["db", PROFILE_EXCLUDED_MEMORY_TAG] });
    // A successor that already carries a hint keeps it.
    const hinted = { ...successor, retentionHint: { policyKey: "legal-hold" } };
    expect(standingProfileSuccession(record({ type: "preference" }), hinted)).toEqual({});
  });

  it("keeps confidential and restricted facts out, pinned or not", () => {
    expect(
      ids([
        candidate({ id: "confidential", sensitivity: "confidential", pinned: true }),
        candidate({ id: "restricted", sensitivity: "restricted" }),
        candidate({ id: "public" }),
      ]),
    ).toEqual(["public"]);
  });

  it("takes a fact recall supplied out of the profile for that answer and recounts its tokens", () => {
    // The failure this pins (lab 2026-11-11, Gemma): a preference the question was about reached
    // the answer only as a profile line, and the model missed it in two of three runs.
    const profile = selectStandingProfile(
      [
        candidate({ id: "lists", body: "Ab jetzt bevorzuge ich Listen." }, 1),
        candidate({ id: "de" }),
      ],
      NOW,
    );
    const lists = profile.entries.find((entry) => entry.id === "lists");
    const answer = standingProfileWithout(
      profile,
      new Set([lists?.id].filter((id) => id !== undefined)),
    );
    expect(answer.entries.map((entry) => entry.id)).toEqual(["de"]);
    expect(answer.tokens).toBe(profile.tokens - (lists?.tokens ?? 0));
    expect(answer.dropped).toEqual(profile.dropped);
  });

  it("keeps the profile unchanged when recall supplied none of its facts", () => {
    const profile = selectStandingProfile([candidate({ id: "lists" })], NOW);
    expect(standingProfileWithout(profile, new Set())).toBe(profile);
  });

  it("lets a pinned fact in and keeps an unpinned, excluded fact out", () => {
    const fact = (pinned: boolean, tags: readonly string[]): StandingProfileCandidate =>
      candidate({ id: "tables", type: "episodic", pinned, tags });
    expect(ids([fact(true, [])])).toEqual(["tables"]);
    expect(ids([fact(false, [])])).toEqual([]);
    const standing = (pinned: boolean, tags: readonly string[]): StandingProfileCandidate =>
      candidate({ id: "tables", pinned, tags });
    expect(ids([standing(false, [PROFILE_EXCLUDED_MEMORY_TAG])])).toEqual([]);
    expect(ids([standing(true, [PROFILE_EXCLUDED_MEMORY_TAG])])).toEqual(["tables"]);
  });

  it("stays within its caps at every vault size", () => {
    for (const size of [0, 1, 7, 8, 9, 100, 10_000]) {
      const candidates = Array.from({ length: size }, (_, index) =>
        candidate({ id: `m${String(index)}`, body: `Ich bevorzuge Format ${String(index)}.` }),
      );
      const profile = selectStandingProfile(candidates, NOW);
      expect(profile.entries.length).toBeLessThanOrEqual(DEFAULT_STANDING_PROFILE_CAPS.maxEntries);
      expect(profile.entries).toHaveLength(
        Math.min(size, DEFAULT_STANDING_PROFILE_CAPS.maxEntries),
      );
      expect(profile.tokens).toBeLessThanOrEqual(DEFAULT_STANDING_PROFILE_CAPS.maxTokens);
    }
  });

  it("counts pinned facts against the caps and clips a long fact to one line", () => {
    const long = `Ich arbeite\n\nimmer ${"sehr ".repeat(200)}gründlich.`;
    const profile = selectStandingProfile(
      [candidate({ id: "long", body: long, pinned: true }), candidate({ id: "short" })],
      NOW,
      { maxEntries: 1, maxTokens: 100, entryMaxTokens: 10 },
    );
    expect(profile.entries.map((entry) => entry.id)).toEqual(["long"]);
    const [entry] = profile.entries;
    expect(entry?.text).not.toMatch(/\n/u);
    expect(estimateTokens(entry?.text ?? "")).toBeLessThanOrEqual(10);
    expect(profile.tokens).toBe(entry?.tokens);
    expect(profile.dropped).toEqual({ "entry-cap": 1 });
  });

  it("skips a fact that does not fit the remaining token budget and keeps looking", () => {
    const profile = selectStandingProfile(
      [
        candidate({ id: "big", body: "eins zwei drei vier fünf sechs" }, 2),
        candidate({ id: "small", body: "Tabellen" }, 1),
      ],
      NOW,
      { maxEntries: 5, maxTokens: 3, entryMaxTokens: 20 },
    );
    expect(profile.entries.map((entry) => entry.id)).toEqual(["small"]);
    expect(profile.dropped).toEqual({ "token-cap": 1 });
  });

  it("counts a repeated candidate once", () => {
    const record: MemoryRecord = buildRecord({
      id: "same",
      status: "accepted",
      type: "preference",
    });
    expect(
      selectStandingProfile(
        [
          { record, confirmations: 1 },
          { record, confirmations: 1 },
        ],
        NOW,
      ).entries,
    ).toHaveLength(1);
  });

  it("rejects caps that are not non-negative integers", () => {
    expect(() =>
      selectStandingProfile([], NOW, { maxEntries: -1, maxTokens: 1, entryMaxTokens: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      selectStandingProfile([], NOW, { maxEntries: 1, maxTokens: Number.NaN, entryMaxTokens: 1 }),
    ).toThrow(RangeError);
  });
});
