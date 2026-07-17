# Handoff — Issue #2387 (governed research, skills, read-only subagents)

**Status: partially implemented, NOT functional end-to-end. Do not merge as a finished feature.**
This document is a clean handoff so a successor can continue without repeating dead ends. It states
exactly what is done and verified, the one design decision already made, and the precise remaining
wiring with concrete file:line seams.

Branch: `claude/issue-2387-research-skills` (draft PR #2472 → `dev`). Base of this branch: dev
`fa6fc15c` plus the merged #2386 governance surface.

---

## 1. Scope of #2387 (from the issue)

A Code task can (a) research public documentation over a governed read-only egress, (b) invoke
server-approved skills, and (c) delegate to one-layer read-only subagents — all without inheriting
authority. Owns `tests/e2e/config/playwright.code-task-research-skills-subagents.config.ts` + a real
journey, emits `CodeTaskAcceptanceContributionV1` for #2396, produces `AuxiliaryCapabilityPortV1`
for #2388, consumes #2386 `GovernedActionV1`.

## 2. What is implemented, verified, and pushed

All of the following is committed on the branch, and each piece passed local `typecheck` +
`lint --max-warnings=0` + `prettier` + its unit tests at the stated commit.

### Contracts (`packages/keiko-contracts`)

- `code-task-auxiliary.ts` — `AuxiliaryCapabilityPortV1`, `AuxiliaryCapabilityRequestV1`
  (discriminated on `capability: research|skill|child-agent`), `AuxiliaryCapabilityOutcomeV1`,
  `AuxiliaryResearchScopeV1`, and the SSRF-safe `isCodeTaskPublicDomain` / `isCodeTaskSkillId` /
  `isCodeTaskChildRunId` predicates. (The IP-literal regex was fixed for a CodeQL ReDoS finding —
  IPv4-only fixed pattern; IPv6 is already rejected upstream by `PUBLIC_DOMAIN_PATTERN`.)
- `coding-workbench.ts` — 4 runtime event kinds (`research-performed`, `skill-invoked`,
  `child-run-started`, `child-run-completed`), the canonical `CodingWorkbenchAuxiliaryStatus` enum
  (accepted|denied|unavailable|limit-reached|stopped) carried on the SSE `runtime-event` frame as
  `auxiliaryOutcome`, the `research` supervised-action kind → `network-egress` permission.
- `coding-workbench-runtime-api.ts` — `researchGrant` snapshot field (`{ grantId, domains[],
expiresAt }`, no query digest) + `validateResearchGrant` (fails closed on empty domains, IP
  literals, smuggled sub-keys) + exactKeys allowlist entry; `parseCodingWorkbenchRuntimeResearchRevokeRequest`.
- `coding-workbench-validation.ts` — per-kind allowlist + required-field validators for the 4 event
  kinds. `coding-workbench-evidence.ts` — `research`/`skill`/`child` added to the approved evidence
  vocabulary (so `event-research-N` style ids pass the content-free evidence check).
- 3919 contract tests green.

### UI vertical (`packages/keiko-ui`) — merged commit `888e0d39`

`Internet · Research only` chip in the readiness grid, timeline rendering for the new event kinds,
the revoke client wiring (`postSnapshot('/research/revoke')`), and both en/de i18n catalogs. 5355
UI tests green. **Note:** any keiko-ui change invalidates `check:editor-release-evidence` — that
fingerprint must be regenerated on CI/Linux (it is platform-specific; a macOS value is rejected).
This is why the `ui` gate is red on the draft PR.

### Server modules (`packages/keiko-server/src/coding-runtime`) — commit `62c91559`

Three modules, each adversarially security-reviewed and hardened; 129 focused unit tests green.

- `researchEgressPort.ts` + `researchGrantRegistry.ts` — GET-only through `gatewayFetch`,
  named-domain allowlist re-validated on the initial host **and every redirect hop**, request-line
  binding (decoded path + visible query must hash to the grant's digest — neither path nor query can
  smuggle repository text), fetch/byte budget **reserved before each hop** (an exhausted grant makes
  zero network calls), a dedicated egress config that denies loopback and inherits no
  private-network/credential allowance, content-free `research-performed` event on success and on
  every fail-closed denial.
- `skillCatalog.ts` + `skillInvocationPort.ts` — exact server-approved `id@version` only, implicit
  invocation catalog-gated, every produced tool request re-evaluated through an injected authority
  re-evaluator (no self-widening), identical content-free `skill-invoked` audit event for
  explicit / implicit / denied.
- `readOnlyChildEnvelope.ts` + `readOnlyChildOrchestrator.ts` — strictly-narrower read-only derived
  envelope, one-layer enforcement (a child cannot spawn a child), every child tool call charged to
  the parent budget, parent stop/revocation/timeout cascaded with a deadline-backed abort **and a
  post-run stop re-check** (a mid-run revocation can never surface as `accepted`), denied spawns
  audited too.

### Runtime foundations (composition) — commits `43059cce`, `37cbb47f`, `5de648ac`, `dca53543`, `977c3385`

- `denyLoopback` egress posture (`keiko-model-gateway`) with a focused test.
- `productionRuntimeWorkspaceAuthority.ts` — base envelope moves to `governed-egress` +
  `network-egress` when `researchEgressEnabled`.
- `productionManagedWorktreeTools.ts` — the egress port is **mounted** behind the fail-closed stub
  (`buildEgressAuthority`): a real `createResearchEgressPort` when a registry + gateway-egress are
  injected, else the fail-closed stub.
- `productionCodingRuntimeResolver.ts` — one server-level `ResearchGrantRegistry` created in
  `composeRuntime`, threaded to the tool facade, and **invalidated on runtime revoke/terminate**
  (`authorityLifecycle.revokeRuntime` → `researchGrants.invalidateRun`).
- `codingRuntimeControlPlane.ts` / `productionCodingRuntimeHost.ts` — the registry is exposed on the
  `CodingRuntimeHost` surface as an optional `researchGrants` field, reachable by the control plane.

## 3. Design decision already made (do not re-litigate)

**Research grants are request-scoped, bound via the #2386 approval flow — not activation-scoped.**
The egress port binds the request line (`sha256Hex(sanitizeVisibleText(decodedPath + " " +
decodedQuery))`) to `grant.queryTextDigest`. A purely activation-scoped domain grant (domains +
expiry, no query digest) would therefore only permit root-path fetches — too restrictive for real
doc research, and loosening the binding would reopen the path/query smuggling channel. So: the model
requests an egress action (a URL) → `network-egress` permission-request (approval-required in
supervised/governed per the effect matrix) → on approval the server computes the request-line digest
of the approved URL and registers a grant for that host. Use the exported `sanitizeVisibleText` +
`sha256Hex` from `researchEgressPort.ts` — the issuance side and the port MUST compute the digest
identically or every fetch fails closed.

## 4. Remaining work, in order (with concrete seams)

1. **Thread the registry into the orchestrator + project the grant onto the snapshot.**
   The registry is on `CodingRuntimeHost.researchGrants` (`codingRuntimeControlPlane.ts`). Pass it
   into `createCodingRuntimeOrchestrator({...})` deps, and have the orchestrator's snapshot
   projection (`this.projection.publicSnapshot`, `codingRuntimeOrchestrator.ts` ~line 91/126) add
   `researchGrant` from `registry.activeGrants(runId, now)`. Consider instead storing `researchGrant`
   on the snapshot _record_ at issue/revoke time so the projection just passes it through — that
   avoids threading the registry into the projection. Decide and document.
2. **Revoke route.** Add `POST /api/coding-workbench/runtime/runs/:runId/research/revoke` in
   `codingRuntimeRoutes.ts` (mirror the `pause`/`resume` mutation handlers ~line 276/286), parse via
   `parseCodingWorkbenchRuntimeResearchRevokeRequest`, add a `revokeResearch(runId, body)` method to
   the orchestrator that calls `registry.invalidateRun(runId)` (cascades to children) and returns the
   revision-bumped, grant-absent snapshot. The UI already calls this route.
3. **Grant issuance hook.** In `codingRuntimeManager.ts` `issueApproval` (~line 665), when the
   approved action is a `research`/`network-egress` request, build `AuxiliaryResearchScopeV1` from the
   requested URL's host + the request-line digest, register it in the registry, and emit the
   `read-only-research` `GovernedActionV1`. Wire `researchGrantRegistry` + `gatewayEgress` +
   `researchEgressEnabled` into `createProductionManagedWorktreeToolFacade` (resolver already has the
   registry in scope; `gatewayEgress` can be `() => undefined` for direct connections).
4. **Model-facing tool declaration.** Declare `research.search`/`research.fetch`, `$skill`, and the
   child-agent tool in `OPENCODE_MODEL_VISIBLE_TOOLS` (`opencodeToolSchemas.ts:92`) and dispatch them
   in `EditorAgentToolHost` (`editor-agent-tool-host.ts:486`) / `EDITOR_AGENT_TOOL_DEFINITIONS`
   (`editor-agent-schemas.ts:238`); mediate at the `toolFacade`/`governedEventSink` seam
   (`productionOpenCodeBackend.ts:95`). Use `event-child-N`-style ids for child events (the evidence
   vocabulary now allows `child`).
5. **E2E** — create the owned config `tests/e2e/config/playwright.code-task-research-skills-subagents.config.ts`
   - a test-server harness (mirror `playwright.code-task-authority.config.ts` and the #2386 server)
   - the real journey (grant research → observe a skill and a child → revoke → next request denied).
6. **`npm run test:mutation:security`** focused coverage on the new authority/parser/redaction/
   containment/lifecycle code, and emit `CodeTaskAcceptanceContributionV1`.

## 5. Known CI state on the draft PR (#2472)

Red and **expected** for this unfinished state: `ci`/`Coverage and SonarCloud` (new modules not yet
integrated → new-code coverage/quality gate), `ui` (stale editor-release-evidence fingerprint —
regenerate on CI/Linux), `Keiko for Quality` (aggregates the above). The CodeQL ReDoS finding is
**fixed** in this handoff.

## 6. Verify locally

`npm run typecheck` (root; includes tests — package-level tsc does NOT), `npm run lint`
(`--max-warnings=0`), `npm run format:check`, and the coding-runtime + contracts unit suites. Run
`npm run agent:pre-pr` for the full pre-PR gate before any real (non-draft) push.

## 7. Rest of Epic #2384 (honest scope)

12 children #2385–#2396. Only **#2386 is closed**. **#2385 is still OPEN** (its work is on the
branch but the issue was never closed — verify state, don't assume merged). **#2387** is this
partial branch. **#2388–#2396 are not started.** Epics **#1982** and **#2384** remain OPEN. Continue
strictly **one child per PR into the epic branch, in order**, per the epic dependency table.
