# Issue #2258 — one-use Git delivery approval evidence

This pack records the UI proof for server-issued, one-use approvals used by the Git Client and Pull
Request command center. It is separate from the Coding Workbench runtime’s existing **Approve once**
control: runtime approval never creates or satisfies a Git delivery claim.

## Covered journeys

1. Commit: a user activates Commit; the UI requests `commit/approval` with the exact command and
   `confirmed: true`, then immediately sends the returned claim only to `commit/execute`.
2. Push / Publish upstream: after existing preview checks, a user activates the sync action; the UI
   requests `push/approval`, then immediately calls `push/execute` with that claim.
3. Pull Request create/update: a user activates Create or Update Pull Request; the UI requests
   `pr/approval`, then immediately calls `pr/execute` with that claim.
4. Retry: no claim is persisted or reused. A new explicit activation requests a new claim.
5. Failure: issuance and consumption failures are visibly distinct. A consumed, expired, replayed,
   or drifted claim directs the user to retry, which requests a new claim.
6. Runtime question: while a managed OpenCode run is actively running, the Workbench polls the
   browser-safe BFF at a bounded cadence and renders single-choice, multiple-choice, and custom
   questions as untrusted plain text.
7. Runtime answer/reject: each explicit activation sends one ordered `string[][]` answer or one
   empty rejection body; controls remain disabled during submission and stale responses require a
   fresh server check before another action.

## State and accessibility contract

- Native buttons preserve keyboard Enter/Space activation and the governed global focus ring.
- Busy actions are disabled by their existing controls; completion and error states are exposed through
  existing polite status regions and alert outcomes.
- Copy is content-free. Approval identifiers and tokens are never rendered or retained in evidence.
- Styling remains on existing semantic and component tokens. The Coding Workbench's three legacy
  stylesheet files were consolidated, without declaration changes, into the sole governed
  `globals.css` engine under the collision-safe `coding-workbench-*` namespace. The runtime-question
  extension adds only namespace-local selectors consuming existing Input, Radio, Card, Button,
  Feedback, and focus tokens; it adds no token, theme override, motion, or parallel style engine.
- Structural Workbench strokes consume the governed `--border-width-default` and
  `--border-width-emphasis` scale tokens. They resolve exactly to the captured 1px and 2px geometry.

## Design-system reuse and variance

- Reused families: Card / surface, Button, Input, Radio / selection, Badge / status, Feedback, and
  Focus ring. Every declaration resolves through the existing semantic or component tokens.
- Reused global modes: Light, Dark, in-app High Contrast, OS contrast, reduced motion, and forced
  colors. The Workbench adds no component-scoped theme layer.
- Styling-engine variance: none. ADR-0049's single-engine requirement is restored for the complete
  Workbench surface; its former CSS Module facade and imported fragments have zero consumers and are
  removed.
- Visual variance: none. The final structural-width token substitution is pixel-invariant; selectors,
  colours, and computed 1px/2px border widths are unchanged from the retained live capture.

## Evidence status

Verified on 13 July 2026 by the real managed-runtime Playwright command: 18 scenarios selected,
16 passed, 2 external-attestation scenarios remained explicit `fixme` release blockers, and 0 failed.
Six visually reviewed screenshots are retained under `browser/`: terminal managed OpenCode at dark
1280px, Light 768px, Dark 320px, reduced-motion Dark 1280px, Light High Contrast 1280px, and
forced-colors Dark 768px. The five appearance/reflow captures each ran axe with zero serious or
critical findings; the terminal screenshot is fidelity evidence and is not misrepresented as an axe run.

The reviewed pixels contain only the synthetic `task-2258` workspace label, fixed UI copy, and the
synthetic managed-runtime qualification task. They contain no full path, endpoint, credential,
approval claim, customer data, or runtime question/answer body. The refreshed Light and forced-colors
768px captures prove frame containment, reflow, and keyboard focus visibility. Artifact names, hashes, requested
viewports, themes, and states are pinned in `live-qualification-manifest.json`.

Retained machine-readable proofs:

- `coding-workbench-live-fidelity-proof.json`
- `a11y-proof.json`
- `coding-workbench-question-proof.json`
- `live-qualification-manifest.json`

## Verification

The live manual/Playwright launcher is intentionally separate from the deterministic suites. It
uses a synthetic managed workspace and a SHA-verified approved OpenCode artifact; it is not a
customer-environment substitute. After `KEIKO_2258_READY http://127.0.0.1:32458`, keep the
process running for browser inspection or run:

```bash
npm run test:e2e:coding-workbench-2258
```

See [live-qualification-matrix.md](live-qualification-matrix.md) and
[`live-qualification-manifest.json`](live-qualification-manifest.json) for the retained live proof
and the two deliberately unresolved external release blockers.

```bash
npm test --workspace @oscharko-dev/keiko-ui -- --run \
  src/app/globals.css.test.ts CodingWorkbenchWindow.test.tsx \
  CodingWorkbenchQuestions.test.tsx src/lib/useCodingWorkbenchQuestions.test.tsx \
  src/lib/coding-workbench-runtime-api.test.ts \
  src/lib/api.test.ts git-client-seam.test.ts GitClientWindow.test.tsx \
  GitClientWindow.a11y.test.tsx GovernedPullRequestCard.test.tsx \
  GovernedPullRequestCard.a11y.test.tsx
npm run typecheck --workspace @oscharko-dev/keiko-ui
npm run lint --workspace @oscharko-dev/keiko-ui
```
