# Dependency and Security Currency Closeout (#2296)

Closeout evidence for epic [#2291](https://github.com/oscharko-dev/Keiko/issues/2291). The
checkout-bound rows were refreshed on 2026-09-30 against the release branch based on
`dev`.

This document supersedes the version claims in
[`2293-dependency-update-decision-matrix.md`](2293-dependency-update-decision-matrix.md), which
records the reviewing that happened during the implementation waves and is retained as the decision
history. Where the two disagree, this document is authoritative, because it is the one a gate reads
back: `npm run check:dependency-currency` fails closed when any row below stops describing the
resolved dependency graph or the pinned workflow actions.

That gate is the point of this document. #2291's implementation waves landed through
[#2304](https://github.com/oscharko-dev/Keiko/pull/2304) and were closed out with prose alone. Six
weeks later the matrix still documented an ESLint lane held at 9.39.5 and a Monaco line pinned at
0.55 while the repository resolved 10.9.1 and 0.56.0, and it named `actions/setup-node` v6.4.0 and
`github/codeql-action` v4.37.0 after both had moved. Nothing was wrong with the reviewing; nothing
read it back. Evidence that no gate evaluates decays into a sentence that merely looks reviewed.

## Scope of this closeout

- Epic #2291 children #2292, #2293, #2294 and #2295 delivered their implementation through the
  merged PR #2304. Their issues remained open and still carry `status: pr open`; the label is
  stale, not the work.
- TypeScript-7 closeout #2270 is a different case and is **not** delivered. PR #2304's own body
  excludes it ("Out of scope: … Final #2270/#2296 closeout"), and the issue carries
  `status: triaged`. It is waiting on an upstream release that has not shipped: the newest stable
  TypeScript is 7.0.2 and there is no stable TypeScript 7 programmatic API to migrate to, while
  `typescript-eslint@8.69.0` independently caps the API package at `<6.1.0`. The split toolchain is
  therefore a governed end state for now, recorded below as `major-deferred` — not a half-finished
  migration this closeout may claim.
- This closeout re-runs the live inventory rather than restating the merged waves, because registry,
  runtime and Action releases are temporally unstable and the previous inventory had drifted.

## Security posture

On 2026-10-23, PR #4013's required OSV scan reported four newly reviewed `fast-uri`
advisories and the revised Zod advisory [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The existing `fast-uri` override now resolves 3.1.9. Root development tooling resolves Zod
4.6.7. The private native host retains OpenCode 2.0.10 and GitLab provider 6.12.1, and uses the
existing scoped override mechanism to resolve their Zod dependencies to 4.6.7. This deliberately
changes GitLab's declared Zod 3 range and requires its real JavaScript compatibility proofs;
it does not establish compatibility of that dependency's published TypeScript declarations.
An initial run of the same pinned recursive OSV command reported zero unwaived findings;
a subsequent fresh scan found the Fallow advisories recorded below.

GitHub withdrew the previously waived [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
on 2026-10-23. Its now-unused ignore has been removed; that withdrawal is not a patched braces
release. The separate `http-cache-semantics` waiver retains its original scope, reason, expiry
and revisit conditions. The historical two-waiver observations below describe their recorded dates.
Zod 4.6.7 still distributes its legacy `/v3` API; this update does not claim that legacy code was
patched or that an unbounded schema acquires a resource limit. The added bounded-array regression
exercises the actual provider-resolved bare Zod API with a small input, separately from the real
GitLab token/header/OAuth and OpenAI schema-conversion compatibility controls. No provider was
removed, no native payload approval was granted, and no security gate or limit was relaxed.

On 2026-10-13, the required OSV scan reported two newly published Microsoft cryptography
advisories against the Windows RFC 3161 native-quality project's
`System.Security.Cryptography.Pkcs` 10.0.9:
[GHSA-2fmv-rv2c-59x7](https://github.com/advisories/GHSA-2fmv-rv2c-59x7) and
[GHSA-846f-f764-76mx](https://github.com/advisories/GHSA-846f-f764-76mx). The project now selects
the patched 10.0.13 release, and an unlocked .NET 8 restore regenerated its committed NuGet
lockfile, including the cryptography and ASN.1 transitive dependencies. The native-quality
invocation retains `RestoreLockedMode=true`; neither an OSV waiver nor a gate bound changed.
The repository-wide OSV Scanner 2.6.0 scan and the local locked quality build qualify this
dependency repair. The native Windows integration remains required CI evidence; a macOS
cross-targeted build does not replace it. These NuGet records are governed by the committed
project/lock and Windows native-quality gate, separately from the npm currency rows below.

| Source                     | Result                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm audit --json`         | Rechecked 2026-10-06: 6 dev-only nodes for 2 recorded advisories; production audit: 0 vulnerabilities |
| OSV Scanner 2.6.0          | 0 unwaived findings; 1 time-boxed build-time waiver, recorded below                                   |
| Repository secret scanning | 0 open alerts; both prior findings triaged and closed below                                           |
| Provider-SDK isolation     | Enforced by `arch:check` (ADR-0019 trust-1), unchanged by this closeout                               |

The 2026-09-30 OSV scan found newly reported advisories in the previous lockfile. The patched
resolutions are `brace-expansion` 1.1.21 and 5.0.12, `fast-uri` 3.1.9, and `ip-address` 10.7.2.
The two `brace-expansion` majors are pinned under their respective `minimatch` consumers so neither
receives an incompatible major. `npm ci`, `npm audit`, and the exact OSV Scanner 2.6.0 scan pass
with the updated lockfile.

A later 2026-09-30 scan identified newly published advisories in Next.js 16.3.5 and DOMPurify
3.4.13. [#3678](https://github.com/oscharko-dev/Keiko/pull/3678) moved Next.js and its ESLint
configuration to 16.3.6, fixing
[GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), and the existing
repository-wide DOMPurify override to 3.4.16, fixing
[GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p). The full npm audit and
exact OSV Scanner 2.6.0 repository scan both report zero vulnerabilities with these patches; no
waiver or gate threshold changed.

On 2026-10-22 the required OSV scan newly matched DOMPurify 3.4.16 against
[GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) and
[GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f), and `ip-address`
10.7.2 / 10.7.3 against [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).
PR #4056 updates the existing DOMPurify override to the identified patched 3.4.17 release and both
the root and native OpenCode host lockfiles to `ip-address` 10.7.4 within their existing ranges.
The exact local OSV Scanner 2.6.0 invocation reproduces all five findings before the updates and
reports no open findings afterward. The two existing waivers are unchanged.

On 2026-10-24 the required OSV scan newly matched the dev-only `fast-uri` 3.1.8 against
[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp),
[GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) and
[GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), and the dev-only `fallow`
3.9.1 against [GHSA-h4fr-cmh5-qr62](https://github.com/advisories/GHSA-h4fr-cmh5-qr62) and
[GHSA-jfwm-3p3c-6hx5](https://github.com/advisories/GHSA-jfwm-3p3c-6hx5). PR #4064 moves the
existing `fast-uri` override to the patched 3.1.9. `fallow` moves to the patched 3.35.0 by the
owner's gate decision of the same day: the patched line makes `dupes --fail-on-issues` fail on every
clone group, so generated files, the translation catalogs and the failure-class contract table are
excluded (`.fallowrc.json`) and the remaining 1,032 groups are frozen in a shrink-only baseline
(`docs/qa/fallow/dupes-baseline.json`, enforced by
`scripts/check-semantic-duplication.mjs`). A change fails on the clone groups it introduces, and the
two time-boxed OSV waivers are removed.

The same day, [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) and
[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) were published for
`undici` before 6.29.1, 7.30.1 and 8.12.2. PR #4064 moves the root jsdom override to 8.12.2 and the
separate root override to 7.30.1, and adds version-scoped overrides to the native OpenCode service
host (`undici@6.29.0` to 6.29.1, `undici@8.11.2` to 8.12.2). The exact OSV Scanner 2.7.0 action
image reports no open finding afterward.

On 2026-10-02 GitHub reviewed
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (braces through 3.0.3)
and [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) (http-cache-semantics
through 4.2.0), and OSV began reporting both. Neither names a patched release. The lockfile holds
one dev-only instance of each: braces under the keiko-ui ESLint configuration, and
http-cache-semantics under the release-signing `sigstore` dependency.
[#3679](https://github.com/oscharko-dev/Keiko/pull/3679) records each in `osv-scanner.toml` as an
id-bound waiver. Each waiver carries its reachability analysis and an `ignoreUntil` of 2026-11-30.
npm's audit feed did not list either advisory yet, so `check:osv-waiver-scope` now also asks OSV
whether a waived advisory affects any package the lockfile does not flag dev.

Rechecked on 2026-10-05: the [npm registry](https://registry.npmjs.org/http-cache-semantics)
lists http-cache-semantics 4.3.0, published on 2026-10-04. The lockfile still resolves the same
dev-only 4.2.0 signing-tool dependency, with the unchanged non-caching reachability described in
`osv-scanner.toml`. [Dependabot alert #34](https://github.com/oscharko-dev/Keiko/security/dependabot/34)
remains open, and the [GitHub advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) remains
unwithdrawn with no identified patched version. The
[maintainer's dispute](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591)
does not establish a withdrawal or a fix in 4.3.0. The waiver retains its original dev-only scope,
expiry, and revisit conditions.

On 2026-10-06 the release-1.2.0 hygiene job and the same pinned OSV Scanner 2.6.0
locally identified [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
in `source-map-js` 1.2.1. The advisory identifies 1.2.2 as patched. The targeted npm lockfile
update moves only this shared transitive resolution, used by PostCSS, CSS-Tree, and magicast;
all consumers already accept the compatible patch. No waiver or security threshold changes.
After the update, the same recursive OSV scan reports zero unwaived findings and
`npm audit --omit=dev --json` reports zero vulnerabilities. The current full npm audit feed
also reports the two previously recorded build-time advisories above:
six affected dependency nodes, representing those two advisory IDs. Those findings are distinct
from the patched source-map dependency and retain their existing scope and revisit conditions.

The next required OSV scan reported a second newly reviewed advisory,
[GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2), in `smol-toml`
1.8.0. The identical local scan reproduced it. Version 1.9.0 fixes quadratic key parsing and
is accepted by both existing consumers: the server Rust manifest validator and Knip.
The targeted update changes only the shared resolution; the Rust validator retains its existing
manifest-size and sensitive-path checks. The patched recursive OSV scan and production npm
audit pass, as do 53 targeted Rust-manifest, publishing, and pruning tests. No advisory is waived
to accommodate this update.

### Earlier #3918 security qualification (2026-10-23)

The following paragraph records that repair's inputs and results. References to the private
native service host and its lockfile are historical; the current runtime retires both.

On 2026-10-23 the required recursive OSV scan and production npm audits identified new
advisories in DOMPurify, Next.js and `ip-address`. This repair moves the existing DOMPurify
override to 3.4.17 for
[GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) and
[GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f).
Next.js and its ESLint configuration move together to 16.4.2; the patched minimum is 16.4.1 for
[GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw),
[GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) and
[GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr).
Both root and native-host lockfiles resolve `ip-address` 10.7.4 for
[GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5), within their
existing `socks` dependency range. No new override or waiver is added. The DOMPurify npm
resolution does not replace Monaco's separately vendored sanitizer; its existing disabled-markdown
and inert-markup controls remain independently verified. The two earlier build-time advisory
waivers retain their existing scope, expiry and revisit conditions.

### Earlier Composer parser qualification (2026-10-20)

On 2026-10-20 the exact OSV Scanner 2.6.0 recursive gate identified
[GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c) and
[GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q) in the runtime
`markdown-it` 14.3.2 resolution beneath `prosemirror-markdown`. Both identify compatible 14.3.3
as patched. The targeted lock update changes only that package's version, archive URL and
integrity. A clean exact-lock install confirms CommonJS resolution to 14.3.3 from root, UI and
ProseMirror contexts, while the Composer's existing CommonMark `html: false` setting remains disabled.
The default-parser reference-definition denial of service is relevant to browser Composer
availability; the HTML-specific parser option is not enabled on this consumer. Both defects are
patched without enabling HTML or changing parser options. The same recursive scanner then reports
zero unwaived findings, and all 74 existing Composer/parser controls pass. Existing waiver IDs,
expiry dates and reachability limits remain unchanged. Earlier qualification records retain their
original dependency inputs; current release qualification is repeated for the patched resolution.

### How this queue must be queried — and the trap in it

The count above is 2, not 1, and reproducing it requires the exact query
[`SECURITY.md`](../../SECURITY.md) documents. This is not a detail; it is the difference between a
true and a false closeout, and this closeout got it wrong on the first pass:

```bash
# Surfaces alert #20 only. Generic findings are NOT in this response.
gh api "repos/oscharko-dev/Keiko/secret-scanning/alerts?state=open&per_page=100"

# Still surfaces alert #20 only.
gh api "repos/.../secret-scanning/alerts?state=open&hide_secret=true&per_page=100"

# Surfaces alert #17. Only an explicit secret_type filter reveals a generic finding.
gh api -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/.../secret-scanning/alerts?state=open&secret_type=password&hide_secret=true&per_page=100"
```

A generic (`password`-type) alert is absent from the default listing **and** from an unfiltered
`hide_secret=true` listing. Only the explicit `secret_type=password` filter returns it. Any
statement of the form "the generic secret queue is empty" that was produced without that filter is
unsupported — the response it was based on could not have contained the finding. Epic #2291's
definition of done turns on this exact question, so the query belongs in the evidence, not in
someone's shell history.

### Dispositions

| Alert | Type | Location | Disposition | Rationale |
| ----- | ---- | -------- | ----------- | --------- |

The queue is empty: both listings return zero open alerts. This table stays because it is the one
`npm run check:secret-scanning-queue` reads — a new alert with no row here fails the scheduled lane,
and a row left behind after its alert closes fails it too. The `Disposition` column takes
[`SECURITY.md`](../../SECURITY.md)'s closed vocabulary (`revoked`, `used_in_tests`,
`false_positive`, `unresolved`), validated against exactly that set; prose there would let a typo or
a `TBD` count as a triage decision.

### Resolved during this closeout

Recorded outside the dispositions table on purpose — these alerts are closed, and a row above would
now be a claim about something that no longer exists. No literal secret value appears here or in any
gate output; both flagged values were synthetic, non-functional, and granted no access.

| Alert | Type                 | Resolution     | Root cause and repair                                                                      |
| ----- | -------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| #20   | provider API key     | used_in_tests  | Synthetic cross-detector parity fixture; literal split, class closed by a self-reading pin |
| #17   | generic (`password`) | false_positive | Documentation placeholder for a loopback mock that ignores the field; replaced             |

**#20** was one of the corpus strings the cross-detector parity test feeds through
`looksLikeSecretShape()`, `containsCredentialShape()` and `isSecretShapedString()` to pin their
agreement. The root cause was real: `gitleaks:allow` suppresses gitleaks only, and GitHub's partner
scanner is a separate detector that alerts on the prefix alone. Its `slack-token` and
`github-classic-pat` siblings were already assembled by concatenation for exactly this reason; the
`openai-key` fixture was not. It is now split — twice, because as one 40-character literal the body
is itself the shape of an AWS Secret Access Key and, next to the `AKIA` fixture, completed a pair
that push protection blocks. A pin in the same file reads the file's own source, so a future fixture
reintroducing a contiguous partner-scannable literal fails in the test suite rather than in the
repository's alert list.

**#17** was the `apiKey` field of a sample gateway config in a local-verification runbook, pointing
at a loopback mock on `127.0.0.1` that ignores the field entirely — the value never had to look like
a credential. It is now an obviously fake placeholder with the reason recorded beside it. It
postdated the #2292 delivery by eight days, which is the substantive finding: #2292 verified an
empty queue once, and nothing re-asked the question. `check:secret-scanning-queue` now does, nightly.

## Governed dependency baseline

Every row is enforced by `npm run check:dependency-currency` against `package-lock.json`. `scope` is
`root` or a workspace directory under `packages/`; a workspace-local resolution wins over the
hoisted root copy. A `root` row governs the **hoisted root resolution** — the copy that is actually
bundled — not a root manifest declaration: `postcss` is governed only through the root `overrides`
block, and `monaco-editor` is the hoisted resolution of two workspaces' declarations. A workspace
row is stricter: that workspace must still declare the dependency, or the row is refusing to
describe anything and fails. Dispositions: `current` (newest reviewed release), `patch-deferred` (a compatible
release exists and is intentionally not taken), `major-deferred` (a newer major is behind a
separately governed migration), `unsupported` (the newer release cannot be adopted on this runtime
or peer graph).

| Package                       | Scope                 | Version | Disposition    | Rationale                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast-uri`                    | root                  | 3.1.9   | major-deferred | Patched 3.x line for GHSA-333x-w4r6-6crp, GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr and GHSA-xhq7-xmqj-769h. Retains the compatible major used by current consumers; 4.2.3 is available. Scoped refresh in PR #4069.                                                                                                                          |
| `undici`                      | root                  | 8.12.2  | patch-deferred | Reviewed fixes for GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472 and GHSA-xjj6-f33q-929c. The jsdom override uses 8.12.2; the other-consumer override uses 7.30.1. Later 8.12.3 is available; this repair retains the prepared compatible floors from PR #4050. PR #4069.                                                                         |
| `typescript`                  | root                  | 6.0.3   | major-deferred | Programmatic API lane. TypeScript 7's stable API entry gate is #2269/#2270.                                                                                                                                                                                                                                                                  |
| `typescript`                  | keiko-server          | 6.0.3   | major-deferred | Same API lane as root; the language-service consumers bind to it.                                                                                                                                                                                                                                                                            |
| `typescript`                  | keiko-workspace       | 6.0.3   | major-deferred | Same API lane as root.                                                                                                                                                                                                                                                                                                                       |
| `typescript`                  | keiko-ui              | 5.7.3   | major-deferred | The Next.js-supported UI compiler; UI source is proven separately against native TS 7.                                                                                                                                                                                                                                                       |
| `@typescript/native`          | root                  | 7.0.2   | current        | The native TypeScript 7 compiler, aliased as `npm:typescript@~7.0.2`.                                                                                                                                                                                                                                                                        |
| `eslint`                      | root                  | 10.13.0 | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `eslint`                      | keiko-ui              | 10.13.0 | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `@eslint/js`                  | root                  | 10.0.1  | current        | Realigned with the `eslint` 10 lane by #2777; one family, one major again.                                                                                                                                                                                                                                                                   |
| `typescript-eslint`           | root                  | 8.70.0  | patch-deferred | Owner-approved retention in PR #4066: with identical product sources and the same 12 GiB limit, 8.71.2 exhausts the root lint heap; 8.70.0 passes complete root and UI lint. Retain the exact pin while prioritizing the updater; no heap, lint-rule or gate changes.                                                                        |
| `oxlint`                      | root                  | 1.78.0  | current        | Development-only syntax runner qualified for #3915; supplements typed ESLint and Sonar. Exact MIT pin, native parser visitation and conformance proofs; no product runtime dependency.                                                                                                                                                       |
| `@oxlint/plugins`             | root                  | 1.78.0  | current        | Exact MIT plugin bridge of the pinned anti-slop dependency; native compatibility is qualified, not used as an ESLint replacement.                                                                                                                                                                                                            |
| `oxlint-plugin-anti-slop`     | root                  | 0.1.2   | current        | MIT, Dillon Mulroy (2026). Immutable HTTPS archive at c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b with lockfile SRI and complete source hashes; #3915 qualifies all 21 noncosmetic fixture suites.                                                                                                                                              |
| `next`                        | keiko-ui              | 16.4.2  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `eslint-config-next`          | keiko-ui              | 16.4.2  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `react`                       | keiko-ui              | 19.3.1  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `react-dom`                   | keiko-ui              | 19.3.1  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `prosemirror-commands`        | keiko-ui              | 1.7.2   | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-history`         | keiko-ui              | 1.5.1   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `prosemirror-inputrules`      | keiko-ui              | 1.5.1   | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-keymap`          | keiko-ui              | 1.2.3   | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-markdown`        | keiko-ui              | 1.13.8  | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-model`           | keiko-ui              | 1.25.12 | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-schema-list`     | keiko-ui              | 1.5.1   | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-state`           | keiko-ui              | 1.4.4   | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `prosemirror-view`            | keiko-ui              | 1.42.6  | current        | Pinned MIT-licensed CommonMark composer editing, selection and history; PR #3675.                                                                                                                                                                                                                                                            |
| `katex`                       | keiko-ui              | 0.19.0  | patch-deferred | MIT; typesets math in Coding Workbench answers as MathML, imported lazily (#3906). 0.19.0 is the newest release at least two weeks old: it carries the fix for GHSA-238p-pmpm-9mq7 (below 0.18.2) and replaces the deprecated 0.18.11. 0.19.1 (2026-10-23) is not taken yet.                                                                 |
| `monaco-editor`               | root                  | 0.57.0  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `monaco-editor`               | keiko-ui              | 0.57.0  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `monaco-editor`               | keiko-editor          | 0.57.0  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `@babel/preset-env`           | root                  | 8.0.7   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `vite`                        | keiko-ui              | 8.3.4   | current        | Dependabot #3546; the workspace declaration and root override move together. Includes build/proxy performance work and fixes for CRLF code frames, package-root detection, failed-build cleanup, HTML preload targets, HMR, and asset handling.                                                                                              |
| `vitest`                      | root                  | 4.1.12  | major-deferred | #3474 reverts the Vitest 5 adoption for the mutation lane: Stryker 10 with Vitest 5.0.0 reports zero killed mutants despite a covering dry run, making the security mutation evidence meaningless. 4.1.12 fixes the current mocker advisories while retaining the previously qualified Vitest 4 major; mutation thresholds remain unchanged. |
| `vitest`                      | keiko-ui              | 4.1.12  | major-deferred | Kept exactly aligned with the root because workspace-local Vitest drift previously produced peer-invalid `npm ls` output. The next Vitest major move must first prove non-zero Stryker kills on the security mutation scope.                                                                                                                 |
| `@vitest/coverage-v8`         | root                  | 4.1.12  | major-deferred | Exact peer match for Vitest 4.1.12. Vitest 5 coverage stays deferred with the Vitest major because the security mutation runner, not the coverage package alone, is the blocking evidence path (#3474).                                                                                                                                      |
| `@vitest/utils`               | root                  | 5.0.5   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `autoprefixer`                | keiko-ui              | 10.6.1  | current        | Dependabot #3590 (consolidated 2026-09-25); minor release on the 10.x line.                                                                                                                                                                                                                                                                  |
| `@types/react`                | keiko-ui              | 19.3.0  | current        | Kept exactly aligned with React 19.3 and `@types/react-dom` across the UI and editor workspaces.                                                                                                                                                                                                                                             |
| `axe-core`                    | keiko-ui              | 4.12.1  | patch-deferred | Owner retained 4.12.1 for updater delivery; the existing dependency-review license gate rejects the proposed 4.14.0 MPL-2.0 update. No license exception is added.                                                                                                                                                                           |
| `@noble/hashes`               | keiko-ui              | 2.4.0   | current        | Security/correctness hardening; hash and UI quality gates remain authoritative.                                                                                                                                                                                                                                                              |
| `@types/node`                 | root                  | 26.6.5  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `@types/node`                 | keiko-ui              | 26.6.5  | current        | Matches the UI manifest and root declaration package after the owner-requested Dependabot consolidation; the obsolete nested 26.6.1 lock entry is removed.                                                                                                                                                                                   |
| `@types/react-dom`            | keiko-ui              | 19.3.0  | current        | Kept exactly aligned with React DOM 19.3 and `@types/react` across the UI and editor workspaces.                                                                                                                                                                                                                                             |
| `@vitejs/plugin-react`        | keiko-ui              | 6.1.2   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `@testing-library/react`      | keiko-ui              | 16.3.3  | current        | Fixes re-entrant `act()` behavior while dispatching events.                                                                                                                                                                                                                                                                                  |
| `@testing-library/user-event` | keiko-ui              | 14.6.8  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `@playwright/test`            | root                  | 1.64.1  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `prettier`                    | root                  | 3.9.10  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `knip`                        | root                  | 6.41.0  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `corepack`                    | root                  | 0.36.0  | current        | Lockfile-verified Node 26 bootstrap for the pinned offline Yarn smoke.                                                                                                                                                                                                                                                                       |
| `fallow`                      | root                  | 3.35.0  | current        | Mandatory semantic audit over all source, preserving string values and rejecting every introduced clone group against the immutable comparison commit. The historical baseline grants no exemption; actual merged-tree qualification remains required.                                                                                       |
| `@napi-rs/canvas`             | keiko-local-knowledge | 1.0.11  | current        | Optional host-native backend; deduplicated to one node by the matching root override. Includes font-cache and CSS parser fixes.                                                                                                                                                                                                              |
| `postcss`                     | root                  | 8.5.30  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `source-map-js`               | root                  | 1.2.2   | current        | Patch for GHSA-68fv-2mgg-jv7q; shared transitive resolution used by PostCSS, CSS-Tree, and magicast.                                                                                                                                                                                                                                         |
| `smol-toml`                   | root                  | 1.9.1   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `ws`                          | root                  | 8.22.0  | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |
| `entities`                    | keiko-workspace       | 8.1.0   | current        | Consolidated from the owner-requested Dependabot batch (#4052, #4058, #4062); qualification is recorded in the repair PR.                                                                                                                                                                                                                    |

The live inventory command is `npm outdated --workspaces --include-workspace-root --json`; it
reported 18 non-current direct entries, every one of which is dispositioned above.

**That command has a blind spot, and this closeout walked into it.** Run in aggregate it silently
omits a direct dependency whose only declaring manifest is the root `package.json`; the same package
reports correctly when queried on its own. Three rows above were wrong because of it —
`typescript-eslint` and `knip` were labelled `current` while newer releases existed, and `fallow`
was missing from the table entirely while eleven minor releases behind. `check:dependency-currency`
cannot catch this class either, by design: it compares the document against the lockfile and never
contacts a registry, so it proves the record describes this checkout, never that the checkout is
current. Cross-check individual root devDependencies before claiming a clean sweep.

### Earlier #3918 analyzer and supplier repair

These measurements and the private service-host dependency descriptions refer to the earlier
repair tree, not to qualification of the current merged runtime or dependency graph.

On 2026-10-23, a fresh local recursive OSV scan found two newly reviewed advisories in
Fallow 3.9.1: [GHSA-h4fr-cmh5-qr62](https://github.com/advisories/GHSA-h4fr-cmh5-qr62)
and [GHSA-jfwm-3p3c-6hx5](https://github.com/advisories/GHSA-jfwm-3p3c-6hx5).
Both identify 3.34.0 as patched. The exact development-tool pin and its configuration
validator now require 3.34.0. The semantic duplication policy retains its existing
100-token and 10-line floors, semantic mode, two-occurrence minimum and import exclusion.
Actual comparison of the old and patched tools exposed a pre-existing enforcement defect:
3.9.1 reported clone groups but ignored the standalone failure flag. The repository command
now uses native audit attribution and explicitly rejects nonzero introduced-group counts;
audit's warning exit alone is insufficient. This implements the existing introduced-group
policy without a persistent exemption baseline or an obligation to remove every inherited
clone. It does not authorize optional type-aware analysis or waive either advisory.

A subsequent fresh OSV scan identified newly reviewed Undici advisories
[GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) and
[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c).
Root jsdom tooling now resolves 8.12.2; its separate existing 7.x override is 7.30.1.
The private native host uses version-specific overrides for its existing 6.29.0 and
8.11.2 resolutions, selecting patched 6.29.1 and 8.12.2 without a major-version
migration. No advisory waiver, network authority or resource limit changes.

### Dependabot #4067 integration in PR #4069

The owner-requested integration includes ESLint 10.13.0 and Vite 8.3.4. The existing exact Vite
workspace declaration is now matched by the root override. The existing gates and limits remain
intact. The owner explicitly selected a separate PDF.js qualification: 6.3.289 remains in this PR
because 6.4.299 changes the bundled provider format and fails the unchanged browser-baseline gate.

The TypeScript compiler stays on native 7.0.2, with the 6.0.3 programmatic API and the existing
Next.js UI API lane. The proposed API replacement with 7.0.2 fails the supported peer range of
`typescript-eslint`; the native TypeScript toolchain gate preserves these separate roles.
`typescript-eslint` stays on 8.70.0: a fresh full lint run with 8.71.2 on the combined sources again
exhausted the unchanged 12 GiB heap limit. `axe-core` stays on 4.12.1: #4067's dependency review rejects
4.14.0's MPL-2.0 license under the unchanged permissive-only policy. No license exception, heap
increase or quality-gate relaxation is introduced.

## GitHub Actions baseline

Every action is pinned to a full 40-character commit SHA with a version comment. All 12 external
action repositories resolve their documented tag to exactly the pinned commit.
`check:dependency-currency` enforces the table against the workflow files, in both directions, and
additionally rejects an action repository whose sub-actions have drifted onto different refs —
`github/codeql-action/init` and `/analyze` are not grouped by Dependabot and a one-sided bump is a
guaranteed version-mismatch failure.

| Action                             | Version | Commit                                   | Disposition |
| ---------------------------------- | ------- | ---------------------------------------- | ----------- |
| `actions/checkout`                 | v7.0.1  | 3d3c42e5aac5ba805825da76410c181273ba90b1 | current     |
| `actions/setup-node`               | v7.1.0  | 949feb2413d6458794dcd2491c4babbbce0c15c1 | current     |
| `actions/upload-artifact`          | v7.0.2  | cf430e030ddbb5b0abf93d22962f4752f3646cd9 | current     |
| `actions/download-artifact`        | v8.0.2  | 9000827ccba6bdab643e8b6fd33ac0654aef8333 | current     |
| `actions/cache`                    | v6.1.0  | 55cc8345863c7cc4c66a329aec7e433d2d1c52a9 | current     |
| `actions/attest`                   | v4.2.2  | 1e69f48acb82d1966a394da916b4c1698aa569d6 | current     |
| `actions/create-github-app-token`  | v3.3.0  | 64ab729a6294000f5aa4a4bc0b73d1f32bc45510 | current     |
| `actions/setup-dotnet`             | v6.0.0  | a98b56852c35b8e3190ac28c8c2271da59106c68 | current     |
| `actions/dependency-review-action` | v5.0.0  | a1d282b36b6f3519aa1f3fc636f609c47dddb294 | current     |
| `github/codeql-action`             | v4.39.0 | 6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee | current     |
| `google/osv-scanner-action`        | v2.7.0  | b1d267aea5211fa648d9d442fa64b90dbdcbdd36 | current     |
| `zizmorcore/zizmor-action`         | v0.7.1  | 85b2b9fb8e3325e7a23d7d0a9d7ba5ae0f999e3e | current     |

The 2026-10-23 owner-requested consolidation includes the ten action updates in #4058, including
checkout v7.0.1 and attest v4.2.2. Credential-bound Azure signing actions remain retired under #3403;
Keiko-owned release signatures remain the mandatory cross-platform trust anchor.

## Runtime and toolchain

Enforced by `npm run check:runtime-toolchain` and `npm run check:typescript-toolchain`, which own
these values; this document does not restate them as a second source.

| Surface             | Governed value                    | Enforcing gate               |
| ------------------- | --------------------------------- | ---------------------------- |
| Node.js engine      | `>=24.18.0 <25 \|\| >=26.3.0 <27` | `check:runtime-toolchain`    |
| npm engine          | `>=11.16.0 <12`                   | `check:runtime-toolchain`    |
| packageManager      | `npm@11.16.0`                     | `check:runtime-toolchain`    |
| TypeScript compiler | 7.0.2 (native)                    | `check:typescript-toolchain` |
| TypeScript API      | 6.0.3                             | `check:typescript-toolchain` |
| Internal versions   | 0.3.17 across all workspaces      | `check:version-consistency`  |

## Dependency graph validity (`npm ls`)

#2296's acceptance criteria require that `npm ls` report no invalid graph. It did not, and nothing
in the repository ever asked: `npm ls` at default depth exits 0, which is why this stayed invisible.
At full depth the pre-existing tree reported two invalid packages:

```text
npm error code ELSPROBLEMS
npm error invalid: @vitest/coverage-v8@4.1.10 …/node_modules/@vitest/coverage-v8
npm error invalid: eslint@10.9.1 …/node_modules/eslint
```

**Both are now closed, by two changes that had to be separate.** `keiko-ui` pinned `vitest` at
exactly 4.1.11, whose peer contract demands `@vitest/coverage-v8` 4.1.11 while the root resolved
4.1.10; both root packages now resolve 4.1.11 and the workspace's nested copy is gone — one Vitest
node instead of two, which is what the #2293 matrix said it had achieved and had not. A second
duplicate went with it: `@napi-rs/canvas` resolved 1.0.6 at the root (hoisted through `pdfjs-dist`'s
optional `^1.0.0`) and 1.0.9 under `keiko-local-knowledge`, carrying eleven redundant platform
binaries; a root override collapses them to one node. The ESLint half was
[#2777](https://github.com/oscharko-dev/Keiko/issues/2777)'s: `eslint-config-next@16.3.1` now
declares `eslint: ">=9.0.0"`, `@eslint/js` moved to the 10 lane, and `keiko-ui`'s exact pin became a
range that deduplicates onto the root node.

`npm ls --all --workspaces --include-workspace-root` exits **0** on this branch. Peer validity is
now enforced continuously by `npm run check:eslint-lane` (#2777), wired into the required `ci`
context — it asks npm rather than restating it, which is the right division: npm stays the authority
on peer validity, and this closeout's gate stays the authority on whether the recorded disposition
still describes the checkout.

## Decisions taken here

### `engine-strict` is declined, and this is the reasoning, not a deferral

The question was measured, not estimated: across all 665 `engines` declarations in
`package-lock.json` (1 root, 25 workspaces, 639 third-party), evaluated with the same
`semver.satisfies(v, range, { includePrerelease: true })` predicate npm itself uses, **zero fail**
the original #2296 Node 24.18.0 / npm 11.16.0 measurement; in every class, direct, transitive,
dev and optional. The optional class
cannot fail at all: npm's arborist marks an optional node `inert` and explicitly ignores
`--engine-strict` for it. Only four of the 100 distinct ranges even reject Node 25, behind three
packages (`dependency-cruiser`, `jsdom`, `watskeburt`) that a future Node bump must move anyway.

So the flag is safe to set. It is still the wrong instrument here, for two reasons that the
measurement surfaced rather than settled.

**The protection it adds already exists one layer down, in a stronger form.**
`scripts/check-runtime-toolchain.mjs` compares the **executed** Node and npm against the governed
values — not a declaration, the actual interpreter and the actual npm on `PATH` — and it runs at 28
points across eight workflows, in every case before `npm ci`. `engine-strict` would re-ask a weaker
version of a question that is already answered where it matters.

**Its cost is a silent failure mode in exactly the machinery this closeout exists to protect.**
`engines.node` is upper-bounded (`>=24.18.0 <25 || >=26.3.0 <27`) and `engines.npm` accepts the
governed npm 11 range (`>=11.16.0 <12`). Under `engine-strict` both become hard install-time gates
for _every_ npm process that runs in this working directory, including Dependabot's updater, which
brings its own Node and npm and reads the project
`.npmrc`. If either differs, the dependency-update pull requests stop, and they stop **without
notifying anyone**: an absence of Dependabot PRs looks identical to a quiet week. Disabling the
mechanism that keeps dependencies current, inside the change whose subject is dependency currency,
is not a trade worth a marginal gain.

Recorded so the measurement never has to be repeated. What would have to change first: an
`engines` declaration that a third-party tool can satisfy — see the finding below.

### Repaired finding: the published `engines.npm` constrained consumers unnecessarily

Before this repair, `package.json` published `engines` as
`{"node": ">=24.18.0 <25", "npm": "11.16.0"}`. That manifest reached every consumer of
`@oscharko-dev/keiko`, although the exact npm string was true only of Keiko's
_contributors_ — `check:runtime-toolchain` enforces it — but it is not true of anyone installing the
package, and an organisation that sets `engine-strict` on its own side cannot install Keiko unless it
runs a supported npm 11 version.

This compatibility finding is repaired by the published Node.js 24/26 engine range and npm 11 consumer range. The exact `packageManager` pin remains the reproducible contributor, publication, portable, and measurement baseline; CI separately proves both approved Node/npm tuples.

### License exception: `@sonarsource/analyzer-commons-configurations` is allowed (#3609)

`eslint-plugin-sonarjs` 4.2.1 adds a new transitive dependency,
`@sonarsource/analyzer-commons-configurations@2.31.0-5284`, licensed **LGPL-3.0-only**. Dependency
Review's license allowlist covered the plugin itself (`pkg:npm/eslint-plugin-sonarjs`, the
2026-07-25 amendment to ADR-0002 recorded above) but not this new sub-package, so the required
`Review dependency diff (dev/main)` context failed on the version bump. #3608 kept
`eslint-plugin-sonarjs` at 4.2.0 and `.github/dependabot.yml` ignored `>=4.2.1` until this was
decided.

**Allowed** (owner decision, 2026-09-25, #3609): `pkg:npm/@sonarsource/analyzer-commons-configurations`
is added to `allow-dependencies-licenses` in `.github/workflows/dependency-review.yml`, next to
`pkg:npm/eslint-plugin-sonarjs`. Same vendor and the same license as the already-allowed plugin, and
the same reasoning applies: it is development-only lint tooling, executed in CI and on developer
machines, never linked into Keiko or distributed in the published npm tarball. The Dependabot
`ignore` entry is removed and `eslint-plugin-sonarjs` moves to 4.2.1.

### Exact-artifact original OpenCode host license correction (#3895)

The OpenCode host integration introduced three component classifications that the earlier
package-wide filter could not represent accurately. The engineering-reviewed correction in #3895
binds each disposition to its exact original component identity and artifact. Dependency Review's
global thirteen approved license IDs, the local twelve-license SPDX allowlist, dependency
vulnerability thresholds, action pins, signature checks and merge conditions are unchanged.
[ADR-0002](../adr/ADR-0002-ci-and-supply-chain-security-baseline.md) records the exact scope.

| Original component      | Reviewed disposition                                                                                                                                                                                                             | Preserved distribution obligations                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spdx-exceptions@2.5.0` | Exact SPDX identifier data under `CC-BY-3.0`; no global CC-BY-3.0 allowance.                                                                                                                                                     | Full original README plus Linux Foundation and Contributors copyright attribution, Kyle E. Mitchell credit, pinned upstream source, CC-BY-3.0 license URL, unchanged-file statement and no implied endorsement. |
| `bowser@2.14.1`         | npm metadata declares MIT; the original full notice has the `MITNFA` condition. Only this original artifact is recognized.                                                                                                       | Complete original license, including its original-author bug-report contact condition for substantial functional modifications; no shortened or relabeled MIT notice.                                           |
| `json-schema@0.4.0`     | Use its existing BSD-3-Clause option from `(AFL-2.1 OR BSD-3-Clause)`; the required Dependency Review log separately reports `AFL-2.1 AND AFL-3.0 AND BSD-3-Clause`. The classification disposition is limited to this artifact. | Complete original dual-license notice, including BSD copyright, redistribution conditions and disclaimer; no global AFL-2.1 or AFL-3.0 allowance.                                                               |

The pinned `actions/dependency-review-action` ignores versions in its exclusion PURLs. The workflow
therefore runs the existing supply-chain owner's mandatory preflight before passing the three
package-name exclusions. Both canonical npm locks are inspected: every matching instance must retain
its exact original name, version, registry URL, SRI and declared license. Missing records, malformed
locks, aliases, later versions and artifact or license drift refuse the workflow before exclusions
are emitted. Local CycloneDX evaluation retains its SPDX expression parser and recognizes only exact
component PURL/name/version identities; unrelated licenses and disallowed compound expressions still
fail. The complete original notices and actual dependency SBOM remain in the host payload.

Owning failure-first controls cover missing preflight, aliases, root-lock gaps and identity, artifact
or license drift. Release and platform qualification remain separate from this component
disposition; it does not activate the host or establish complete OpenCode parity.

## Follow-ups

1. **Credential-shaped literals remain in pre-existing test fixtures.** A repository sweep found
   contiguous `AKIA…`, `ghp_…`, `github_pat_…`, `hf_…` and `sk-…` literals across roughly ten test
   files under `packages/*/src` and `tests/`. None has fired an alert — GitHub validity-checks AWS
   keys, which filters the sequential fakes, and the required `Secret scan` job only reads
   `base..head` of a pull request, never the whole tree. They are the same class as alert #20 and
   worth one batch pass; splitting them here would have expanded this closeout across ten unrelated
   files for no evidenced risk reduction.

## The measurement-toolchain repairs, and what made them look blocked

[#3304](https://github.com/oscharko-dev/Keiko/issues/3304) was filed for two repairs this closeout
found and could not land: the credential-shaped `apiKey` placeholder in
`tests/e2e/fixtures/keiko.e2e.config.json`, and fourteen hardcoded `24.18.0` / `11.16.0` literals in
`build-d12-bundle-input.mjs`, `build-d12-perf-comparison.mjs` and `check-perf-evidence.mjs` — the
same two-sources-of-truth defect already repaired in `portable-manual-review.mjs`. All four files are
members of a measurement-toolchain digest, so each repair turned `check:perf-evidence` red and
obliged a re-measurement.

**Both are done here**, because the obstacle turned out to be the documentation rather than the
machine. The repairs are in this change, and both evidence documents are regenerated on the
reference environment as its final commit.

The obstacle: the editor D12 evidence had a one-command producer
(`npm run perf:evidence:regen:container`), while the workspace evidence had two lines of prose and
the instruction to run it "on its declared reference environment" — without stating anywhere which
environment that is. A pull request that moved the workspace ruler therefore had to invent its own
invocation, and an invented measurement measures something nobody can compare against the committed
numbers. That ambiguity is the same defect class as everything else in this closeout: an instruction
nobody can follow unambiguously is not an instruction.

Closed in [`docs/qa/perf-evidence.md`](../qa/perf-evidence.md):

- The workspace reference environment is now **evidenced rather than asserted** — `ci.yml` refreshes
  that document on every push to `dev` (`ubuntu-latest`) and only validates freshness on a pull
  request, so the producer is Linux, and a pull request that moves the ruler must bring a
  Linux-produced document.
- Why `ubuntu-latest` and the pinned `arm64` container are both acceptable producers while a macOS
  host is not: unlike the D12 document, this one records no per-machine provenance and its budgets
  carry wide headroom. It is a browser-performance regression detector, not an absolute instrument
  calibrated to one machine class.
- `npm run perf:evidence:regen:workspace` exists, and shares the editor producer's container driver
  rather than growing a second one. A test pins that `--workspace` does not route into the editor
  lane — sending it there would measure the wrong thing for thirty-five minutes.

## Verification

Run on macOS (darwin/arm64) against this branch, after merging `origin/dev` — except the two
performance-evidence documents, which were re-measured in the pinned `node:24.18.0-bookworm`
container on the declared reference environment, with the host verified idle first. Platform
coverage for Linux and Windows is CI's, not this document's: the required checks on the pull request are the
complete arbiter, and no macOS-generated value is offered here as a substitute for
platform-authoritative evidence.

| Command                                                     | Result                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `npm ci`                                                    | pass                                                     |
| `npm audit --json`                                          | pass — 0 vulnerabilities across 944 packages             |
| `npm outdated --workspaces --include-workspace-root --json` | 18 non-current direct entries, all dispositioned         |
| `npm ls --all --workspaces --include-workspace-root`        | pass — exit 0, no invalid entries (was 2)                |
| `npm run format:check`                                      | pass                                                     |
| `npm run typecheck`                                         | pass                                                     |
| `npm run lint`                                              | pass                                                     |
| `npm test`                                                  | pass — 1729 files, 33 276 tests, 0 failures              |
| `npm run arch:check`                                        | pass                                                     |
| `npm run arch:check:negative`                               | pass                                                     |
| `npm run check:knip`                                        | pass                                                     |
| `npm run check:eslint-lane`                                 | pass — `npm ls eslint` exits 0 (#2777)                   |
| `npm run check:perf-evidence`                               | pass — both documents within budget and internally sound |
| `npm run check:dependency-currency`                         | pass — 38 dependency rows, 14 action rows                |
| `npm run check:secret-scanning-queue`                       | pass — 0 open alerts; both prior findings closed         |
| `npm run check:runtime-toolchain`                           | pass — Node 24.18.0; npm 11.16.0; 25 workspaces          |
| `npm run check:typescript-toolchain`                        | pass — compiler 7.0.2; API 6.0.3                         |
| `npm run check:portable-approvals`                          | pass — node 24.18.0                                      |
| `npm run check:version-consistency`                         | pass — 0.3.17 across every workspace                     |
| `npm run check:dependency-hygiene`                          | pass — 26 manifests, 6006 tracked paths                  |
| `npm run check:workspace-supply-chain`                      | pass                                                     |
| `npm run check:adr-index`                                   | pass — 158 ADRs indexed                                  |
| `npm run check:zizmor-anchors`                              | pass — 8 anchors still on the step they document         |
| `npm run check:release-impact`                              | pass                                                     |
| `npm run gates:sonar`                                       | pass — no unresolved finding on the changed files        |

`gates:sonar` reported three findings on its first run, all in the two new gate scripts, and all
from rules `eslint-plugin-sonarjs` does not ship: a locale-naive `Array#sort`, two consecutive
`Array#push` calls, and a bare `PATH` lookup for the `gh` binary. All three are fixed; the last one
now resolves `gh` through the repository's existing hardened resolver, so a writable directory
earlier in `PATH` cannot substitute the binary that reads this repository's security findings.

Not run locally, and left to the required CI matrix: `npm ci` on Linux and Windows, the assembled
package-surface check, install smoke, SBOM/license publication, and the Linux-authoritative
UI/editor evidence lanes.

## Rollback

Reverting this change is safe but is not a no-op, and an earlier draft of this section said
otherwise. It touches more than twenty files across five kinds of change:

- **Two new gates** (`check:dependency-currency`, `check:secret-scanning-queue`), a shared
  markdown-table reader, one new scheduled workflow, and a new workflow-pin anchor test.
- **Resolved dependency versions**: `vitest` and `@vitest/coverage-v8` move to 4.1.11 and
  `@napi-rs/canvas` is deduplicated to 1.0.9 through a root override. Reverting restores the
  peer-invalid `npm ls` state and the eleven redundant platform binaries.
- **Workflow edits**: a required step added to `ci.yml`, a toolchain gate added to
  `nightly-perf-evidence.yml`, and five re-pointed line anchors in `.github/zizmor.yml` — revert
  those together, or `check:zizmor-anchors` goes red on an unrelated diff.
- **Two existing gate scripts extended** (`check-runtime-toolchain.mjs` workspace npm engines,
  `portable-manual-review.mjs` derived Node version).
- **Documentation**: this document, the #2293 supersede banner, ADR-0001's status block, and four
  runbooks.

No product runtime behaviour, published surface, or state store changes; the only source edit under
`packages/` is a corrected comment.

### 2026-10-22 OSV patch refresh (#3918)

The required workflow-hygiene scan on PR #4013 identified fixable advisories in Vite, the Vitest mocker, markdown-it and the native MCP client. The root override and UI Vite declaration move together to 8.3.3. Root/UI Vitest and the coverage peer stay on the reviewed Vitest 4 major and move together to 4.1.12; the Vitest 5/Stryker deferral remains. The existing prosemirror-markdown dependency resolves markdown-it 14.3.3 without a new direct dependency. The native host retains its existing MCP override mechanism and aligns client/core at 2.3.0, as required by the client's exact core dependency. The pinned scanner, waiver set and security policy are unchanged. This security update does not establish a cause or fix for the separately open Node 26 grounding-import finding.

### Source projection runtime dependencies (#4040)

The security boundary lazily loads the existing TypeScript 6.0.3 API and YAML 2.9.1 parser only
when their formats require them. Java ownership uses java-parser 3.0.1 (Apache-2.0) and its CST;
no source is compiled or executed during redaction. Global overrides resolve both lodash variants
to 4.18.1: upstream 4.17.21 and the earlier 4.17.23 correction remain affected by
[GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) and
[GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh).
The initial scoped overrides failed the actual product graph resolution check and were replaced
by global overrides. The assembled root also declares the same Java parser runtime: npm 11.16.0
does not propagate these overrides into the workspace-only parser graph. Merely replacing the
locked files leaves invalid dependency edges. The root declaration gives the existing parser graph
the root override set without adding another installed package. Actual npm resolution, supplier audit and release gates must pass before
adoption; the earlier isolated sandbox audit alone is insufficient.
Knip cannot observe this root lock-resolution requirement as an import. Its exact root workspace
ignores only `java-parser`; the security workspace dependency and imports remain checked. This
exception does not permit an unused runtime parser or alter the resolved graph. The actual
workspace-only and invalid-edge attempts remain retained alongside passing `npm ls` and the
production supplier audit.

| Dependency    | Scope            | Resolved version | Disposition |
| ------------- | ---------------- | ---------------- | ----------- |
| `java-parser` | `root`           | `3.0.1`          | current     |
| `java-parser` | `keiko-security` | `3.0.1`          | current     |
| `typescript`  | `keiko-security` | `6.0.3`          | current     |
| `yaml`        | `keiko-security` | `2.9.1`          | current     |
| `lodash`      | `root`           | `4.18.1`         | current     |
| `lodash-es`   | `root`           | `4.18.1`         | current     |

### Security repair 2026-10-20: Vite and native MCP client

PR #4046's required OSV scan reported two newly reviewed advisories on its published repair head.
The root Vite override and UI declaration now pin 8.3.3 for
[GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv).
The native service host's existing selective client/core overrides now pin 2.3.0 for
[GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw);
the client requires core exactly 2.3.0. Its default redirect restriction remains enabled.
Both canonical npm locks are regenerated. Resolver-required Rolldown bindings, OXC types and the
native core's Zod patch remain visible in the lock diff. MCP's new Apache-2.0 metadata is already
within the approved license set; no waiver or license exception changes.

The original native provider/host compatibility tests, patched Vite test/build lanes, dependency
currency/hygiene, supply-chain checks and a fresh scan qualify these exact inputs. Historical native
source-lock evidence keeps its original binding. The earlier full coverage attempt on the preceding
head was stopped after the security failure and receives no full-suite acceptance credit.

### 2026-10-21 — Vitest 4 security patch for release 1.2.6

The required OSV scan began reporting [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) and [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) in the development-only `@vitest/mocker` 4.1.11 graph during updater release verification. Root and UI Vitest, coverage-v8 and the directly imported serializer utilities are aligned at 4.1.12. The unchanged OSV Scanner 2.6.0 reproduces both findings on the prior tracked source and reports no findings on the patched graph after its existing reviewed filters. No waiver was added. The Vitest 5 / Stryker major-version deferral remains in force; this patch does not alter mutation or coverage floors.

## 2026-10-23 Dependabot consolidation

The owner requested the combined changes from #4052, #4058 and #4062 in the updater repair.
TypeScript API declarations remain on the existing supported 6.0.3 lane, and the UI retains its
5.7.3 compatibility package; the separate native compiler remains 7.0.2. The owner explicitly
approved this exception. #4065 tracks dependency-automation alignment; #2269 and #2270 retain
ownership of the future API migration and compatibility removal.

The direct test serializer `@vitest/utils` advances to 5.0.5. Vitest and coverage remain 4.1.12,
with their own 4.1.12 utility dependencies, so this does not adopt the deferred Vitest 5 runner
or change the Stryker mutation lane. The existing qualification reporter suite passes all
12 cases with the new direct serializer.

`http-cache-semantics` now resolves to 4.3.0 through #4052. The earlier 4.2.0 observation above
is historical. The current npm audit no longer reports that package; the remaining five high
entries are the existing development-only `braces` chain. OSV Scanner 2.7.0 reports the
`http-cache-semantics` exception as unused and no unsuppressed findings. Its obsolete
`GHSA-ch52-4w7c-c8xp` waiver is removed; the existing development-only `braces` exception remains.
Consolidation does not claim the full release qualification or the actual SSD updater acceptance
has passed.

The root `@napi-rs/canvas` override now matches #4062's workspace requirement at 1.0.11. Keeping
the earlier 1.0.9 override would prevent the requested update and leave no root runtime version
for publish staging; the resulting lockfile contains one deduplicated 1.0.11 runtime node.

The owner separately retained PDF.js 6.3.289 to prioritize updater delivery. Dependabot's
transitive lockfile refresh selected 6.4.299, whose changed core-js bundle format is not admitted
by the existing browser-baseline provider recognizer. The exact root dependency pin retains the
verified 6.3.289 closure; the browser floors and provider-recognition gate remain unchanged.
The compatibility-gate controls reproduce both failures with 6.4.299 before this disposition.

The owner also retained the existing axe-core 4.12.1 test dependency. GitHub dependency review
rejects the proposed 4.14.0 MPL-2.0 update under its existing permissive-license policy. This
disposition adds no license exception or policy change and does not remove accessibility tests.

### 2026-10-24 — Sonar repair CI dependency blockers (PR #4069)

The exact pinned OSV 2.7.0 container reproduced 17 findings on the unchanged baseline locks.
This repair reuses the bounded dependency versions already prepared in PR #4050: root undici
7.30.1/8.12.2, fast-uri 3.1.9 and Fallow 3.34.0; native undici 6.29.1/8.12.2 and Zod 4.6.7.
No OpenCode, Effect or other native package version changes. The native graph removes the three
nested Zod copies while retaining the existing fixed host, model binding and authority profile.

All 71 native host tests pass, including original issuer-bound MCP refresh, guarded provider
transport, PTY behavior, the original GitLab direct-access client with valid and malformed header
records, the original GitLab OAuth schema's optional refresh-token and invalid-expiry paths, and an
early-rejection control for oversized constrained Zod arrays. The GitLab consumer previously resolved
Zod 3.25.76; the advisory also covers that version. Both of its actual schema families are exercised
against the patched runtime rather than assuming compatibility from version numbers. This is evidence
for the tested product/SDK paths rather than a claim of exhaustive upstream API equivalence.
The same OSV container then reports no unwaived issue; the existing, unchanged, time-boxed
build-only braces disposition remains recorded in osv-scanner.toml. No advisory waiver, gate
threshold, provider availability or release approval is added.

PR #4064 (#3897, #3898) advanced Fallow to 3.35.0 and initially used generated-file
exclusions with a shrink-only duplication baseline. The #3918 reconciliation retains that
933-key artifact as historical diagnostic data only: the mandatory audit preserves string
values, covers generated and ordinary source alike, and rejects every introduced clone group
against its immutable comparison commit. The legacy artifact grants no exemption. Actual
3.35.0 qualification on the merged tree remains required. The private OpenCode service host
was removed together with its lockfile and overrides, so its Zod, undici 6 and undici 8
boundaries described above no longer exist in the tree.
