# Keiko Editor troubleshooting

Epic [#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Issue
[#1208](https://github.com/oscharko-dev/Keiko/issues/1208) · Decision record
[ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md).

Failure-to-resolution entries for the Keiko Editor surface: Monaco workers, Content-Security-Policy,
unsupported and oversized files, completion failures, and verification failures. Each entry follows the
[troubleshooting entry template](../troubleshooting/_template.md): Symptom, Root Cause, Diagnostic
Steps, Resolution. For product-wide failures (UI start, ports, gateway setup) see the
[main troubleshooting guide](../troubleshooting/README.md); for architecture and boundaries see the
[editor runbook](runbook.md).

The severity scale (`Blocker` / `High` / `Medium` / `Low`) matches the main guide. Do not include API
keys, customer data, deployment names, or unredacted logs in any report.

---

## 1. Editor does not load (Monaco runtime unsupported or worker load failure)

| Field             | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| Severity          | High                                                             |
| Surface           | Local UI                                                         |
| Stable identifier | Editor load-error state; `onRuntimeError`; runtime `unsupported` |

**Symptom**

Opening the Workspace editor card shows the controlled load-error state instead of a code editor, with
a message such as "This browser cannot run the Keiko Editor" or a worker/runtime load failure. The rest
of the UI is unaffected. No editor content is shown and the surface is read-only.

**Root Cause**

The editor boots a local, no-CDN Monaco runtime that requires Web Workers and the `URL` API and loads
five same-origin ESM worker bundles (`editor`, `typescript`, `json`, `css`, `html`) from the locally
installed `monaco-editor`. `detectEditorRuntimeSupport` returns `unsupported` when the browser lacks
Web Workers or `URL`; a worker bundle that fails to resolve or execute surfaces through `onRuntimeError`
and the editor's controlled load-error state. There is **no CDN fallback** by design (ADR-0042 D3), so
a missing or misconfigured local Monaco asset fails closed rather than silently fetching from a CDN.

**Diagnostic Steps**

```bash
# Confirm the locally installed Monaco workers exist (no CDN is ever used).
ls node_modules/monaco-editor/esm/vs/editor/editor.worker.js
ls node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js

# Confirm the pinned version matches the budget file (0.55.1).
node -e "console.log(require('monaco-editor/package.json').version)"
```

In the browser devtools Network panel, confirm the worker requests are **same-origin** (`127.0.0.1`)
and return `200`. A request to any non-loopback host indicates a build that bypassed the no-CDN loader.
In the Console, a `MonacoEnvironment`/`getWorker` error names the worker that failed.

**Resolution**

- Reinstall dependencies so the pinned Monaco workers are present: `npm ci`. The lockfile enforces the
  `0.55.1` pin and SHA-512 integrity.
- Confirm the host installs the runtime once before the first mount (`configureMonacoLoader` +
  `installMonacoEnvironment`) behind a client-only boundary; see the
  [host integration guide](runbook.md#host-integration-guide). Importing `monaco-editor` during a
  server render crashes the build and must stay behind `ssr: false`.
- For a genuinely unsupported browser (no Web Workers), use a current Chromium, Firefox, or WebKit
  release. The load-error state is correct behaviour, not a regression.

---

## 2. Browser blocks the editor script or worker (Content-Security-Policy)

| Field             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Severity          | High                                                               |
| Surface           | Local UI / Server                                                  |
| Stable identifier | CSP console violation: `script-src` / `worker-src` / `connect-src` |

**Symptom**

The browser Console reports a Content-Security-Policy violation when the editor mounts — for example a
blocked worker (`worker-src`), a blocked inline script (`script-src`), or a blocked request
(`connect-src`) — and the editor fails to load or behaves partially.

**Root Cause**

The Keiko server sets a strict CSP and the editor is designed to satisfy it **without any relaxation**
(ADR-0042 D3.4): `default-src 'none'`, `script-src 'self'` plus per-build SHA-256 hashes (no
`'unsafe-inline'`), `worker-src 'self'`, `connect-src 'self'`, `style-src 'self' 'unsafe-inline'`
(pre-existing, for Tailwind). Same-origin ESM workers, same-origin BFF calls, and Monaco's runtime
style injection are all that the editor needs. A violation therefore points to a deployment that serves
a custom or proxy-injected CSP, a reverse proxy that strips the per-build script hashes, or a host build
that attempts a cross-origin (CDN) editor asset.

**Diagnostic Steps**

```bash
# Inspect the CSP header the server actually serves.
curl -sI http://127.0.0.1:1983/ | grep -i content-security-policy
```

Compare it against the policy built by `packages/keiko-server/src/csp.ts`. Confirm `worker-src 'self'`
and `connect-src 'self'` are present and that `script-src` includes the `'sha256-...'` tokens for the
served HTML. A CDN host in any editor request, or a missing script hash, identifies the cause.

**Resolution**

- Serve the editor from the Keiko server's own CSP. Do not widen `worker-src`, `script-src`,
  `connect-src`, or `style-src` for Monaco — the editor does not require it, and widening weakens the
  audited transport posture
  ([security and audit boundaries](../security-and-audit-boundaries.md)).
- If a reverse proxy injects or rewrites the CSP, configure it to pass the server's
  `Content-Security-Policy` header through unchanged so the per-build script hashes survive.
- Rebuild the UI (`npm run build:ui`) after changing exported HTML so the inline-script hashes match
  what the browser executes.

---

## 3. File opens read-only, degraded, or is rejected (unsupported or oversized files)

| Field             | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| Severity          | Medium                                                         |
| Surface           | Local UI / Workspace                                           |
| Stable identifier | Degraded-mode banner; load error for files `> 1,000,000` bytes |

**Symptom**

A file opens read-only or with reduced editor features (no folding, bracket colourisation, or
occurrence highlighting), a binary/unsupported file shows a content-free note instead of a diff or
editor, or a very large file fails to open with a too-large load error.

**Root Cause**

This is enforced large-file and file-type policy, not a defect (ADR-0042 D3.6). Files \*\*> 500 KB or

> 10,000 lines** enter degraded mode: expensive Monaco features are disabled and `largeFileOptimizations`
> is on so per-keystroke work stays within budget. Files **> 1,000,000 bytes\*\* are rejected server-side
> and never instantiate Monaco. Binary and unsupported files are surfaced with a content-free note rather
> than a diff. Deterministic language intelligence is available only for TypeScript/JavaScript; other
> languages get Monaco editing and language-agnostic AI completion but no governed diagnostics/hover/
> symbols until their provider lands (#1213).

**Diagnostic Steps**

```bash
# Confirm the file's byte size against the degraded (500 KB) and hard (1,000,000 byte) thresholds.
wc -c "<path/to/file>"

# Confirm the line count against the 10,000-line degraded threshold.
wc -l "<path/to/file>"
```

A size over `500000` bytes or `10000` lines explains degraded mode; a size over `1000000` bytes
explains the load rejection.

**Resolution**

- Degraded mode is expected for large files; editing remains available. To restore full features, split
  or reduce the file below the thresholds.
- For files over `1,000,000` bytes, open them outside the editor; the limit protects responsiveness and
  is not configurable at run time.
- For an unsupported language, expect Monaco editing and AI completion only; deterministic language
  intelligence depends on a registered provider (TypeScript/JavaScript today).

---

## 4. AI completion or inline ghost text does not appear (completion failures)

| Field             | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Severity          | Medium                                                             |
| Surface           | Model gateway / Local UI                                           |
| Stable identifier | Inline completion returns zero items; content-free `degradeReason` |

**Symptom**

Deterministic completion (the suggestion list) works, but AI-assisted completion or inline ghost text
never appears. There is no error banner — the editor silently uses the deterministic tier.

**Root Cause**

This is the governed degradation path, not a failure (ADR-0042 D5). Inline completion is **model-only**
and runs only when the completion-model selection (#1210) elects an aligned, suffix-aware (FIM) model in
budget; as-you-type additionally requires a **fast** FIM model. The route returns **zero items** (so the
editor falls back to deterministic completion) when no suitable model is configured, the feature is
disabled by policy, the per-call cost ceiling is exceeded, or a per-root ceiling is hit: the request
rate limiter (60 ms minimum interval, 600 calls / 60 s) or the token budget (1,000,000 tokens / 60 s).
There is never a silent ungoverned fallback.

**Diagnostic Steps**

```bash
# Confirm a chat/infilling model is configured (first-run gateway setup completed).
npx keiko models validate

# Confirm inline completion is not disabled by deployment policy (default is ON).
env | grep -E '^KEIKO_EDITOR_INLINE_COMPLETION' | sed 's/=.*/=<set>/'
```

If `KEIKO_EDITOR_INLINE_COMPLETION` is set to `0`/`false`/`off`/`no`/`disabled`, inline completion is
intentionally off. If no model validates, the gateway has no FIM-capable model to elect.

**Resolution**

- Complete first-run gateway setup with a model that advertises the suffix-aware (FIM) capability and,
  for as-you-type ghost text, `latencyClass: "fast"`. Without one, the editor stays on deterministic
  and manual-invoke completion by design.
- To re-enable a policy-disabled feature, unset or set `KEIKO_EDITOR_INLINE_COMPLETION` to a truthy
  value and restart the UI.
- Heavy typing that hits the rate limit or token budget will skip the model tier briefly; this is the
  denial-of-wallet control and is expected. It never blocks typing.
- A deterministic-language operation that returns `TIMED_OUT`, `CANCELLED`, `UNSUPPORTED_LANGUAGE`, or
  `DENIED` indicates a bounded/contained language-service result, not a model failure; see the
  [deterministic language service](../editor-language-service.md) doc.

---

## 5. "Generate Tests" reports disabled or deferred, and verification commands fail

| Field             | Value                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| Severity          | Medium                                                                      |
| Surface           | Run engine / CLI                                                            |
| Stable identifier | Test-generation `status: "disabled"` / `"deferred"`; failing `check:*` gate |

**Symptom**

Two related cases:

1. The "Generate Tests" action returns a content-free notice with `status: "disabled"` or
   `status: "deferred"` and produces no candidate tests.
2. An editor verification command fails locally or in `ci` — for example `check:editor-bundle-size`,
   `arch:check`, `arch:check:negative`, the keiko-editor test run, or `check:editor-doc-links`.

**Root Cause**

1. Editor-driven test generation (#1202) is **shipped switched off** (ADR-0042 D7) because executing
   model-generated tests is untrusted-code execution and Keiko does not yet OS-enforce egress. Gate A
   (`KEIKO_EDITOR_TEST_GENERATION`, default off) yields `disabled`; with Gate A on but Gate B
   (`KEIKO_EDITOR_TEST_GENERATION_EXECUTION`, default off) off, the route runs governed discovery for
   provenance but makes no model call and yields `deferred`. No v1 flow executes model-generated code.
2. The verification gates enforce the editor's boundaries: the dependency-direction rule
   (`arch:check` / `arch:check:negative`), the bundle-size budget (own-code gzip ceiling, the `0.55.1`
   Monaco pin, and first-load isolation in `editor-bundle-size.budget.json`), the package test suite,
   and the documentation link check. A failure names the boundary that regressed.

**Diagnostic Steps**

```bash
# Reproduce the editor verification gates locally.
npm --workspace @oscharko-dev/keiko-editor test
npm run arch:check && npm run arch:check:negative
npm run check:editor-bundle-size          # add --require-static-export after `npm run build:ui`
npm run check:editor-doc-links

# Confirm the test-generation gates' states (both default off).
env | grep -E '^KEIKO_EDITOR_TEST_GENERATION' | sed 's/=.*/=<set>/'
```

**Resolution**

- `disabled`/`deferred` is the intended v1 behaviour. Do not enable Gate A/Gate B except on a
  deployment with an enforced, deny-by-default egress boundary proven by an automated test; see the
  [runbook test-generation flow](runbook.md#governed-test-generation-flow).
- For a failing `arch:check`, remove the Node-domain value-import the browser tier introduced; the
  editor reaches backend capability only through host-injected ports.
- For a failing `check:editor-bundle-size`, reduce the editor's own-code footprint or keep the Monaco
  runtime behind the client-only dynamic boundary; do not raise the budget without measured
  justification ([performance budgets](1207-performance-budgets.md)).
- For a failing `check:editor-doc-links`, fix the broken relative link or anchor the gate reports.

---

## Related documentation

- [Keiko Editor architecture and operations runbook](runbook.md) — architecture, integration,
  completion architecture, security/privacy.
- [`@oscharko-dev/keiko-editor` README](../../packages/keiko-editor/README.md) — package API and
  standalone embedding.
- [Main troubleshooting guide](../troubleshooting/README.md) — product-wide UI/CLI/gateway failures.
- [Security and audit boundaries](../security-and-audit-boundaries.md) — boundaries that constrain
  these resolutions.
