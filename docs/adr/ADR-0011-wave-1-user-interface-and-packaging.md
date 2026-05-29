# ADR-0011: Wave-1 User Interface and Packaging

## Status

Accepted

Decided before implementation begins (issue #13 requires the ADR "before implementation begins").
The recommended architecture in the issue is adopted with the explicitly permitted narrower
serving model; the concrete implementation reason the issue asks for is recorded in D1. This ADR
defines the boundary, the packaging shape, the CI wiring, and the authoritative BFF↔UI API
contract so the frontend and BFF teams can build in parallel. Implementation lands under `ui/**`
(frontend) and `src/ui/**` (Node BFF) in subsequent waves; this ADR adds no code.

## Context

Issue #13 adds Keiko's first graphical surface: a locally hosted application so developers,
pilots, and reviewers can launch the Wave-1 workflows, observe a run live from the harness event
stream, review and approve patches, cancel in-flight work, browse evidence manifests, and inspect
model/config state — without terminal interaction. The UI is a first-class delivery surface
alongside the CLI and SDK. It **consumes the harness's structured event stream**; it never scrapes
terminal output, never introduces a second orchestration path, never bypasses dry-run-first
discipline, and never exposes a secret at any layer (DOM, network panel, downloads, screenshots).

Everything the UI drives already exists and is accepted, audited, and CI-green: the gateway (#3)
owns the capability registry, `SafeGatewayConfig`/`toSafeObject`, and the `redact()` family; the
harness (#4) owns `createSession`/`runAgent`, the versioned `HarnessEvent` stream, cancellation via
`AbortController`, and the `EventSink` port; the workspace (#5), tool (#6), and verification (#7)
layers own the containment, write, and resource-limit boundaries; the workflows (#8/#9) own the
dry-run-first patch-proposal pipelines and their `WorkflowDescriptor`s; the audit ledger (#10) owns
the redacted-by-construction `EvidenceManifest` and the `listEvidence`/`loadEvidence` index API.
This issue is a **consumer** of those seams; like #10 it makes **zero edits** to
`src/{gateway,harness,workspace,tools,verification,workflows,audit}`.

Seven forces shape the design.

**The 7 required `dev` checks are byte-exact and non-negotiable.** Branch protection requires `ci`,
`actionlint`, `Verify pinned action SHAs`, `Analyze (actions)`, `Analyze (javascript-typescript)`,
`Build, scan, SBOM, smoke`, and `Review dependency diff (dev/main)` (ADR-0002, `enforce_admins`).
The check names are derived from job names and must match byte-for-byte. Two of these are the crux
for this issue: `Build, scan, SBOM, smoke` runs `npm run build` (currently `tsc` only),
`npm audit --audit-level=high`, and `npm sbom --omit dev`; and `Review dependency diff (dev/main)`
runs `dependency-review-action` with `fail-on-severity: high` and `deny-licenses: GPL-2.0, GPL-3.0,
AGPL-3.0, LGPL-2.1, LGPL-3.0`. Whatever the UI introduces must keep all seven green.

**Zero new runtime dependencies (ADR-0001, load-bearing).** The shipped package today has an empty
`dependencies` map and `files: ["dist", "README.md", "LICENSE"]`. The supply-chain gates measure
the *shipped, production* surface (`npm audit --audit-level=high` over the install tree; `npm sbom
--omit dev`). A UI framework that ends up in the package's runtime dependency tree expands that
surface to the entire Next/React runtime — a large, high-CVE-churn, regulated-pilot install burden
and a standing red-check risk. The frontend toolchain (Next, React, Tailwind, test libraries) must
therefore be **build-time-only** and **confined** so the root install tree never sees it.

**Root build integrity is a hard isolation constraint.** The root `tsconfig.json` is
`lib: ["ES2022"]` (no DOM), `include: ["src", "tests", "*.config.ts"]`, with
`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and strict on.
The root `eslint.config.js` runs `eslint .` (`--max-warnings=0`) with `strictTypeChecked` +
`projectService` and ignores only `dist/**`, `coverage/**`, `node_modules/**`. The root
`vitest.config.ts` is `environment: "node"`. A `.tsx` file or a DOM `lib` anywhere the root
toolchain can see it breaks `ci` and `Build, scan, SBOM, smoke`. The frontend must live **outside**
`src/` and be invisible to every root tool.

**The harness `EventSink` is push-only and synchronous.** `EventSink = { emit(event): void;
retainsRawContent?: boolean }` (`src/harness/ports.ts`). The Issue #4 async-iterable upgrade was
deferred to #13. The emitter (`src/harness/emitter.ts`) redacts SENSITIVE fields before `emit`
**unless** the sink sets `retainsRawContent === true`. The browser needs a *pull/stream* (SSE) view
of a *push* sink, and it must only ever see redacted events. Bridging push→stream is a real design
question (D7); doing it without setting `retainsRawContent` is the security crux for the live view.

**The browser is an untrusted presentation tier.** It must hold no secret, no filesystem authority,
no harness handle, and no model credential. Everything sensitive — orchestration, redaction, fs,
evidence, config — lives behind one local process. The trust boundary the security audit reviews
must be small, explicit, and hand-written, not the surface of a general-purpose web framework.

**Local-only, offline-deterministic operation.** A regulated pilot launches the UI with one
command, on `127.0.0.1`, contacting no external service beyond the configured model endpoints
(which only the harness/gateway reach). CI must verify the UI with **no external network** — no
browser download, no registry call at test time.

**Accessibility is an acceptance criterion, not a nicety.** WCAG 2.2 AA: keyboard reach to every
primary action, semantic landmarks, focus management, AA contrast, and an axe-core CI gate with
zero critical violations.

## Decision

### D1 — Next.js App Router + Tailwind with `output: "export"` (static export), served by a hand-written local Node BFF

We will build the frontend as a **Next.js (App Router) + Tailwind CSS** application configured with
**`output: "export"`** (Next static export). The App Router is retained — it is the issue's stated
preference and the modern Next.js architecture (file-system routing, layouts, server components for
the static shell, colocated route segments). Static export is the **narrower alternative the issue
explicitly permits when the ADR records a concrete implementation reason**. The concrete reason is
threefold and load-bearing:

1. **Supply-chain leanness and green security gates (the decisive reason).** A Next *standalone
   server* would place the entire Next + React runtime into the **shipped package's runtime
   dependency tree**. `npm audit --audit-level=high`, `npm sbom --omit dev`, the
   `dependency-review` license/vulnerability gate, and package-surface review would all expand from
   today's empty runtime tree to the full Next server runtime — a large, fast-churning CVE surface
   and a heavy regulated-pilot install. Static export keeps Next/React/Tailwind **build-time-only**:
   they compile a directory of static HTML/CSS/JS and then are not present at runtime. The shipped
   runtime is the Node `node:http` server in `src/ui/**` with **zero new runtime dependencies**, so
   the package's `dependencies` map stays empty and all seven checks stay lean and green.
2. **Minimal, auditable trust boundary.** The server-side authority is a small, hand-written Node
   BFF with an explicit, tiny route table (D5 lists eleven routes). That is far easier to
   security-audit — and far smaller an attack surface — than the full Next server runtime, its
   middleware, its image optimizer, and its request handling.
3. **Offline determinism.** A directory of static assets plus a local Node server is trivially
   deterministic and network-free in CI; there is no server-runtime framework to boot, no telemetry,
   and no registry fetch at test time.

The browser tier is **presentation only**: static React rendered from the export, talking to the BFF
over JSON + SSE. The BFF (`src/ui/**`, built by the existing `tsc`, Node-only, strict, **no JSX**)
is the **sole** holder of harness/gateway/secret/filesystem authority. The `keiko ui` CLI command
launches the BFF and prints the local URL.

**Consequence.** The package gains zero runtime dependencies; the supply-chain gates stay lean; the
audited trust boundary is an eleven-route Node server, not a framework runtime; CI is offline and
deterministic. The cost: the UI cannot use Next server-side rendering, server actions, route
handlers, or `next/image` optimization at runtime — every dynamic behaviour is a client fetch to the
BFF (accepted; D4/D5 define that contract).

### D2 — Server/client boundary and dependency direction

We will draw one boundary: **browser (untrusted, presentation) ↔ local Node BFF (trusted,
authority)**. The dependency direction is strictly inward and one-way:

```
browser (ui/**, static React)
   │  JSON + SSE over http://127.0.0.1:<port>   (the D5 contract — the ONLY coupling)
   ▼
Node BFF (src/ui/**)  ──imports──▶  audit (#10) ──▶ workflows (#8/#9) ──▶ harness (#4)
                                         │                                   │
                                         └──▶ verification (#7)   gateway (#3) ──▶ model endpoints
```

The browser holds no secret, no harness handle, no fs path it did not receive from the BFF, and no
model credential. The BFF imports the public barrels (`../harness/index.js`, `../gateway/index.js`,
`../workflows/index.js`, `../audit/index.js`, or the root `../index.js`) and **only** those; nothing
in `src/{gateway,harness,workspace,tools,verification,workflows,audit}` imports `src/ui/**`. The
reuse-unchanged invariant is absolute: an empty `git diff origin/dev -- src/{gateway,harness,
workspace,tools,verification,workflows,audit}` is the acceptance gate, exactly as in ADR-0010 D1.

**All model calls remain in the gateway, driven by the harness.** The BFF never calls a model
directly; it only constructs a `HarnessDeps` whose `model` is the existing `GatewayModelPort` and
hands it to `createSession`. There is no parallel orchestration path — the mission's hard "no second
orchestration path" rule is satisfied structurally because the BFF's only way to run anything is to
invoke the existing harness/workflow entry points.

**Consequence.** A reviewer audits one boundary and one import direction. The browser is
categorically incapable of touching a secret or the filesystem because it has no API to do so. The
cost: every UI capability must be expressed as a BFF route, so the route table (D5) is the single
contract both teams build against and must be kept stable.

### D3 — Frontend isolation from the root toolchain

We will place the frontend at top-level **`ui/`** (a sibling of `src/`, **outside** `src/`) as a
**non-workspace nested package** with its own `package.json`, its own `package-lock.json`, and its
own `tsconfig`, `eslint`, and `vitest` (jsdom) configuration. Concretely:

- **Root typecheck/build never sees `.tsx`/DOM/JSX.** `ui/` is outside the root
  `include: ["src", "tests", "*.config.ts"]`, so `tsc` and `Build, scan, SBOM, smoke` never compile
  it. The root `lib` stays `["ES2022"]` (no DOM).
- **Root lint never lints `ui/`.** Add `ui/**` to the root `eslint.config.js` `ignores` array
  (alongside `dist/**`, `coverage/**`, `node_modules/**`), because root `eslint .` would otherwise
  fail on JSX/DOM files. The UI has its own ESLint config (`next/core-web-vitals` + an a11y plugin)
  scoped to `ui/`.
- **Root vitest never collects UI tests.** Root `vitest.config.ts` stays `environment: "node"`,
  `include: ["tests/**/*.test.ts"]`. UI tests run under `ui/`'s own jsdom runner and are not
  collected by the root runner.
- **Root prettier never checks `ui/`.** Add `ui/` to `.prettierignore` (root `format:check` is not in
  CI, but the tree stays clean).
- **`ui/` build artifacts are git-ignored.** Add `ui/.next/`, `ui/out/`, and `ui/node_modules/` to
  `.gitignore`.

The frontend dependencies (Next, React, React-DOM, Tailwind, PostCSS/Autoprefixer, the jsdom test
runner, Testing Library, `jest-axe`/`axe-core`, the ESLint a11y plugin) are **dev/build-time only**
and live in `ui/package.json`. The root `npm ci`/`npm audit`/`npm sbom --omit dev` never install or
see them, because `ui/` is a separate, non-workspace package the root install does not traverse.

**Consequence.** The root build stays a pure Node-only `tsc` library exactly as today; the two
toolchains are independent and cannot poison one another. The cost: two lockfiles and two toolchains
to maintain, and a developer must run `npm install` in `ui/` separately (documented in the runbook).

### D4 — Why a nested non-workspace package, not an npm workspace

We will **not** make `ui/` an npm workspace member. A workspace would hoist `ui/`'s dependencies into
the root `node_modules` and the root `package-lock.json`, which is exactly what must not happen:
`npm audit`/`npm sbom --omit dev` and `dependency-review` would then see the entire Next/React tree
in the root surface, defeating D1. A standalone nested package with its own lockfile keeps the two
dependency graphs fully partitioned. `dependency-review` **does** still see `ui/package-lock.json`
(GitHub's dependency graph parses nested lockfiles), so every `ui/` dependency must be pinned to a
current, clean, **permissive-licensed** (MIT/Apache-2.0/ISC/BSD) version with no high-severity
advisory and **no GPL/LGPL/AGPL anywhere in the UI tree** — the deny-list applies to `ui/` too.

**Consequence.** The root supply-chain surface is unchanged by the UI; the UI's own dependencies are
still license- and vulnerability-reviewed via the nested lockfile. The cost: the `ui/` dependency
selection is constrained (no copyleft transitive deps) and must be kept current under the same gates.

### D5 — The authoritative BFF↔UI API contract

We will fix the following contract. It is the single coupling between the two teams (D2) and is
**stable once accepted**; additive evolution only (new routes/fields), no breaking change without a
superseding ADR. Base URL `http://127.0.0.1:<port>` (default `4319`, configurable via `--port`/env).
JSON over HTTP; live events over SSE. **Every response body is redacted** (D9). All shapes below are
the existing public types from the seam map (ADR-0003/0004/0007/0008/0009/0010).

| # | Method & path | Request body | Success response | Notes |
|---|---|---|---|---|
| 1 | `GET /api/health` | — | `{ "status": "ok", "version": string }` | Liveness + package version. The `keiko ui` smoke hits this. |
| 2 | `GET /api/config` | — | `{ "config": SafeGatewayConfig \| null, "configPresent": boolean }` | Via `toSafeObject(config)`. **Never** `apiKey`. `null` when no config file resolved. |
| 3 | `GET /api/models` | — | `{ "models": ModelCapability[] }` | `CAPABILITY_REGISTRY` (9 entries). UI filters `kind === "chat"` for pickers. |
| 4 | `GET /api/workflows` | — | `{ "descriptors": WorkflowDescriptor[], "explainPlan": { "inputs": [{ "name": "filePath", "type": "string", "required": true }, { "name": "question", "type": "string", "required": false }] } }` | Launch-form metadata; forms render FROM `descriptors`. `explain-plan` has no descriptor — synthesized inputs supplied. |
| 5 | `POST /api/runs` | `{ "workflowId"?: string, "taskType"?: TaskType, "input": object, "modelId": string, "limits"?: object }` | `202` `{ "runId": string, "fingerprint": string }` | Exactly one of `workflowId`/`taskType`. The run is **always dry-run**; the create route never writes and **ignores any client `apply` field** — applying is performed only by route 9 after explicit review (D8). Server starts the run, registers the streaming sink (D7), returns immediately. |
| 6 | `GET /api/runs/:runId/events` | — (SSE) | `text/event-stream`: framed `event: <HarnessEvent\|WorkflowEvent type>\ndata: <redacted JSON>\n\n` | Replays buffered events on connect (late subscribers see history), then live, terminating after the terminal event (`run:completed`/`cancelled`/`failed`, or workflow `completed`/`failed`). See D7. |
| 7 | `POST /api/runs/:runId/cancel` | — | `{ "ok": true }` | Calls `session.cancel(reason?)`; the harness emits `run:cancelled`; the outcome is recorded in the evidence manifest. Idempotent: cancelling an already-terminal run returns `{ "ok": true }`. |
| 8 | `GET /api/runs/:runId` | — | `{ "report": <redacted workflow/harness report projection> }` | Final projection: `status`, `proposedDiff` (redacted), `changedFiles`/`addedTestFiles`, `dryRunPreview`, `verificationSummary`, usage. `404` if the run is unknown. |
| 9 | `POST /api/runs/:runId/apply` | — (optionally `{ "confirm": true }`) | `{ "report": <apply+verify result> }` | **The only write path.** Re-runs the workflow / applies the proposed patch through the existing gated path with `apply: true` (D8). Returns the apply+verify result. |
| 10 | `GET /api/evidence` | query: `?workspace&date&workflow&model&outcome` (all optional filters) | `{ "entries": EvidenceListEntry[] }` | `listEvidence(store)` header projection; filters applied server-side. |
| 11 | `GET /api/evidence/:runId` | — | `{ "manifest": EvidenceManifest }` | `loadEvidence(store, runId)`; served **as-is** (already redacted on disk, D9). `404` if absent; `422` on `EvidenceSchemaError` with the safe pre-redacted `.message`. |

**SSE framing.** Each event is one SSE message: `event:` is the harness/workflow event `type`;
`data:` is the redacted event JSON on a single line; messages are separated by a blank line. The
stream sends a synthetic `event: ready\n` on open after the buffered replay, and closes the
connection after emitting the terminal event. Clients reconnect with the standard SSE
`Last-Event-ID` (the harness `seq`) to resume without re-replaying earlier events.

**Error envelope (every non-2xx).** `{ "error": { "code": string, "message": string } }` where
`message` is **pre-redacted** and stack traces are never included. Status codes: `400` malformed
request / failed input validation; `404` unknown run or absent evidence; `409` apply attempted on a
run not in an appliable state; `422` `EvidenceSchemaError`; `500` unexpected (generic safe message,
no detail). `code` is a stable machine string (e.g. `BAD_REQUEST`, `NOT_FOUND`,
`NOT_APPLIABLE`, `EVIDENCE_SCHEMA`, `INTERNAL`).

**Security headers the BFF sets on every response.**

- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'` (`'unsafe-inline'` is limited to `style-src` for Tailwind's injected
  styles; **no** `unsafe-inline`/`unsafe-eval` in `script-src`; no remote origins because everything
  is same-origin on `127.0.0.1`).
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
  `Cache-Control: no-store` on all `/api/*` responses.
- The BFF rejects requests whose `Host`/`Origin` is not the bound `127.0.0.1:<port>` (DNS-rebinding
  defense), and binds the listening socket to `127.0.0.1` only — never `0.0.0.0`.

**Consequence.** The frontend and BFF teams build in parallel against a frozen contract; the
contract is small (eleven routes) and auditable. The cost: any later capability requires a route
addition, and the CSP forbids inline scripts, so the static export must not emit inline `<script>`
blocks (Next static export with `script-src 'self'` is compatible; verified as an implementation
acceptance check).

### D6 — Packaging and distribution shape

We will keep `npm run build` as **`tsc` only** (so `Build, scan, SBOM, smoke` is unchanged) and add a
separate UI build path:

- A new `build:ui` script: `npm --prefix ui ci && npm --prefix ui run build` (produces `ui/out/`),
  then copies `ui/out/` into **`dist/ui/static/`**.
- `package.json#files` already includes `dist`, so `dist/ui/static/` ships as part of `dist`; no
  `ui/` sources and no `.tsx` are shipped. (The list stays `["dist", "README.md", "LICENSE"]`.)
- A `prepack`/`prepublishOnly` hook runs `npm run build && npm run build:ui` and then a
  **package-surface verification** step that asserts the tarball (`npm pack --dry-run`) contains the
  UI assets and contains **no source maps, no `.env`, no secrets, no local absolute paths, and no
  `ui/` source**. The production Next export is configured with `productionBrowserSourceMaps: false`
  so no `.map` files are emitted.
- The `keiko ui` command serves `dist/ui/static/` from the BFF.

**Consequence.** The required `Build, scan, SBOM, smoke` job's command set is byte-unchanged (still
`npm run build` = `tsc`), so it cannot regress; the UI is built and verified by a separate script and
the new `ui` CI job (D10) and by `prepack` at publish time. The cost: a publisher must run
`build:ui` (the hook does it automatically); a developer who only runs `npm run build` gets a package
without UI assets — acceptable because the `prepack` hook and the `ui` CI job enforce it for any real
publish or merge.

### D7 — Bridging the push-only `EventSink` to SSE inside the BFF (no harness change)

The harness `EventSink` is push-only and synchronous, and the deferred async-iterable upgrade is
owed to #13. We will **keep the bridge entirely in the BFF and make no harness change.** The BFF
implements a small `QueueEventSink` that satisfies the existing `EventSink` interface
(`emit(event): void`) and **deliberately does not set `retainsRawContent`** (so the harness emitter
redacts every SENSITIVE field — reasoning rationale/modelResponse, patch diff, run report — before
the BFF ever receives it). Internally the sink:

- appends each received (already-redacted) event to a per-run ring buffer (bounded; oldest dropped
  past the cap) for replay-on-connect, and
- fans the event to any currently-attached SSE writers; when no writer is attached, the buffer holds
  history until one connects.

A new SSE subscriber receives the buffered history (respecting `Last-Event-ID`), then live events,
then a stream close after the terminal event. This is an adapter that converts push to stream at the
BFF boundary; it needs nothing from the harness beyond the existing `emit` contract.

We **reject shipping the deferred `EventSink` async-iterable upgrade in the harness** as part of
#13. Reasons: (1) it would edit `src/harness/**`, breaking the reuse-unchanged invariant (D2) that
keeps the audited core frozen; (2) the BFF needs *multi-subscriber fan-out with replay*, which a
single async iterator does not provide without additional buffering anyway — so the buffering work
exists either way and belongs at the consumer; (3) keeping it in the BFF localizes the change to the
new, otherwise-unreviewed layer and leaves the harness's deliberate push/redaction design intact.
The async-iterable upgrade remains a documented, optional future harness refinement, not a #13
dependency.

**Consequence.** The browser only ever sees redacted events (the redaction is the harness emitter's,
unchanged), multi-tab/late subscribers get correct replay, and the harness is untouched. The cost:
the BFF owns a small bounded buffer per active run and must evict terminated runs' buffers (bounded
memory; documented retention: buffers are dropped when the run terminates and its final report has
been read, or after a TTL).

### D8 — Dry-run-first and the single gated write path

We will preserve dry-run-first discipline structurally. `POST /api/runs` defaults `apply: false`;
the workflow runs in dry-run mode and produces a `proposedDiff`/`dryRunPreview`/`changedFiles`
projection. The **only** route that writes is `POST /api/runs/:runId/apply` (route 9), which invokes
the existing gated apply path with `apply: true`. The BFF **does not** reimplement, relax, or bypass
the workflow guards (`isSensitivePath`, patch limits, the harness/patch apply gate) — it passes the
same inputs to the same workflow/harness entry points, which enforce those guards at their own
boundary. There is no BFF code path that constructs a patch or writes a file directly.

**Consequence.** A patch can only reach disk through an explicit user action that hits one route,
which runs the existing audited gated path; the UI cannot weaken the guards because it never touches
them. The cost: an apply re-invokes the workflow (or re-applies the captured proposed patch through
the gate) rather than "committing" a previously computed diff — a deliberate trade for not building a
second apply path.

### D9 — Secret-safety and redaction reuse (no new regex)

We will reuse the existing redactors and add **no new regex** (the CodeQL `js/polynomial-redos`
required gate, ADR-0002). Concretely:

- **Config display** goes through `toSafeObject(config)` → `SafeGatewayConfig` (strips `apiKey`)
  before serialization (route 2).
- **Any live, non-manifest payload** sent to the browser (run reports, workflow projections, error
  messages) passes through `deepRedactStrings(obj, createAuditRedactor(config, env))` — the same
  composition ADR-0010 uses — so every string leaf is scrubbed by the gateway `redact()` plus the
  configured literals/env-values. No bespoke regex is introduced anywhere in `src/ui/**`.
- **Evidence manifests are already redacted-by-construction (twice) on disk** (ADR-0010 D3), so the
  BFF serves them **as-is** (routes 10/11) and does **not** re-redact loaded manifests — re-redaction
  is unnecessary and risks distorting an already-safe artifact.
- **Live events are redacted by the harness emitter** because the BFF's sink does not set
  `retainsRawContent` (D7).

**Consequence.** No secret reaches the DOM, the network panel, a download, or a screenshot, by
construction at the BFF boundary; the ReDoS gate stays green because no new pattern is added. The
cost: redaction completeness inherits `redact()`'s known-shape coverage plus configured literals
(the same honest bound as ADR-0006/0010) — a novel secret format not matched and not configured
could pass through a *live* payload; manifests are unaffected (redacted on disk).

### D10 — CI: a dedicated, SHA-pinned `ui` job, promoted to required

We will add a **new `ui` job** to `.github/workflows/ci.yml`. The existing four job names
(`ci`, `actionlint`, `Verify pinned action SHAs`, `Build, scan, SBOM, smoke`) stay **byte-identical**;
the CodeQL and dependency-review jobs in the other two workflow files are unchanged. The `ui` job:

1. `npm --prefix ui ci` (offline-deterministic install from `ui/package-lock.json`),
2. `npm --prefix ui run lint` (Next/a11y ESLint),
3. `npm --prefix ui run typecheck` (the UI's own DOM-aware `tsc --noEmit`),
4. `npm --prefix ui run build` (static export),
5. `npm --prefix ui run test` (jsdom + Testing Library component/smoke tests + `jest-axe` a11y
   assertions with **zero critical violations**),
6. a `keiko ui` **startup smoke**: build the package (`npm run build && npm run build:ui`), launch
   `node dist/cli/index.js ui` bound to `127.0.0.1` on an ephemeral port, poll `GET /api/health`
   until `{ status: "ok" }`, then shut it down.

Every new `uses:` in the job is SHA-pinned (the `Verify pinned action SHAs` gate, #3). The job uses
**no external network**: no Playwright/browser download — accessibility and component behaviour are
verified with jsdom + Testing Library + `axe-core`/`jest-axe`, which run entirely in-process. The
coordinator **promotes the `ui` job to a required branch-protection context before merge** (adding a
required check strengthens, never weakens, the CI guarantee; it does not rename or remove any of the
seven existing contexts).

**Consequence.** The seven existing required checks are untouched and a new gate verifies the UI
builds, lints, type-checks, passes a11y, and actually starts via `keiko ui` — all offline. The cost:
one more required check to keep green and a slightly longer total CI wall time (the `ui` job runs in
parallel with the others, so the critical path grows only if `ui` is the slowest job).

### D11 — Accessibility baseline (WCAG 2.2 AA)

We will hold the UI to **WCAG 2.2 AA**: every primary action reachable and operable by keyboard
(launch, subscribe, cancel, review, apply, browse, inspect); semantic landmarks
(`header`/`nav`/`main`/`region` with accessible names); managed focus on route/view changes and on
opening the patch-review and run-detail surfaces; AA contrast for text and meaningful UI (defined as
Tailwind design tokens in the global layer, not ad-hoc inline styles); visible focus indicators; and
status updates (live run progress) announced via an appropriate ARIA live region. The axe-core CI
gate (D10 step 5) fails the build on any **critical** violation; component tests assert keyboard
operability of each primary action.

**Consequence.** Accessibility is enforced in CI, not left to manual review, and is a documented
pilot property. The cost: axe-core covers automatable rules only (roughly 30–50% of WCAG); manual
keyboard and screen-reader review by the a11y-auditor remains part of the wave plan and the runbook
records the audited status honestly.

### D12 — UI surfaces and Tailwind as the styling system

We will deliver six surfaces (issue §7), each keyboard-accessible, landmarked, and AA-contrast:
(1) **workflow launch** — forms rendered from `/api/workflows` descriptors plus explain-plan, with
model selection (`/api/models`, `kind === "chat"`), workspace path, dry-run/apply choice, and
configurable harness/workflow limits; (2) **live run view** — SSE subscription rendering state
transitions, model calls (usage + registry-enriched `costClass`), tool calls (sandbox config),
verification results (resource-limit decisions), and reasoning trace, with the integrated cancel
control; (3) **patch review** — `proposedDiff` viewer, affected paths, validation outcomes, and the
explicit apply action; (4) **evidence browser** — filterable run list + manifest detail (usage
totals, config fingerprint, verification status, optional reasoning trace); (5) **config & model
inspector** — registry + `SafeGatewayConfig`, no secrets; (6) **cancellation** integrated into (2).
**Tailwind is the primary styling system**; design tokens and responsive states live in the Tailwind
config/global layer, not ad-hoc inline styles (acceptance criterion).

`costClass` is **not** on harness events; the UI enriches a live `modelId` via
`findCapability(modelId)?.costClass ?? "unknown"` (the BFF may do this on the report projection, or
the client may join against `/api/models` — the contract carries the registry either way).

**Consequence.** The surfaces map one-to-one to the acceptance criteria and consume only the D5
contract. The cost: six surfaces is a meaningful frontend build, parallelized in the wave plan
(ui-engineer owns `ui/**`, developer owns `src/ui/**`).

### D13 — Scope fence

**In scope.** The six surfaces; the eleven-route BFF; the `keiko ui` command; the `ui/` toolchain and
its isolation; the packaging hooks; the `ui` CI job; the WCAG 2.2 AA baseline; and a pilot runbook
doc (`docs/`) covering UI launch, local-only operation, supported runtime, and accessibility status
(issue §8). The runbook is created by #13 and **notes the #12 linkage** (the pilot runbook from #12
is not yet shipped; #13 creates the UI runbook doc and cross-references #12 when it lands).

**Out of scope (stated).** Authentication/multi-user/RBAC (the UI is single-developer, local-only,
`127.0.0.1`); remote/hosted deployment; the harness `EventSink` async-iterable upgrade (D7 keeps the
bridge in the BFF); persisting workflow reports through the ledger (ADR-0010 D11, still out);
real-browser/Playwright e2e (D10 uses jsdom+axe, no browser download); any second orchestration path;
any edit to the frozen core layers (D2).

## Consequences

### Positive

- **Zero new runtime dependencies.** Next/React/Tailwind are build-time-only and confined to a
  non-workspace `ui/` package; the shipped runtime is `node:http`. `npm audit --audit-level=high`,
  `npm sbom --omit dev`, `dependency-review`, and package-surface review stay lean and green by
  construction (D1/D3/D4).
- **A small, auditable trust boundary.** One boundary (browser ↔ BFF), one inward import direction,
  an eleven-route hand-written server — far smaller to audit than a framework server runtime (D2/D5).
- **The browser cannot leak a secret.** Config via `toSafeObject`, live payloads via
  `deepRedactStrings`, manifests already redacted on disk, live events redacted by the harness
  emitter (the sink omits `retainsRawContent`) — no secret reaches the DOM, network, or downloads,
  and no new regex is added (D7/D9).
- **Dry-run-first is structural.** `apply` defaults false; one gated write route; the BFF never
  bypasses workflow guards (D8).
- **The harness is untouched.** The push→SSE bridge lives entirely in the BFF; the reuse-unchanged
  invariant holds (D7).
- **Offline, deterministic CI** with a new required `ui` gate (build/lint/typecheck/jsdom+axe/`keiko
  ui` smoke) and the seven existing checks byte-unchanged (D10).
- **Accessibility is enforced in CI** to WCAG 2.2 AA with an axe-core zero-critical gate (D11).

### Negative

- **No SSR / server actions / runtime route handlers / `next/image` optimization.** Static export
  forgoes Next's server runtime features; every dynamic behaviour is a client fetch to the BFF. This
  is the accepted cost of the supply-chain leanness in D1.
- **Two toolchains and two lockfiles.** `ui/` is independent of root; a developer installs and runs
  it separately (documented), and the `ui/` dependency set is constrained to permissive-licensed,
  low-CVE versions kept current under `dependency-review` (D3/D4).
- **Redaction completeness for live payloads inherits `redact()`'s bounds.** A novel secret shape not
  matched and not configured could pass through a *live* payload; manifests are unaffected (redacted
  on disk). Honest bound inherited from ADR-0006/0010 (D9).
- **CSP forbids inline scripts.** The static export must not emit inline `<script>`; verified as an
  implementation acceptance check (D5).
- **BFF holds per-run event buffers.** Bounded memory with eviction on run termination/TTL; a buffer
  bug could grow memory, so the cap and eviction are explicit acceptance items (D7).
- **One more required check to keep green.** The `ui` job adds CI surface and a small critical-path
  cost (D10).

### Neutral

- The CSP allows `'unsafe-inline'` for `style-src` only (Tailwind's injected styles); `script-src`
  stays `'self'` with no inline/eval (D5).
- `keiko ui` inverts nothing in the existing CLI; it is an additive subcommand alongside
  `run`/`gen-tests`/`investigate`/`verify`/`evidence`/`context`/`models`.
- The default BFF port is `4319`, configurable; the socket binds `127.0.0.1` exclusively, with a
  Host/Origin allow-check for DNS-rebinding defense (D5).

## Alternatives Considered

### Alternative 1: Next.js standalone server (the framework's own runtime)

Ship a Next server (`output: "standalone"` or a custom server) that renders and serves the UI and
hosts the API as route handlers/server actions.

- **Pros**: full Next feature set (SSR, server actions, route handlers, image optimization); no
  separate hand-written BFF; the "most modern Next.js" shape.
- **Cons**: puts the entire Next + React runtime into the **shipped package's runtime dependencies**,
  expanding `npm audit --audit-level=high`, `npm sbom --omit dev`, `dependency-review`, and
  package-surface review to a large, fast-churning CVE surface and a heavy regulated-pilot install;
  the audited trust boundary becomes the whole framework server, not a tiny route table.
- **Why rejected**: it violates the zero-new-runtime-dependency constraint (ADR-0001, §2.2) and
  enlarges the audited boundary, directly threatening the `Build, scan, SBOM, smoke` and dependency
  checks. D1's static export keeps Next build-time-only and ships `node:http` with zero runtime deps;
  this is the concrete implementation reason the issue requires for choosing the narrower serving
  model while keeping the App Router architecture.

### Alternative 2: Make `ui/` an npm workspace member

Add `ui/` to the root `workspaces` array so one `npm install` manages both packages.

- **Pros**: one install command; shared tooling; conventional monorepo ergonomics.
- **Cons**: npm workspaces hoist `ui/`'s dependencies into the **root** `node_modules` and
  `package-lock.json`, so `npm audit`/`npm sbom --omit dev`/`dependency-review` would then measure the
  entire Next/React tree as part of the root surface — exactly the supply-chain expansion D1 exists to
  prevent.
- **Why rejected**: it defeats the leanness guarantee. A standalone nested package with its own
  lockfile (D3/D4) fully partitions the two dependency graphs while still letting `dependency-review`
  scan `ui/package-lock.json` via the GitHub dependency graph. The ergonomic cost (a second
  `npm install`) is documented in the runbook.

### Alternative 3: Real-browser end-to-end tests (Playwright) in CI

Use Playwright (or Cypress) for the UI's CI verification, driving a real Chromium.

- **Pros**: highest-fidelity end-to-end coverage; real rendering, real navigation, real a11y tree.
- **Cons**: Playwright downloads a browser binary at install/test time — an **external network**
  dependency that breaks the offline-deterministic CI requirement (§2.3/§8) and adds a large, pinned
  binary supply-chain surface; it is also slow and flaky relative to in-process tests.
- **Why rejected**: §8 requires UI smoke tests that run "deterministically without external network."
  D10 uses jsdom + Testing Library + `axe-core`/`jest-axe` (all in-process, no browser download) for
  component, behaviour, and a11y verification, plus a real `keiko ui` HTTP startup smoke against
  `/api/health`. Real-browser e2e is a documented future enhancement, not Wave-1 scope, and would be
  gated behind a self-hosted/cached-browser solution that does not fetch at CI time.

### Alternative 4: A separate frontend repository/checkout consuming the published package

Host the UI in its own repository that depends on the published `keiko` package, decoupling release
cadence.

- **Pros**: total isolation of the two dependency trees and toolchains; independent versioning.
- **Cons**: the UI would lag the package it drives across two release cycles; the BFF↔seam contract
  would cross a repo boundary with no compile-time coupling, making drift likely; `keiko ui` could not
  ship the assets in the package, breaking the "one documented command, assets in the package"
  acceptance criterion; and a regulated pilot would have to install and reconcile two artifacts.
- **Why rejected**: the issue requires `keiko ui` to launch from the installed package with the UI
  assets shipped inside it (§8). D3/D6 achieve full toolchain/dependency isolation **within** the repo
  (nested non-workspace package, build-time-only deps, assets copied into `dist/`), getting the
  isolation benefit without the cross-repo drift and double-install costs.

### Alternative 5: A Single-Page App on a non-React stack (or vanilla) to shrink the build-time surface further

Drop Next/React and hand-build a static SPA (vanilla TS, or a minimal view library) to minimize the
build-time dependency surface further.

- **Pros**: even smaller build-time dependency tree; no framework lock-in.
- **Cons**: the issue states a preference for "modern Next.js App Router architecture"; abandoning it
  needs a stronger reason than build-time-dependency minimization, which D1 already neutralizes by
  keeping Next build-time-only (it is absent from the shipped runtime regardless). Hand-building six
  accessible, tested surfaces without a component model is more code, more risk, and weaker a11y
  ergonomics.
- **Why rejected**: D1 already removes the *runtime* cost of Next (static export, zero runtime deps),
  so the only remaining cost is build-time, which `dependency-review` over `ui/package-lock.json`
  governs with pinned permissive-licensed versions (D4). Keeping the App Router satisfies the issue's
  stated architecture preference at no runtime cost; replacing it would forgo that for a marginal
  build-time saving and a heavier hand-rolled implementation.

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint (load-bearing) and
  the strict Node-only `tsc`/ESM/LOC discipline the `src/ui/**` BFF inherits; `ui/` is a new
  top-level location outside the reserved `src/` layout.
- ADR-0002: CI and Supply-Chain Security Baseline — the seven byte-exact required checks; the `ui`
  job is added with SHA-pinned actions (the `Verify pinned action SHAs` gate); the no-new-regex rule
  (D9) keeps `Analyze (javascript-typescript)`/`js/polynomial-redos` green; `dependency-review`'s
  deny-list applies to `ui/package-lock.json` (D4); `Build, scan, SBOM, smoke` stays `tsc`-only (D6).
- ADR-0003: Model Gateway Boundary — `toSafeObject`/`SafeGatewayConfig`, `CAPABILITY_REGISTRY`/
  `findCapability`, `ModelCapability.costClass`, and the `redact()`/`createAuditRedactor`/
  `deepRedactStrings` family consumed by the BFF (D2/D9/D12); the BFF never calls a model directly.
- ADR-0004: Agent Harness Boundary and State Machine — `createSession`/`runAgent`, the versioned
  `HarnessEvent` stream, `session.cancel`, and the push-only `EventSink` with the
  `retainsRawContent`-keyed emitter redaction; the BFF bridges push→SSE without a harness edit and
  without setting `retainsRawContent` (D7); the #4-deferred async-iterable upgrade is kept out of #13.
- ADR-0007: Verification Orchestrator and Resource Limits — `VerificationAuditSummary` /
  `ResourceLimitDecision` rendered in the live run and evidence views (D12).
- ADR-0008 / ADR-0009: Workflow ADRs — `WorkflowDescriptor`s drive the launch forms;
  dry-run-first and the workflow guards (`isSensitivePath`, patch limits) are enforced by the existing
  workflows, never bypassed by the BFF (D8/D12).
- ADR-0010: Audit Ledger and Evidence Manifests — `listEvidence`/`loadEvidence`/`EvidenceManifest`
  feed the evidence browser; manifests are served as-is because they are redacted on disk (D9); the
  reuse-unchanged invariant and `deepRedactStrings`/`createAuditRedactor` composition are mirrored.
- Issue #13: Wave-1 professional UI. Issue #12: pilot runbook (not yet shipped) — #13 creates the UI
  runbook doc and cross-references #12 when it lands (D13).
- Next.js static exports: https://nextjs.org/docs/app/building-your-application/deploying/static-exports
- WCAG 2.2 AA: https://www.w3.org/TR/WCAG22/
- DNS-rebinding defense for local servers (Host/Origin allow-check): OWASP guidance on local web
  service binding.

## Date

2026-05-29
