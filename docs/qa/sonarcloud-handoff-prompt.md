# Handoff: SonarCloud Blocker/Critical Cleanup — Continue from PR #2306

Paste this to a fresh coding agent session (same worktree/branch:
`claude/sonarcloud-project-issues-93c25e`, PR
https://github.com/oscharko-dev/Keiko/pull/2306, base `dev`).

---

## Prompt to paste

You're continuing a SonarCloud Blocker/Critical cleanup for the Keiko repo. A prior session
already landed PR #2306 against `dev` on branch `claude/sonarcloud-project-issues-93c25e`. Read
this whole document before touching anything.

### Context

Source: 503 open Blocker/Critical findings at
https://sonarcloud.io/project/issues?issueStatuses=OPEN%2CCONFIRMED&id=oscharko-dev_Keiko. A full
investigation (not sampling) found that a literal "fix everything" is wrong — see
[`docs/qa/sonarcloud-blocker-critical-triage.md`](sonarcloud-blocker-critical-triage.md) (≈261
false positives / rule conflicts, each with per-finding reasoning) and
[`docs/qa/sonarcloud-complexity-followup-epic.md`](sonarcloud-complexity-followup-epic.md) (20
findings in two core-feature "hotspot" files deliberately deferred to a separate epic, not this
PR). Read both before making any further "fix" vs "leave as-is" judgment calls — the reasoning
patterns there (especially the hash-canonicalization exception, see below) apply to new findings
you might encounter too.

### What's already done and committed (PR #2306)

- `Web:S7930` (2), `javascript:S2819` (1) — trivial, verified.
- `typescript:S2871`/`javascript:S2871` — ~100 of 105 `.sort()` → `.sort((a,b) =>
a.localeCompare(b))` fixes. **Critical pattern**: ~26 call sites were correctly left as bare
  `.sort()` because they feed a SHA-256 digest / cache-fingerprint / canonical-serialization
  function — locale-aware sort is ICU/runtime-dependent and would break hash determinism. Full list
  with file:line and the exact hash consumer is in the triage doc §4. **If you touch any `.sort()`
  call anywhere in this repo, check whether its output feeds a `sha256Hex`/`createHash`/`canonical`/
  `stableStringify` function before "fixing" it** — this bit the first pass twice (once caught by
  agent judgment, then again by a test failure, then a third recovery pass caught ~22 more).
- `typescript:S2004` (22 of 22) — nesting-depth fixes via closure extraction, 7 files, all
  test-verified.

### What's NOT done — your job

**`typescript:S3776`/`javascript:S3776` cognitive-complexity refactor, partial.** The full
findings list (89 files, 116 findings, excluding the 2 deferred hotspot files) is split into two
tiers by complexity score:

- Low tier (complexity 16–30, 69 files, 78 findings)
- High tier (complexity 31–79, 20 files, 38 findings)

A recovery pass re-ran both tiers as parallel-agent batches, but was **killed mid-run** by a
session interruption before completion. **You must first determine exactly which files are
already fixed vs still original**, then finish the rest. Do NOT assume the lists below are
untouched — check each file's actual current state first (a fixed file has the flagged function
broken into small named helpers; an unfixed one still has one large function with deep
nesting/branching).

Full JSON finding lists (file, line, complexity) are saved at:

- `/private/tmp/claude-501/-Users-oscharko-dev-Projects-claude-workspace-Keiko-epic-1982-acceptance-analysis-c9f742/7f9c47d1-14ac-4b84-8a41-7e44d0c34ab1/scratchpad/pr4a_low.json`
- `/private/tmp/claude-501/-Users-oscharko-dev-Projects-claude-workspace-Keiko-epic-1982-acceptance-analysis-c9f742/7f9c47d1-14ac-4b84-8a41-7e44d0c34ab1/scratchpad/pr4b_high.json`

(If that scratchpad path is gone — it's session-scoped — re-derive the list from SonarCloud
directly: `typescript:S3776`/`javascript:S3776`, excluding
`packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorRuntimeWidget.tsx` and
`packages/keiko-workspace/src/codeIntelligence.ts`, which are the deferred hotspots.)

**Refactor rules** (apply to every file in these lists):

1. Zero logic/behavior change — extraction only, never change a branch, condition, or code path.
2. Pick the fitting pattern: (a) line/token parser → classifier + handler registry, (b) nested
   ternary/conditional-render decision tree → early returns + named predicates/render helpers, (c)
   validation with many branches → one small validator per condition composed in sequence, (d)
   React hook with nested side-effects → named module-scope helper functions taking explicit
   params (not closures over the whole component).
3. Extracted helpers must each individually satisfy this repo's ESLint `complexity ≤10` and
   `max-lines-per-function ≤50` (already enforced separately from Sonar's cognitive-complexity
   metric).
4. Match the file's existing style; Prettier 2-space/double-quote/trailing-comma/printWidth 100.
5. If unsure a refactor is behavior-identical (thin/no test coverage + risky extraction), don't
   force it — leave unmodified, report SKIPPED with the reason, move on.
6. Verify per file: run its own test file (same basename `.test.ts`/`.test.tsx`) or consumers'
   tests if none exists; scoped typecheck; scoped `eslint --max-warnings=0`.

**High-risk files needing extra care** (from the high tier):
`packages/keiko-contracts/src/task-workspace.ts` (authority/permission validation),
`packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx` (credential
handling), `packages/keiko-ui/src/app/components/desktop/hooks/workspace-persistence.ts` (data
persistence). Smallest safe extraction only; skip rather than guess.

### After finishing the S3776 batch

Run the full local gate suite per `AGENTS.md` §3 before pushing further commits:

```bash
npm run build:packages
npx tsc -p tsconfig.json --noEmit
npm run typecheck --workspace @oscharko-dev/keiko-ui
NODE_OPTIONS=--max-old-space-size=8192 npx eslint . --max-warnings=0
npm run format:check
npm test                    # NOT yet re-run after PR #2306 — do this before merge
npm run arch:check
npm run arch:check:negative
npm run test:coverage:ui    # keiko-ui touched
npm run check:editor-release-evidence  # keiko-ui/keiko-editor touched
```

Then update `docs/qa/sonarcloud-blocker-critical-triage.md` with any new hash-canonicalization
exceptions you find (same table format as §4), commit, push to the same branch, and update PR
#2306 (or open a follow-up PR if you prefer smaller review chunks — either is fine, just say which
in your summary).

### One more thing: an unresolved environment anomaly

During the prior session, an unexplained external `git reset` repeatedly wiped uncommitted
working-tree changes (visible in `git reflog` as repeated `reset: moving to HEAD` entries not
caused by that session's own commands). Root cause was never identified. **Commit your work
incrementally and more frequently than you'd normally need to** — don't let more than one file's
worth of unverified work sit uncommitted at a time if you can help it, until this is understood or
ruled out as no longer happening. If you observe it again, stop, capture `git reflog` output, and
flag it to the human rather than silently re-doing the work a third time.
