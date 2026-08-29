// Permanent vitest bench for `parseGitdirPointerTarget` — the `.git` linked-worktree pointer parse
// reconciliation.ts's safeGitdirIdentity uses (mirrors provisioning.ts's gitdirIdentity; S8786).
//
// A PR #3348 review finding on reconciliation.test.ts:260 caught that this repository's ONLY existing
// guard for this regression was a wall-clock bound on the WHOLE `reconcile()` call. That pin could never
// distinguish linear from quadratic regex cost: its fixture is a SUCCESSFULLY-MATCHING single-line
// pointer, so the parse itself resolves in microseconds regardless of the pattern — the wall-clock bound
// was actually dominated by two real `git` subprocess spawns via the real worktree adapter, not by the
// regex. This bench relocates the measurement to the one place a quadratic regression WOULD be visible
// if it existed here: the parse itself, isolated from file I/O and subprocess cost, imported directly
// from reconciliation.ts (never a hand-copied regex, so this bench can never silently drift from the
// parse it measures — AGENTS.md's fixture rule).
//
// HONEST RESULT — read before trusting this bench as an S8786 trip-wire: this bench does NOT reliably
// detect a revert to the pre-fix `/^gitdir:\s*(.+)\s*$/mu` pattern. Restoring it and comparing against
// the fixed `/^gitdir:(.+)$/mu` pattern was tested three ways — (1) this bench's own fixture shape run
// standalone before/after the source change, (2) a hand-rolled warm-up+median-of-N A/B harness, (3) both
// patterns benched side by side in ONE vitest-bench run, in both call orders — on Node v24.18.0. Method
// (1) showed no consistent direction; method (2) showed the pre-fix pattern ~15-30% SLOWER at every size
// from 5,000 to 1,600,000 padding characters; method (3) — vitest's own bench harness, the actual tool
// this file uses, cross-checked with the two patterns' call order reversed to rule out an ordering
// artifact — showed the pre-fix pattern ~8-22% FASTER at every size, stable under reversal. Three
// methods on the same question, two directions of "difference," and NO reproducible, consistently-signed
// gap: for a SUCCESSFULLY-MATCHING single-line input (the only shape this code ever actually parses — an
// unparseable pointer fails the literal `gitdir:` prefix check immediately, with no backtracking), the
// measurable cost difference between the two patterns is smaller than ordinary benchmarking noise, not a
// linear-vs-quadratic divergence. A sanity check against a KNOWN catastrophic pattern (`/^(a+)+$/` on a
// failing, ambiguous input) confirmed the measurement approach itself can detect real exponential
// blowup when it is actually present (0.04ms at 10 chars to 5072ms at 30 — the textbook signature), so
// this null result is a finding about these two SPECIFIC patterns in this SPECIFIC always-matching usage,
// not a blind spot in how they were measured.
//
// What this means: nothing measured here — not the original reconcile() pin, not this bench, at any
// input shape or scale tried — can dynamically distinguish the two patterns for how this code actually
// uses them. The durable guard against re-introducing the vulnerable shape is Sonar's STATIC analysis
// (`npm run gates:sonar`, mandatory before every PR per AGENTS.md), which is what flagged the original
// S8786 finding via the regex's structural shape, not via a demonstrated dynamic exploit in this
// codebase. This bench remains worth keeping as a stable, low-noise PERFORMANCE BASELINE for
// parseGitdirPointerTarget itself (isolated from subprocess/IO noise, it would show a REAL future
// regression — e.g. an accidental nested-quantifier rewrite, which the sanity check above confirms this
// approach can detect) — just not as proof that THIS historical before/after pair diverges.
//
// Sibling precedent: packages/keiko-contracts/src/prompt-enhancer-analyzer.bench.ts (KEIKO-1028, #3340).
// Same caveat applies here: this is NOT wired into any CI lane or npm test/typecheck/lint run (vitest's
// own `include` glob never matches `*.bench.ts`, and `vitest bench` does not run under `vitest run`), so
// a slowdown will not surface on its own without the manual step below. It asserts nothing — `vitest
// bench` reports timings, it does not pass/fail on them. Run manually with
// `npm run bench:reconciliation-gitdir-pointer --workspace @oscharko-dev/keiko-server` before/after a
// change to parseGitdirPointerTarget/safeGitdirIdentity's parse logic.

import { bench, describe } from "vitest";
import { parseGitdirPointerTarget } from "./reconciliation.js";

const TARGET = "/managed/root/some-repo-abc123/.git/worktrees/keiko-task-def456";

// Mirrors reconciliation.test.ts's adversarial pointer-drift fixture shape: `gitdir:` followed by a
// large whitespace run, the real target, then a second whitespace run — a successfully-matching
// single-line input padded on both sides of the capture group.
function paddedPointer(leadingSpaces: number, trailingSpaces: number): string {
  return `gitdir:${" ".repeat(leadingSpaces)}${TARGET}${" ".repeat(trailingSpaces)}\n`;
}

describe("parseGitdirPointerTarget bench (S8786, reconciliation.ts)", () => {
  bench("5,000-char whitespace padding", () => {
    parseGitdirPointerTarget(paddedPointer(2_500, 2_500));
  });
  bench("20,000+5,000-char whitespace padding (reconciliation.test.ts fixture size)", () => {
    parseGitdirPointerTarget(paddedPointer(20_000, 5_000));
  });
  bench("100,000-char whitespace padding", () => {
    parseGitdirPointerTarget(paddedPointer(50_000, 50_000));
  });
  bench("200,000-char whitespace padding", () => {
    parseGitdirPointerTarget(paddedPointer(100_000, 100_000));
  });
});
