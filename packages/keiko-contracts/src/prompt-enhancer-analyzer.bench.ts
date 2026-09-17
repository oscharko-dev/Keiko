// Permanent vitest bench for `analyzePrompt` at the enforced 100,000-char scan ceiling
// (`PROMPT_ANALYSIS_MAX_SCAN_CHARS`). KEIKO-1028, audit epic #2907, issue #3340.
//
// `analyzePrompt` runs dozens of substring scans over every request, up to the enforced ceiling.
// The accepted audit decision (#3340) is that the measured cost is real but bounded (~23ms at
// 100,000 chars on Node v24.18.0), sub-millisecond at realistic prompt lengths, and not material at
// Keiko's local-first, single-user desktop scale ahead of a network/LLM call — so no
// Aho-Corasick/alternation-regex rewrite is undertaken; that would risk behavioral drift across the
// 40+ keyword lists in prompt-enhancer-analyzer.ts for no justified gain. This bench exists so a
// future accidental slowdown (e.g. a new detector added without checking existing scan patterns)
// is *measurable* rather than silent — run it manually with `npm run bench:prompt-enhancer
// --workspace @oscharko-dev/keiko-contracts` before/after a change to prompt-enhancer-analyzer.ts's
// scan logic. It is not wired into any CI lane or npm test/lint run (vitest's own `include` glob
// never matches `*.bench.ts`), so a slowdown will not surface on its own without that manual step.
// The companion benchmark-fixture test proves the shared input reaches the scan ceiling; this file
// contains no correctness test or timing threshold because `vitest bench` only reports timings.

import { bench, describe } from "vitest";
import { analyzePrompt } from "./prompt-enhancer-analyzer.js";
import { PROMPT_ANALYZER_BENCHMARK_REQUEST } from "./prompt-enhancer-analyzer-benchmark-fixture.js";

// Adversarial near-miss input: dense with fragments that resemble the analyzer's cue keywords
// (instruction-override, tool-authority, egress, temporal-recency, market-price, retrieval,
// advice-seeking, structure/criteria/audience hints, ...) closely enough to force every detector's
// `containsAny` scan across the full string, without settling into a single short-circuited match —
// the representative worst case for a linear substring-scan analyzer, as opposed to a short or
// keyword-free draft. Repeated and truncated to exactly the enforced scan ceiling so the bench
// exercises the same boundary `normalizePromptDraft` truncates requests to.
//
// Every `*_CUES` list in prompt-enhancer-analyzer.ts is verified (KEIKO-1028, #3340 review
// follow-up) to resolve `containsAny`'s `.some()` with NO match against this unit, so each call
// scans its full list rather than stopping at the first hit — earlier drafts of this fixture
// looked like near-misses but were literal substrings of real cues (e.g. "is it legal-ish"
// contains the ADVICE_CUES needle "is it legal"; "exchange rate as of todayish" contains three
// separate TEMPORAL_RECENCY_CUES/MARKET_PRICE_CUES needles), which silently short-circuited most
// of those lists and under-measured the ceiling this bench claims to pin.
describe("analyzePrompt bench (KEIKO-1028, #3340)", () => {
  bench("analyzePrompt at the scan ceiling", () => {
    analyzePrompt(PROMPT_ANALYZER_BENCHMARK_REQUEST);
  });
});
