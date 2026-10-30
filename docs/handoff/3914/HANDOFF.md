# Keiko #3914 — complete agent handoff

Prepared 30 October 2026. Latest state observation: approximately 11:00 CET (Europe/Berlin). The operator requested **handoff only**: the outgoing agent is not doing further implementation or delivery.

## Start here

Continue accepted epic [#3914](https://github.com/oscharko-dev/Keiko/issues/3914), using **keiko-web**, `keiko-epic`, `keiko-issue` and independent `keiko-issue-audit` review. Read this file first, then the current GitHub delivery amendment, then the target's current instructions. This is a continuation, not a restart or a new design exercise.

**Actual immediate state:** the checkout is clean at a signed private checkpoint. The latest full policy qualification has **finished and failed** with `symbol-source-budget`; there is **no live proof process to wait for**, and no full current qualification result to reuse. Do not rerun the identical expensive command without an evidence-backed reason or repair.

Use this exact worktree:

```text
/Users/niko/.codex/worktrees/anti-slop-policy/Keiko 2
```

Do not operate on the other user checkout at `/Users/niko/Documents/ChatGPT/Keiko 2`.

The durable handoff directory contains `Evidence/` and `EVIDENCE-INDEX.json`. Those are selected copies of current proposals, command captures, reviews and the previous passing qualification. The complete historical scratch tree remains at:

```text
/tmp/keiko-3914-intake/osv-security-repair-557932c-20261023
```

Call that directory **S** below. S has about 14 GB of historical material; it was not all duplicated. Preserve it. Earlier numbered fields in `S/RESUME-CURRENT.json` are historical; its updated `readFirst` and `currentQualification3598` take precedence. The durable copy is `Evidence/RESUME-CURRENT.json`.

## User choices and authority — preserve across the handoff

- Drive the whole epic autonomously through accepted implementation, local verification, independent finding/fix/recheck and required CI. Do not seek routine approval for in-scope repairs.
- The operator **removed the fixed three-repair-attempt limit for #3914 only**. This override is already published in the epic milestone and the current issue precedence. Continue useful, safe, evidence-backed repairs; park/reassess work when there is no credible benefit or disproportionate complexity/delay. Do not change the global skills/hooks/workflow repository just to implement this exception.
- Preserve all quality gates, regression pins, budgets, architectural boundaries and authority. An ADR mismatch alone does not justify broken code: fix verified defects and amend the affected existing ADR sections, without inventing a superseding ADR just to repair stale prose.
- No hosted `@Codex` reviews. Use an independent local reviewer agent who did not author the implementation. The user explicitly authorized reviewer agents to post findings as GitHub PR comments. The orchestrator harvests/delegates repairs; the reviewer rechecks and records fix references or evidenced refutations. Confirmed unresolved findings block delivery.
- No Sonar organization/settings/plan changes. Fix actual findings. Local `gates:sonar` remains mandatory where required.
- Naming/spacing additions and broad ordinary-test assertion migration remain excluded.
- Extended inherited-getter/prototype hardening of the workspace manifest was explicitly deferred. Do not resume that optional hardening as an implicit prerequisite.
- The operator approved this Mac as the replacement performance reference, with truthful documented calibration/comparison. That did not authorize silently widening failing performance ceilings.
- The duplication analyzer **preserves string literal values**. The comparison ruler is immutable; see below.
- The user authorized keeping the Mac awake during work. The old timed assertion expired; do not assume it is still active or change security settings.

### Governing delivery topology

Read the authoritative [current milestone](https://github.com/oscharko-dev/Keiko/issues/3914#issuecomment-6092578365), the top of #3914, and rollout [#4145](https://github.com/oscharko-dev/Keiko/issues/4145).

1. **Phase A:** the original twelve implementation children retain their child-to-epic targets/dependencies. #3991 establishes complete green **implementation-ready** evidence. It does not mean the epic has been delivered to dev.
2. **Phase B:** #4145 is blocked by #3991 and is **not** an additional Phase A prerequisite. Deliver dependency-safe scoped PRs from then-current dev, reconciling all current packages/sources and all 22 rule dispositions. Every dev PR keeps **auto-merge OFF for human review**; only explicitly authorized `oscharko` may integrate.
3. No early dev PR, no duplicate omnibus epic PR after the scoped rollout, no direct dev push, force-push, required-check bypass or silent finding dismissal.
4. Before child integration, complete the accepted child scope, local/touched-area gates, independent audit, full exact-head target required matrix and settled reviews. Partial stage evidence cannot close the child.
5. Finish rollout only with actual post-merge results and fresh final-current-dev coverage, Sonar and full qualification evidence. Green contributor checks do not confer dev integration authority.
6. Reconcile moving dev at safe workstream checkpoints and before #3991. Never edit/fetch/integrate/build or run architecture negative probes during a source-bound qualification.

Git/Memory Governance/SDK/MCP production ownership belongs to #3933; their backend/CLI/tooling test seams belong to #3920. Earlier 27-package counts and original file/proof counts are historical, not coverage ceilings.

## Latest instructions

The latest user-provided AGENTS.md **replaces earlier user-provided AGENTS.md instructions**. Preserve its owner-only dev integration, working-code-first ADR convergence, no gate weakening, logging, source-currentness and local-first requirements. In particular it includes:

- ADR-0181 managed MCP host ownership: `keiko-mcp` depends internally only on contracts/security; official MCP SDK imports are confined there. Server composition retains catalog/binder admission.
- Current redaction behavior, including prose/Markdown declaration recovery under ADR-0022/#3900.
- Current Coding Workbench history-tail projection, editor bridge/queue, windowed diff and line-ending evidence. Do not drop those when syncing dev.
- Editor retirement and remaining shared consumers must be reconciled from current accepted code; do not revive a parallel subsystem.
- Read `EXPERIENCE.md` before applicable performance/export/workflow/coverage edits.

`Evidence/AGENTS-remote-dev-e153759.md` is a read-only snapshot of the observed remote dev file, **not** a claim that it exactly reproduces every user-supplied instruction. The worktree's checked-in governance predates the latest remote dev. Read current target docs and the accepted human instructions before further edits, and reconcile at a safe sync; do not fabricate documentation convergence.

Skills:

```text
/Users/niko/.codex/skills/keiko-epic/SKILL.md
/Users/niko/.codex/skills/keiko-issue/SKILL.md
/Users/niko/.codex/skills/keiko-issue-audit/SKILL.md
```

Their generic three-attempt text and older single-final-PR examples are overridden for this run by the explicit user choices and current published amendment. Retain independent audit and all quality/authority requirements.

## Branches, checkpoints and remote state

| Item | Verified state |
| --- | --- |
| Worktree | `/Users/niko/.codex/worktrees/anti-slop-policy/Keiko 2` |
| Current private branch | `codex/3918-private-dev-sync-20261029` |
| Current HEAD | `6dfe5f2bf7ffdd41b676d6c338166b66421cd5ea` |
| Signing / working tree | `G` / clean; no merge in progress |
| Remote child PR | [#4013](https://github.com/oscharko-dev/Keiko/pull/4013), OPEN, DRAFT, unmerged, auto-merge null |
| Remote PR branch | `codex/issue-3918-boundary-responsibilities` |
| Remote PR HEAD | `557932c54df23cafbac73faf3c2922185463ddcd` |
| PR base | `codex/epic-anti-slop-quality` |
| Immutable epic comparison | `8c710e085378941dc42e62ec1b5a92d5e012140b` |
| Last dev integrated privately | `6c8634b86194d219c325248f78b4f1060677a5a2` |
| Fresh remote dev observation | **`e153759e6daf10a8c6774433b9702fd56de38651`** — advanced; NOT integrated or qualified here |

Fresh remote snapshots: `Evidence/3600-handoff-pr4013.json`, `3600-handoff-remoteDev.json`, `3600-handoff-children.json`.

The remote PR has **not** received the private current checkpoints. Never attribute private results to remote557932c. The three refs remote557932c, immutable8c710e and integrated6c are all verified ancestors of current HEAD. `git rev-list remote557..HEAD` reports 164 commits including imported dev history; this is not 164 newly authored repair commits. Preserve history; no rewrite/force-push.

Recent signed private checkpoints, newest first:

- **6dfe5f2b** — exact conversation fixture inventory repair (3 owners), current.
- **34833c04** — four runtime command/readiness public boundary proof records.
- **67af8dd3** — fresh paired tool-catalog performance evidence.
- **f3dc3610** — signed private merge of 14161a4b + accepted dev6c; all 21 conflicts resolved.
- **14161a4b** — earlier private workspace proof consolidation.

### Child state observed at handoff

| Issue | Title | State / ownership |
| --- | --- | --- |
| #3915 | Establish quality policy, clean guards and the epic CI delivery path | closed; Niko4417 |
| #3918 | Define boundary policy and migrate the shared contracts leaf | OPEN, in progress; Niko4417; current work |
| #3928 | Migrate security, evidence, activity-log, catalog and sandbox owners | open, unassigned |
| #3933 | Migrate domain packages and their validated runtime ports | open, unassigned |
| #3943 | Migrate server composition, validation and repository boundaries | open, unassigned |
| #3919 | Enable typed UI safety analysis and complete UI production migration | open, unassigned |
| #3955 | Migrate CLI and manual Editor production contracts | open, unassigned |
| #3920 | Define test-seam policy and migrate backend, CLI and tooling tests | open, unassigned |
| #3976 | Migrate UI tests to owned framework and IO seams | open, unassigned |
| #3988 | Qualify all five Effect rules in the pinned native host | closed; Niko4417 |
| #3989 | Qualify accumulator cost, performance and optional-field omission | open, unassigned |
| #3991 | Activate full enforcement and prove integrated production quality | open, unassigned |
| #4145 | Deliver anti-slop adoption to current dev through scoped PRs and drift control | open, unassigned; Phase B |

Only **2/12 Phase A children** integrated. Downstream readiness is not established by this handoff. Refresh assignments/dependencies and target branches before claiming another issue.

## Immediate blocker: full qualification 3598

The latest canonical command is retained in `Evidence/3598-core-four-inventory-repaired-whole-qualification.json`:

```text
npm exec --offline -- node \
/tmp/keiko-3914-intake/conversation-fixture-inventory-qualification-tooling-20261030/invoke.mjs \
/tmp/keiko-3914-intake/osv-security-repair-557932c-20261023/3597-inventory-repaired-whole-request.json
```

It ran through the existing outer `capture.py` in the exact worktree with the pinned Node/npm, against signed **6dfe5f2b**:

- CLOSED exit **2**, **942.1250739097595 seconds**.
- Failure **`symbol-source-budget`**, during responsibilities / canonical qualification.
- Semantic build, tool identity, complete subject inventory, package inventory, native scan and raw assessment completed before failure.
- Before/after Source, emitted outputs and Git state are exact: **9,215 source/file members, 7,281 output files**. These are observed counts, not ceilings.
- Child, per-command awake process and owned process group all closed.
- Current policy hash: **`38cbfc98ce275d0a6f4ec6ab58380c2d28a6a0171718e7635549f24f44eed564`**.
- **133 declared records / 655 proof selectors remain prospective.** No current canonical report was returned, no current qualified total exists, and the same-LIVE-report four-rule replay did not run.
- Output directory has only `canonical-policy.json`, `execution-bindings.json`, `inconclusive.json`, `artifacts.json`.
- Do **not** execute prepared runtime-witness audit3599 now: it needs a complete current canonical report, which is absent.

The previous attempt3577 failed much earlier with `unclassified-source`; the exact fixture repair fixed that inventory blocker. The newer source-budget failure is distinct. Do not claim the whole gate passed because an earlier phase or the owning tests passed.

### Next useful action

Investigate the **actual current** source-budget admission that fails in3598 with a bounded, nonpublishing diagnostic. Preserve the original current full subject, current dev bindings and the unchanged **64 MiB** source cap, node/Program/alias/root/depth/proof/output limits. Identify actual charged source paths/bytes/owners and whether unnecessary traversal or incorrect charging exists before proposing a repair. Do not infer the cause from old pre-dev-sync diagnostics or simply repeat the 16-minute unchanged qualification.

The prior capacity engine has several reviewed repairs already landed privately (including producer-public-exposure-first, zero-edge module admission and the separately approved connected multi-root state union). Reuse that implementation; do not undo safeguards or build a second resolver. The user has removed the fixed attempt cap, so a credible in-scope repair does not need another routine cycle approval. Stop/park attempts without a credible benefit.

Once an actual repair is justified: freeze the required complete owner/caller/proof/configuration context; measure the current file/form census; obtain independent Source review; demonstrate meaningful old/new regression behavior; preserve old pins and all strict limits; run applicable gates and real local Sonar; sign a scoped checkpoint; metadata-rebind only genuinely changed engine hashes; perform complete canonical qualification on the current subject and the same-LIVE-report prospective replay. No partial/JSON-rehydrated report, subset, scope reset, budget increase or source omission substitutes for it.

Moving dev has advanced to e153759. The next agent must choose a safe reconciliation checkpoint under the accepted workstream plan, inspect changes/conflicts and current dev baseline evidence, and refresh affected context and gates. Do not call the private6c-based candidate “current dev qualified.” No sync was attempted during handoff.

## Latest completed repair: C-002 inventory classification

Finding remains an OPEN ordinary PR comment:

https://github.com/oscharko-dev/Keiko/pull/4013#issuecomment-6513199931

It names a **private candidate**, not remote557932c. Do not silently close or duplicate it. The independent reviewer should disposition its scoped fix truthfully with signed6dfe and actual evidence, while explicitly retaining the distinct3598 capacity blocker and broader readiness limits.

Cause: new dev fixture `packages/keiko-server/src/tool-catalog/__fixtures__/conversationConsumer.ts` was not in the existing exact test-infrastructure set. Its dormant test-only imports promoted `tests/support/buffered-server-log.ts` into production and correctly caused `unclassified-source`. Current real callers were tests.

Fix at **6dfe5f2b**, ONLY3 owners:

1. `scripts/lib/code-quality-inventory.mjs`: add the one exact fixture path. No directory exclusion or source census omission. Real runtime/public exposure still overrides test classification; an exposed chain reaching unsupported root test infrastructure still fails closed.
2. `scripts/__tests__/code-quality-inventory.test.mjs`: preserve the original77 cases, reuse three existing fixture builders via defaulted exact path arguments, add six meaningful cases; replace obsolete27-package pin with exact sorted names from existing `collectWorkspacePackages` and uniqueness. No >=, fixed28 ceiling or copied discovery formula.
3. `docs/qa/code-quality-policy.md`: describe classification, promotion and complete-membership behavior; no qualification clearance claim.

Source proposal:

```text
/tmp/keiko-3914-intake/conversation-fixture-exact-inventory-source-proposal-20261030
```

Manifest SHA `dfd1bda003e333aa3a999d374f59536a58ae3be59d7fcb18df5c00d352a658e0`.
Root formatted mirror: `S/3585-conversation-fixture-formatted`.

Actual proof:

| Capture | Actual result |
| --- | --- |
|3583 original whole inventory suite|77 total,76 pass,1 actual-workspace unclassified-source failure|
|3588 final candidate census/formatter structural AST|26 Primary +2 governance,28 forms,0 parse errors; formatter runtime AST exact|
|3589 new tests + OLD engine|83 total,76 pass,7 intended failures (old actual workspace plus all6 new controls),0 skips|
|3590 new tests + repaired engine|83/83 PASS,0 skips; all77 old ordered names retained|
|3591 owning ESLint|PASS,0 warnings|
|3592 all3 formatted owners|PASS|
|3593 full native typecheck|PASS9.65s; package graph28; Source/output/Git exact|
|3594 real local Sonar|PASS283.19s, no unresolved finding on changed files|
|3595 real CLI wiring smoke|PASS5.78s|
|3596 scoped signed commit|G,6dfe, clean, no publication|

All completed command captures have exact Source/output/Git guards and closed owned process groups. Independent Source review3584 and owning actual review3592 both approved0 findings. All original76 healthy five-field case vectors were retained, not merely case counts. Negative chain tests fail their positive dormant precondition on old code, so they cannot falsely pass by rejecting an already-broken input.

Two external formatter-verification helper attempts3586/3587 failed because a printer retained formatting and the structural comparer included SourceFile's full text. They made no Main/output/Git changes and were not product failures. Corrected3588 excludes full SourceFile text while comparing structural nodes/literals and passed. Keep the record honest; do not count the failed helper as a green gate.

Final inventory code hash: `9b16ffc0b517b994a22613df509f8896d9739df7b6723fcb2407f948959473a2`.
Final formatted test hash: `0a26c435cf54b1c2bfa4f43ded59d8fcb50205d1608f4427151a679afadba484`.
Final QA hash: `8ab3facaba3b261f64453635835598601ff35834c3a0283aaa6f6a2148995c53`.

## Four runtime command/readiness boundary records

Checkpoint **34833c04** changes only the existing API.test, policy JSON and QA docs. Product parser bodies were unchanged.

- `parseCodingWorkbenchCommandRequest`
- `validateCodingWorkbenchRuntimeCommandsChannelPayload`
- `parseCodingWorkbenchRuntimeReadinessRequest`
- `validateCodingWorkbenchRuntimeReadiness`

Ten additive cases exercise existing public runtime subpaths, admitted identity, optional ownership, malformed values, forged physical arrays, read/throw identity and closed type arms. Five wrong-arm `@ts-expect-error` controls are consumed by the native typecheck. Original129 records/635 selectors remain exact; four appended records yield **133/655 declarations**, not qualified totals.

Actual owning suite210/210, native typecheck, target lint/format and real local Sonar3574 passed. Full current qualification is blocked as described above. These records do not close all remaining runtime API, Chat or MCP obligations.

All four prospective activation scopes remain `[]`:

- `anti-slop/no-runtime-typeof`
- `anti-slop/no-known-value-widening`
- `anti-slop/no-unsafe-dictionary-type`
- `anti-slop/no-unknown-parameters`

Do not activate until current whole qualification and full prospective result justify it.

## Qualification tooling and runtime witness audit

Reviewed current tool directory:

```text
/tmp/keiko-3914-intake/conversation-fixture-inventory-qualification-tooling-20261030
```

Manifest SHA `8b651b86a3e0b8ca4e743e108ed31b6a1689f8184994c6c5a4b921cf594756d0`.

- `measurement.mjs` SHA `4dffbd247210920eefefc10a87b05ced086924965c3172a310067ccd85ff2aca`
- `invoke.mjs` SHA `e61bbf1d36c3eb7ec5b50e534c469d09eda483ae658fde30394d22722a7790ba`
- These executable bodies are unchanged from the earlier independently reviewed tool.
- Among13 engine pins, ONLY inventory.mjs was rebound after C002. Other12 pin identities are exact.
- Core40 inputs retain38 Primary+2 governance; only QA changed. Two separately bound ToolchainInputs carry inventory/test and their26+2 reviewed context. This is not a fabricated42-file Source audit.
- Required options remain repository/enforce/qualifyResponsibilities/progress. No cap, rule/scope, expected-count or code changes.
- Independent metadata review `3594-independent-c002-tool-rebind-review.json` approved0 findings.
- Future requests must derive the actual signed HEAD/current policy/record IDs, not reuse3597 after Source changes.

**Known wrapper limitation:** it only requires a nonempty runtime witness. The lead must independently derive the exact witness from current canonical producers and all fresh output mappings.

Prepared and independently reviewed helper:

```text
S/3599-current-runtime-witness-audit.mjs
```

It has **NOT** run and cannot run against failed3598's missing report. After a genuinely complete future qualification, adapt request/artifact filenames truthfully, review the small change, and execute only after the outer proof process closes. Its required derivation mirrors existing `proofRuntimeWitness` in `scripts/lib/code-quality-responsibilities.mjs`:

1. Collect assessment `roles.input.identities[].producer.path`.
2. For exactly `raw-own-property-reader` and `raw-canonical-json-decoder`, include output identities as well.
3. Filter **ALL** fresh canonical `collectPolicySubject(root).outputs` mappings for those producers.
4. Require JS and d.ts outputs for every producer; compare exact unique logical membership and each current byte hash against execution.runtime and outer-captured outputs.
5. Verify current full inventory digest, full scope, subject, passed single execution and complete outer closure/currentness.

Do not substitute historical138, forecast141, a static dependency closure or all7,281 emitted files for the actual expected runtime witness. Counts are derived facts, never the expected membership rule.

Previous complete qualification3434 passed129 records/635 selectors at older **f150** subject. Its report/prospective partitions are copied for historical comparison under `Evidence/3434-four-rule-actual-measurement/`; they **do not qualify current6dfe**. Some older capacity issues were cleared there; broader helper migration and current-dev changes remain.

## Earlier recent work already completed — do not redo or drop it

### Current-dev private merge and C-001

Private f3dc361 integrated dev6c into14161. All21 merge conflicts were resolved and independently reviewed. Important retained work includes current Jira/DC/Cloud changes, shared managed MCP Settings/custody/generation, typed activity registry helpers, signal-aware SSE draining/cancellation, metered tool ports and Memory correlation. No new policy exceptions were invented.

The merged dev build exposed `chat-tool-authority.ts` importing the removed unsafe generic `result` helper. C-001 repaired six public function facades/seven sites through existing `validateWithAdmission` plus concrete guards. Original tests remained, plus9 meaningful boundary cases. Do not restore the unsafe generic/casts. Two test type compatibility repairs and five type-only lint annotations preserved actual runtime behavior and test vectors.

C-001 scoped private resolution:

https://github.com/oscharko-dev/Keiko/pull/4013#issuecomment-6511743099

It is not whole-PR readiness. Latest relevant actual rechecks include787 contract cases,191 server/SSE/tool/sync cases,350 diagnostics fixture cases and463 combined owner/registry cases, all passing with0 skips. These suites overlap; do not sum them into a unique total. Full typed ESLint+UI3553, whole formatter3555, architecture negative3557, native typecheck3558 and full architecture aggregate3563 passed their actual earlier subjects. They do not substitute for new touched-scope/current qualification.

Real generators rebuilt the activity catalog with0 typed/name violations,641 resolved proofs/30 scenarios; support inventory was generated, never hand-edited. Existing history gained the legitimate v1.3.2 snapshot, preserving14 earlier rows for15 total. Counters are historical facts, not limits.

### Tool-catalog performance evidence is fixed; coding-runtime performance is not

Official paired producer3561 ran both actual baseline **6c** and candidate **f3** on this18-core/64GiB Mac under the same current ruler. All12 baseline/candidate P95 coordinates passed the unchanged six ceilings and maximum values. Only3 owned JSON artifacts changed, signed67af8dd. Full architecture3563 then passed. Independent actual review3563 approved0 findings.

The older reference213d was not an ancestor; the comparator was correctly changed to the accepted incoming dev6c for this future pair. That does **not** change the immutable duplication ruler8c.

The procedure ran `npm ci --ignore-scripts` and builds in baseline/candidate. Before later native product qualification, verify required provisioned runtimes; do not assume all postinstall/native dependencies are ready. A retained baseline build path appears in resume evidence, but revalidate its existence before use.

### Native performance finding005 remains OPEN

The separate coding-runtime reference evidence remains RED. Last documented18-core/64GiB32-launch measurements were approximately cold2744ms vs1423ms ceiling, throughput170ms vs76.7ms. A matched older-dev/same-harness run also failed; the cause was not proven. A shell-to-native delay observation is not a root-cause proof. Do not publish stale/failed artifacts, loosen ceilings merely to pass, alter platform security settings or run another full matrix without a concrete hypothesis.

Three dirty failed native JSON artifacts were archived byte-for-byte under `3490-dirty-native-performance-archive/` before restoring the signed historical family. The tighter first-byte ceiling in those provisional results must not silently be loosened by a future calibration. Archives are evidence, not clearance.

## Duplication and other residual work

The immutable comparison is **8c710e085378941dc42e62ec1b5a92d5e012140b**, Fallow3.35/schema13, thresholds **100 tokens /10 lines /2 occurrences**, **preserve string values**, **zero introduced groups**. Current-dev comparison or rollout slicing cannot reset this ruler or excuse new duplicate groups.

Last strict221 introduced/799 inherited was measured on **14161 before dev merge**. It is historical. **6dfe has not been freshly measured.** Do not report221 as current or infer zero introduced from local tests.

Broader helper-component finding008 and migration remain open. Old prospective residual2914 was an older-subject measurement, not a current count. All22 rule dispositions and full accepted contracts production migration still need current complete reconciliation. New Chat/MCP source may require additional roles/migration; Core4 does not close them. No whole-child completion, UI/coverage/full Activity Log closeout or exact-head remote required-CI readiness is claimed.

## Prepared next runtime API slice — mapping only

An idle author mapped three existing boundaries, without edits, AST/compiler/test execution or a new Source proposal:

| Candidate responsibility | Existing producer |
| --- | --- |
|runtime-revert-channel-public-parser|validateCodingWorkbenchRuntimeRevertChannelPayload|
|runtime-inbox-request-public-parser|parseCodingWorkbenchRuntimeInboxRequest|
|runtime-inbox-channel-public-parser|validateCodingWorkbenchRuntimeInboxChannelPayload|

Only no-unknown-parameters was suggested for these existing typed public parsers. Do not fabricate a fourth: `CodingWorkbenchRuntimeRevertRequest` is an interface and typed UI POST input, but no corresponding request parser exists in the frozen API. The action predicate is not an equivalent request parser.

Preserve current inbox request/listing cases, physical-array/forged-forEach controls and consumed-revision pins (exactly two reads, receiver identity). Reuse existing tests and helpers.

**Important correction to the initial frozen-context map:** dedicated `packages/keiko-contracts/src/coding-workbench-runtime-revert.test.ts` already validates healthy/unpaired/count bounds and14 malformed/path-smuggling cases. It was outside Core40. Extend/reuse it rather than duplicating all of it in API.test.

Actual reference search found:

```text
packages/keiko-contracts/src/coding-workbench-runtime-api.ts
packages/keiko-contracts/src/coding-workbench-runtime-api.test.ts
packages/keiko-contracts/src/coding-workbench-runtime-revert.test.ts
packages/keiko-ui/src/lib/coding-workbench-runtime-api.ts
packages/keiko-server/src/coding-runtime/codingRuntimeRoutes.ts
packages/keiko-server/src/coding-runtime/codingRuntimeRoutes.test.ts
packages/keiko-server/src/coding-runtime/codingRuntimeOperationCoordinator.ts
packages/keiko-server/src/coding-runtime/opencodeInbox.test.ts
packages/keiko-server/src/coding-runtime/opencodePromptInputs.test.ts
```

Additional context includes UI runtime-api.test/deadline.test; coordinator tests; owning inbox/revert implementation/tests; ADR-0141 and relevant ADR-0137 sections. Do not use guessed `orchestrator.ts` (no such file there). Before authoring, freeze the actual minimal complete owner/caller/proof/configuration closure, run the real census and split if necessary. Resolve the current budget blocker/current qualified mapping first; this is not permission to add records on stale context.

## Tools, execution discipline and process ownership

Pinned PATH prefix:

```text
/Users/niko/.local/share/keiko-toolchains/node-v24.18.0-darwin-arm64/bin
```

Observed npm11.16, TypeScript API6.0.3, native compiler7.0.2. Use npm only. The canonical policy invocation requires the real npm environment. The existing `S/capture.py` sets the pinned Node/Docker/Homebrew paths and captures complete Source/output/Git state, owned process closure and log hashes. Use a fresh unique key for every command; never overwrite a result. Build output changes need its explicit `--allow-output-change` and actual review, not a blanket mismatch excuse.

The lead is the sole Main/index/generated-output/AST/compiler/native/heavy-command owner. One actual heavy command at a time. Agents can author disjoint external frozen proposals or review read-only; tell them they are not alone and must preserve others' work. Do not run another compiler/parser/build/negative probe while full source-bound qualification is live. Finish `arch:check:negative` and confirm its temporary probe is gone before the qualifier.

General accepted authoring ceiling:40 complete Primary files/350 conservative TypeScript forms. Count actual whole owners/callers/proofs/configuration, not only edited hunks. The Memory-only exception is60/1000 for coherent accepted Memory safety/logging repairs. It does not apply to general analyzer/runtime API work. No parser errors, omitted context, expanded activation or gate/suppression/baseline relaxation.

Signed commits required. Current signing configuration worked and HEAD is G. The existing `S/signing-env.json` is0600 and contains only the agent socket environment; **it was intentionally not copied into the handoff bundle**. If reusing, read it privately and merge only the required environment; never print it. It may have expired. Do not change global Git identities, keys or security settings to make a command pass.

Default SSH Git authentication previously returned publickey denied, while existing authorized `gh api` worked. Use the existing authorized CLI/per-command HTTPS credential mechanism if necessary; never print tokens or change global credentials. GitHub connector previously returned403 for comment publication; authenticated gh body-file fallback was used. Write exact multiline comments to a file and use `--body-file`.

No active process remains from3598. Its old exec session12210 is historical; do not attempt to wait on it in another agent. The old per-command awake assertion closed. The separate timed PID93671 assertion expired04:15UTC; do not kill an assumed/reused PID. Revalidate identity before any cleanup. No security settings were changed.

The local goal tool snapshot at handoff reports **blocked**, with the epic objective incomplete. That administrative state is not a new acceptance decision or a completed epic. This handoff did not alter it. A receiving agent should explicitly resume under the user's continuation instruction and its own goal context, preserving all current scope/authority. Do not mark complete just because a handoff was written.

## Suggested restart sequence

1. Read this handoff, current milestone/epic/#3918/#4145, newest user AGENTS instructions, current target AGENTS/CONTRIBUTING/relevant ADRs. Revalidate assignments, refs, clean signed HEAD and source/output state.
2. Recognize3598 is CLOSED/RED with symbol-source-budget; preserve its evidence. All author/reviewer subagents are completed. Use fresh independent reviewers in another thread; old agent IDs are not guaranteed transferable.
3. Reconcile the newly advanced remote dev and the accepted dependency/scope plan at a safe checkpoint. Preserve current/private and other contributors' changes, all review fixes, logs, registry ownership, redaction and managed MCP. No dev PR now.
4. Diagnose current budget admission before another unchanged full call. Independently review a small credible repair if one exists; no routine three-attempt permission loop.
5. Recheck/settle C002 explicitly with fix reference and scoped evidence; keep the distinct capacity failure/other findings open. No whole-PR green claim.
6. Complete genuine whole current-subject qualification, fresh exact runtime-witness audit and same-LIVE-report prospective assessment. Then sequence remaining bounded migrations and all accepted checks/duplication work; activate only when justified.
7. Complete #3918 and subsequent Phase A children under their required audits/current-head CI. After #3991, execute #4145 scoped dev rollout with all dev auto-merge OFF for owner human review. Preserve fresh post-merge/final-current-dev evidence before epic completion.

## Evidence navigation

`EVIDENCE-INDEX.json` gives byte counts and SHA-256 for every selected copied file. Copies retain their original embedded absolute paths/provenance; do not silently rewrite them or call historical material current. If `/tmp` disappears, restore/rebind the selected originals deliberately from the durable bundle before invoking a path-bound tool; do not blindly run old requests.

High-value durable entries:

- `Evidence/RESUME-CURRENT.json` — updated latest actual state; older fields remain historical.
- `Evidence/3598-core-four-inventory-repaired-whole-qualification.json` and `...log`, `...before.json`, `...after.json` — current failure and exact full guards.
- `Evidence/3598-core-four-inventory-repaired-whole-measurement/` — current inconclusive artifact set.
- `Evidence/3597-inventory-repaired-whole-request.json` — exact current request; do not reuse after changes.
- `Evidence/3596-inventory-signed-checkpoint.json` — current signed checkpoint.
- `Evidence/3592-independent-c002-owning-actual-review.json` and `3594-independent-c002-tool-rebind-review.json` — independent scoped approvals.
- `Evidence/3584-independent-conversation-fixture-source-review.json` — independent Source audit.
- `Evidence/3599-current-runtime-witness-audit.mjs` and `3599-independent-runtime-witness-audit-source-review.json` — prepared future audit, NOT executed.
- `Evidence/conversation-fixture-exact-inventory-source-proposal-20261030/` — complete Original/Candidate/inverse/manifest.
- `Evidence/conversation-fixture-inventory-qualification-tooling-20261030/` — reviewed current tool and bindings.
- `Evidence/current-runtime-api-four-boundaries-rebind-20261030/` — Core4 proposal/context/provenance.
- `Evidence/3434-four-rule-actual-measurement/` — OLD passing qualification/prospective report, historical only.
- `Evidence/3490-dirty-native-performance-archive/` — retained RED native evidence, not gate clearance.
- `Evidence/3600-handoff-*.json` — fresh PR/dev/child observations.

Full older Source/diagnostic/fixture/performance packets remain under `/tmp/keiko-3914-intake/` and S. GitHub comments and the repository Git history are the durable authority/evidence trail for prior accepted decisions. This handoff adds no approval gate or replacement workflow.
