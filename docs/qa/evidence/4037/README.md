# Chat/Files qualification observations

These are bounded body-free observations for #4037/#4040 and #4017–#4021. They do not close
those issues or replace exact-head CI, native browser qualification, semantic review or the
inherited 96-criterion ledger.

- `native-skill-observations-2026-10-18.json` contains 36 case-level records from four declared
  native Gemma batches, including the failed six-case generation batch. Runtime/fixture/skill
  digests, physical-attempt counts, accounting/persistence checks, unchanged generated-test
  hashes and restricted execution outcomes retain their original identities. Later skill
  revisions are not qualified by earlier outputs. A correct-subject failure earns no mutation
  credit. Semantic and customer-profile review is separately pending.
  The original `status` is frozen at generation return; `executionStatus` and the variant records
  describe subsequent execution. The six failed React v4 cases each have zero case-bound answer
  attempts. Their separately recorded setup readiness probe returned HTTP 500; setup waiting is
  not an answer attempt. Failed setup and generation remain in the denominator.
- `symbol-discovery-read-batching.json` compares the actual production retrieval path on the
  same one-file corpus and original question/grants, with no model call. Ordered ranges, byte
  lengths and content hashes agree. Read amplification is corrected. The original mechanical joins retain their
  observed presence/absence; equivalent current implementation ranges may establish the same budget
  facts. Named-function probes alone do not establish semantic recall success or failure. Timing
  under concurrent local work is an observation, not latency qualification.

Raw source/prompt/answer content, provider locations and credentials stay outside the checkout.

`github-pr-lifecycle.json` records a separate native GitHub fixture with the three product job
name/admission expressions copied verbatim. Open and reopened runs publish canonical required
names; closed metadata edits and a rerun of that closed payload skip the jobs without those names.
GitHub labels skipped jobs with their unexpanded name expressions. The initial expectation of
literal inactive labels failed and is retained. These results qualify name/admission semantics,
not the complete product matrix or strict merge-candidate verification. The isolated fixture PR
is closed without merging; product delivery remains governed by PR #4046.

The existing Chat skills lab owns runtime pairing, selected-skill import/accounting, real product
requests and offline execution. Private run receipts preserve failed setup, transport, interrupted
and unavailable-history attempts. Fresh recreated environments never establish a byte-exact
historical replay. Independent reviewer measurements are reported separately in PR #4046.

## Portable update eligibility (#4047)

The customer screenshots establish misleading setup-only update wording. They do not establish
that a newer release exists or identify the customer's installation failure. The startup notice
and update panel now derive update headings from actual availability; setup eligibility remains
a separate state. Native package replacement, restart, browser trust and SSD continuity remain
open acceptance work.

A separate isolated Linux/amd64 container ran the actual published v1.2.3 portable setup and
launcher, using the downloaded archive whose SHA-256 matches the published checksum
(`a3c1220469cfbe934b163063f93479832e64699b53e959a901576e832d11e253`). Its actual BFF reported
package-manager/local-install rather than the managed portable installation. Its existing Activity
Log contained no update classification observation. A bundled candidate detector, run against
those unchanged installed files, recognizes `portable-managed`, target `linux-x64`, version
`1.2.3`, with matching setup/root/launcher identities. This is candidate-engine recognition of a
real released installation, not an updated release or a successful N−1 → N replacement. The
sandbox is emulated Linux/amd64, not native macOS or Windows evidence.

Failure-first owner tests separately establish the missing Linux target/layout and incorrect
macOS system-root classification (5 failures, 35 healthy controls), four missing POSIX identity
refusals after the layout-only correction (4 failures, 40 healthy controls), and two unresolved
system-root aliases after the first classifier correction (2 failures, 39 healthy controls).
The original forbidden alias resolving to the canonical macOS root remains denied. The launcher
and server now share the pure existing-policy classifier, while staging and automatic Coding
discovery reuse the corrected portable layout. Windows bounded-read exceptions and zero-unsafe-read
checks retain their existing semantics. Preflight and session-status owners emit body-free mode,
reason, target and elapsed-time evidence on the existing Activity Log with request correlation.

The first increment's optional translation move was also caught by the existing startup import
boundary in both CI coverage jobs. The exact control reproduced locally before repair. Its
assertions remain unchanged: the existing thin startup controller now loads the view/catalog only
for an admitted visible notice. The original four boundary controls, seven source-freshness
controls, 75 updater presentation tests and complete UI coverage (10,692 passing, one existing
skip) pass on that revision. The original nine-scenario browser producer was repeated with fresh
tracked evidence. An initial local Sonar analysis was invalidated by editing a source while it
ran; it receives no pass credit and is repeated on frozen inputs. Setup/root/launcher attestation I/O errors
propagate through the existing request error/logging path. Explicit missing/symlinked POSIX roots
and missing launcher files produce a closed refusal; the existing Windows bounded-read exceptions
remain unchanged.

The added lazy-view failure control also reproduced a desktop-wide error before local containment
(1 failure, 1 healthy suppressed-current control) using the installed App Router loader. After the
fix the workspace remains mounted, diagnostics contain no raw import error, and the existing
Updates action works. The final owning presentation count is 77 and complete UI coverage is
10,694 passing with one existing skip. Earlier partial/superseded runs remain separate receipts.
