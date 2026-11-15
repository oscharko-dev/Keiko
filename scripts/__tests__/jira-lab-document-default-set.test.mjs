// The default (document) scenario set, as the scorecard resolves it without `--set` (#4369 AC6).
// Every scenario's catalog entry (id, requirement, issue, title, obligations, deferred) is serialised
// deterministically (keys sorted, JSON, SHA-256) and equals a digest fixed from a commit.
//   - S01-S09 and S11-S20 (with S11b): taken at d2e5cf2b7, the last commit before any #4369 lab work,
//     which is also before the composer lane. The composer lane, its hard/soft split and the strict
//     aggregate changed none of them: the digests are identical at d2e5cf2b7 and now.
//   - S10 changed legitimately, and only in its obligations: 422458c60 added `estimate-source-labelled`,
//     `configured-unused-stated` and `other-estimate-field-named` (the product's estimate rule, #4355),
//     and 76ea6e9f9 / 1f7530a1f added `answer-clean`. Its digest is fixed from 1f7530a1f, the last
//     commit that changed it.
// What this does NOT pin: oracles and journey code are functions, not data; their behaviour is pinned
// by the document lane's own tests (the scorecard, validity and journey suites), not by a digest.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { selectedScenarios } from "../testing/jira-chat-lab/requirements/composer-run.mjs";

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const digestOf = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** Fixed at d2e5cf2b7 (before #4369), except S10 (fixed at 1f7530a1f, see the header). */
const FIXED = {
  S01: "d0a05df918b1cc681de05a1323b8f0e3d3341f99f0643e5179ef66970f5495db",
  S02: "0699ea00cccca1c2daff9c8d2b4803f34e367d98e2cb2507991e3f44f33f4bcd",
  S03: "42874836646a1750c29513d9f7a76c935de37dfdb848c25d222092f0a57782b9",
  S04: "f597697e04520d9071d4a0456dcd6a39d28157ef856e772f519807eb64982e7d",
  S05: "338be314c8315cbb92487cab5ce34e4352cbb7fd527d3975e360f1e6dc58e72e",
  S06: "17c08d4c71afb68c54b26abc61e2a94ea41525c609e078cc3c67cdb03a1e1ec9",
  S07: "bcf083b2be788dbc7cffe808353c15a714c83315a7956e962c8b193128a58fad",
  S08: "bc5e4096e9a3704efcbf7eab2caa1eee757104221d5499a7c5a8c11f67c118cd",
  S09: "8e5c3b0c6229a92425ee3f51270dcded3205bff3e10b2e7dbda356d776066c8b",
  S10: "6d4cd345aa7f4485b2579d7b3a03761d9447d14a7f5fcc3d522147c8bf1dd441",
  S11: "9a56e944bfb839ce7b231cc11ec55d4f808537e21b66d606d64a1b50cedf0237",
  S11b: "8611742cdf7605b3ccd51cba24525e14c4c1a180592b62d498520872811901f1",
  S12: "6553b73fd3df3899b26dcaaf5032c447b98c5ed2a22454baf269892e15bf4cd8",
  S13: "2d97e9e742b96357fd690c9a398dd28b91378a7613ae5d68f6f509a0d9cc8dd5",
  S14: "5dd7e5f73ed2cfb028f6b573ea3e06a5a85d12071d9b26624ead6652be2b318f",
  S15: "d536c40959d1db5147e7f1a4b0e5adbd85094fd65dc857d36be26b9a13b2e984",
  S16: "3cf4cfeedfa8ef5a5015f1efb6b05688b172a9b2799cc354d274ec325c1fb6e7",
  S17: "29773d9862b863c73b848cba7698b87ddb18ae8f74f3452e382f51058775274c",
  S18: "8626c2b203d031e331a40eaa5dbdc2b92f20ef340b9d33fe89fedf98c032adfd",
  S19: "81c889f061899a782f4c3689beb65732e2529d73be59715369b617d31dd44f4b",
  S20: "51167a3a4751d71718ca1e50b5c991ca0825e9efed407cb98b7310b5e8e24e41",
};

describe("the default document scenario set", () => {
  // The runner takes the catalog as it is when `--only` is absent and the set is `documents`.
  const resolved = selectedScenarios(SCENARIOS, undefined, "documents");

  it("is the whole catalog, in its order, with exactly the pinned scenario ids", () => {
    expect(resolved).toBe(SCENARIOS);
    expect(resolved.map((scenario) => scenario.id)).toEqual(Object.keys(FIXED));
  });

  it.each(Object.keys(FIXED))("%s equals its fixed digest", (id) => {
    const scenario = resolved.find((entry) => entry.id === id);
    expect(digestOf(scenario)).toBe(FIXED[id]);
  });

  it("is one deterministic digest over all of them", () => {
    // Key order and property order never matter, content does.
    const reordered = resolved.map((scenario) =>
      Object.fromEntries(Object.entries(scenario).reverse()),
    );
    expect(reordered.map(digestOf)).toEqual(resolved.map(digestOf));
    expect(digestOf(resolved.map(digestOf))).toBe(digestOf(Object.values(FIXED)));
  });
});
