# Handoff — Issue #2387 (governed research, skills, read-only subagents)

**Status: the RESEARCH capability is functional end-to-end (approval → grant → governed fetch →
revoke → fresh-approval-required) and covered by an owned Playwright journey. The skill and
read-only-child SERVER MODULES are complete and unit-tested but not yet reachable from the model
(no model-facing tool declaration). Remaining work is listed in §4.**

Branch: `claude/issue-2387-research-skills` (draft PR #2472 → `dev`). Base: dev `fa6fc15c` plus the
merged #2386 governance surface.

---

## 1. Scope of #2387 (from the issue)

A Code task can (a) research public documentation over a governed read-only egress, (b) invoke
server-approved skills, and (c) delegate to one-layer read-only subagents — all without inheriting
authority. Owns `tests/e2e/config/playwright.code-task-research-skills-subagents.config.ts` + a real
journey, emits `CodeTaskAcceptanceContributionV1` for #2396, produces `AuxiliaryCapabilityPortV1`
for #2388, consumes #2386 `GovernedActionV1`.

## 2. What is implemented and verified

Everything below passed root `typecheck`, `lint --max-warnings=0`, `prettier`, and its unit suites.

### Contracts (`packages/keiko-contracts`) — unchanged from the first handoff

`code-task-auxiliary.ts` (AuxiliaryCapabilityPortV1 + SSRF-safe predicates), the 4 runtime event
kinds + `CodingWorkbenchAuxiliaryStatus`, the `researchGrant` snapshot field +
`parseCodingWorkbenchRuntimeResearchRevokeRequest`, per-kind event validators, and the
research/skill/child evidence vocabulary. 3919 contract tests green.

### UI vertical (`packages/keiko-ui`) — unchanged (commit `888e0d39`)

`Internet · Research only` chip, timeline rendering, revoke client wiring, en/de catalogs.
**Note:** the keiko-ui change invalidates `check:editor-release-evidence` — regenerate the
fingerprint on CI/Linux before the `ui` gate can go green.

### Server modules — hardened (commit `62c91559`), still current

`researchEgressPort` + `researchGrantRegistry` (GET-only, redirect re-validation, request-line
binding, pre-flight budget reservation), `skillCatalog` + `skillInvocationPort` (exact id@version,
injected authority re-evaluator), `readOnlyChildEnvelope` + `readOnlyChildOrchestrator`
(strictly-narrower envelope, one-layer, parent budget, cascaded stop + post-run re-check).

### NEW in this continuation — the research capability wired end-to-end

- **Snapshot projection**: `CodingRuntimeOrchestrator` takes an optional `researchGrants` registry
  (`codingRuntimeOrchestratorTypes.ts`) and projects the aggregated live grant
  (`projectedResearchGrant`, newest grant id, sorted domain union, max expiry) through
  `CodingRuntimeOrchestratorState` — never on terminal/recovery states. Control plane threads
  `runtimeHost.researchGrants` through.
- **Revoke route**: `POST /api/coding-workbench/runtime/runs/:runId/research/revoke`
  (`codingRuntimeRoutes.ts`) → `orchestrator.revokeResearch`: bound to the observed revision AND a
  live grant id, fail-closed otherwise; drops every grant for the run in one revision bump.
- **Approval-driven grant issuance** (`researchApprovalIssuance.ts`): the egress port's new
  `onGrantMissing` seam hands an uncovered URL to `PendingResearchApprovals` (one transient,
  TTL-bound, one-shot ask per run; https + public-domain validated) and raises a content-free
  `permission-requested` runtime event (`network-egress`/`research`,
  reasonCode `research-approval-required`). The resolver wraps `approvalAuthority.issue`
  (`researchIssuingApprovalAuthority` in `productionCodingRuntimeResolver.ts`): an approved
  `research` action consumes the retained URL and mints a grant whose `queryTextDigest` is computed
  by the SHARED `researchRequestLineDigest` export — issuance and executor can never diverge. The
  validated `read-only-research` `GovernedActionV1` (grant known/once, `stateRevision` = the
  approval challenge's bound revision, threaded as `boundRevision` through
  `CodingRuntimeApprovalIssueRequest`) is produced for an optional sink (`onGovernedAction`,
  unwired until #2388 consumes the port).
- **Binding-aware grant selection** (`grantForRequest` in `researchEgressPort.ts`): among same-host
  grants the one whose digest admits THIS request line wins, so several per-URL approvals coexist;
  no binding → audited denial (fixes the first-grant-wins defect).
- **Model-facing tool**: `keiko_research_fetch` (action `egress`, argument `target`) declared in
  `OPENCODE_MODEL_VISIBLE_TOOLS` + `OPENCODE_TOOL_SOURCE_DEFINITIONS`; generated tool source,
  launch-profile allow/deny maps, gateway digest pins (`coding-sidecar-gateway.test.ts`), protocol
  allowlists, and the functional harness (`FAKE_TOOL_ACTIONS`, scripted turn union) all updated in
  lockstep. The governed delegate and facade now carry the egress payload back to the model
  (UTF-8-safe truncation at the 64 KiB IPC cap — `projectEgressRead` in `codingToolFacade.ts`).
- **Activation**: `codingRuntimeResearchEgressEnabled` server option (default **true**) opens only
  the `network-egress` action CLASS (`deps.ts` → `productionRuntimeWorkspaceAuthority`); every
  fetch still requires an operator-approved grant, so no approval ⇒ no outbound request.
- **Owned e2e journey**: `tests/e2e/config/playwright.code-task-research-skills-subagents.config.ts`
  - `tests/e2e/servers/coding-runtime-2387-server.mts` (real buildUiHandlerDeps composition, script
    mode `research`, hermetic `researchFetchImpl` test seam — no real network) +
    `tests/e2e/code-task-research-skills-subagents.spec.ts`: ask → approve → chip → governed fetch
    ("Research performed") → stale revoke 400 → revoke → fresh ask required → deny settles
    failed/revoked. npm script: `test:e2e:code-task-research-2387`.

## 3. Design decisions already made (do not re-litigate)

1. **Research grants are request-scoped, bound via the #2386 approval flow** (first handoff §3).
   Implemented exactly that way; both sides use `researchRequestLineDigest`.
2. **The approval loop lives at the egress-port/resolver seam, not inside `codingRuntimeManager`.**
   The manager's `issueApproval` stays untouched; the resolver wrapper is the one place that sees
   both the approval issuance result and the retained URL. (Deviation from the first handoff's
   letter, same semantics, smaller trust surface.)
3. **Research asks are approval-gated in EVERY mode, including autonomous-delivery** (narrower than
   the ADR-0129 ceiling, never wider; revisit when task-activation envelopes can carry pre-granted
   domains).
4. **Skill/child model tools need a real IPC vocabulary extension** (`codingToolIpc.ts` has no
   `skill`/`child` action) — deliberately NOT bolted onto `egress`. See §4.

## 4. Remaining work, in order

1. **Skill + child model-facing tools.** Extend `CodingToolAction`/`CodingToolActionRequest`
   (`codingToolIpc.ts`) with `skill` (argument `skillId`) and `child` (argument `objective` or a
   bounded request object), add the two `GovernedCodingToolPort`s to `CodingToolGovernedPorts`
   (`codingToolGovernedDelegate.ts`) and mount `skillInvocationPort` / `readOnlyChildOrchestrator`
   in `productionManagedWorktreeTools.governedPorts` (they need: the skill catalog, an authority
   re-evaluator over `resolveCapabilityForDelegation`, a child runner, and the parent budget
   charger — see each module's Deps interface). Declare `keiko_skill` / `keiko_child_agent` in
   `OPENCODE_MODEL_VISIBLE_TOOLS` + `OPENCODE_TOOL_SOURCE_DEFINITIONS` and update the SAME pin
   set as `keiko_research_fetch` (gateway digests, adapter unions, harness `FAKE_TOOL_ACTIONS`,
   adapter/launch/gateway tests). Then extend the owned e2e journey with the skill + child
   observation steps ("observe a skill and a child" from the issue).
2. **`CodeTaskAcceptanceContributionV1` for #2396.** No producer precedent exists anywhere in the
   repo yet (neither #2385 nor #2386 shipped one). The contract + consumer-side qualification rules
   live in `packages/keiko-contracts/src/code-task-acceptance.ts`. Coordinate the artifact shape
   with #2396 (likely generated at PR time — `sourceCommitSha` cannot be committed by the commit it
   names).
3. **`npm run test:mutation:security`** focused on the new authority/parser/containment code — run
   in CI, NOT locally in a loop (the security mutation gate OOMs local machines; see the repo's
   mutation-gate history).
4. **CI/PR hygiene**: regenerate the editor-release-evidence fingerprint on Linux (`ui` gate), and
   note the new-code coverage gate now sees the wired modules (unit suites exist for all of them).

## 5. Verify locally

`npm run typecheck` (root; includes tests), `npm run lint`, `npm run format:check`,
`npx vitest run packages/keiko-server/src/coding-runtime packages/keiko-server/src/coding-sidecar-gateway.test.ts`
(916+ tests), `npm run test:e2e:code-task-research-2387` (the owned journey), and
`npm run agent:pre-pr` before any push.

## 6. Rest of Epic #2384 (honest scope)

12 children #2385–#2396. Only **#2386 is closed**. **#2385 is still OPEN** (work merged, issue not
closed — verify, don't assume). **#2387 is this branch** (research done end-to-end; skills/children
per §4.1). **#2388–#2396 are not started.** Epics **#1982** and **#2384** remain OPEN. Continue
strictly one child per PR into `dev`, in order, per the epic dependency table.
