# Controlled local support workspace

Keiko produces a body-free local report and sends nothing. A human decides whether and how to
share it through an organization-approved manual channel. The report is private diagnostic
metadata: fingerprints, versions, correlations, process identifiers, safe Keiko frames, counts
and statuses can still reveal operational details even though customer content is excluded.

## On the originating installation

Select an existing incident with `keiko support incident list`, then run:

```bash
keiko support export --incident <incident-id>
```

`--correlation-id <id>` selects one operation's registered causal closure instead, and
`--defect-fingerprint <sha256>` an existing incident by its fingerprint. Without a selector the
export records a user-reported incident ("Report a problem") and exports its window. An unknown
incident or fingerprint, or a correlation without retained evidence, records nothing, writes
nothing and exits 1, so a mistyped id never pins an incident window.

The terminal names the private file and its diagnostic sufficiency. The default directory is
`<stateDir>/support-reports/`; `--out` names another directory, never a file. A new directory is
created owner-only, an existing one must not be writable by group or others, and no directory
inside an Activity Log is accepted. The filename contains only the product prefix, schema version,
incident prefix and the incident's UTC creation date. The hard maximum is 10 MiB; use `--max-bytes`
to lower it for a narrower sharing policy. There is one file, with embedded integrity, and no
attachments or sidecar. Raw logs, screenshots, free-text notes, arbitrary files, configuration
snapshots and evidence manifests cannot be included. All former inclusion flags are refused.

A report can honestly be `insufficient`: its closed reasons and required byte count explain what
is missing. If its header cannot fit, nothing is published. Existing destinations are never
replaced. The report is staged as a private `.keiko-publish-<24 hex>-<n>.stage` copy beside its
destination and then linked into place; an interrupted export can leave that stage behind, and
the next export into the directory names how many it found. A stage is never a report: do not
rename it into one or share it, and delete it once the failure evidence is preserved.

Exit status 0 means a report was written; 1 means a closed refusal; 2 is a usage error. Each
export records body-free `support.report.started` and `support.report.completed` or
`support.report.failed` lines (closed reasons, byte counts and publication assurance, never a
path) in the selected state directory's Activity Log; a refused destination is recorded in the
CLI control state instead.

## Desktop export and recovery

Use **Create error report** on a visible error, then **Download report** to save the report for
that error's Support ID. Chat, Files, Editor loading failures, window and shell boundaries use the
same action. Uncaught browser failures expose the action in the existing shell alert area. The
footer retains the centered product version; there is no separate Diagnosis window or incident
counter for customers. A degraded or unavailable diagnostic writer adds a plain-language workspace
notice with the same report action. Closed technical reasons remain in `/api/health`, `keiko status`,
the Activity Log and the downloaded report.

Creation has a bounded deadline, blocks duplicate clicks and remains retryable after failure.
Generation keeps a real browser download link available so the customer can retry a blocked
save without regenerating evidence. The UI reports that the report is ready; it does not claim
that the operating system has saved the file. Desktop downloads use a standard `.json.gz`
attachment whose decompressed bytes are the canonical report. The analyzer accepts that transport
without changing the report schema or integrity rules.

Prepared reports remain in the existing bounded, transient download cache for at most fifteen
minutes, without a persistent report archive. The browser cache holds at most 10 MiB of canonical
report bytes. The server cache reserves at most 20 MiB of retained raw-or-gzip payload and 128
entries. Full server-evidence attachments require their original authenticated local session on
every attempt; a download reference alone grants no authority. Validated limited client-only
attachments may be downloaded without pairing and never grant stored server-log access. Expired downloads can be prepared again.
Global errors remain until the person dismisses them; successful preparation alone never dismisses
the only recovery action. A failed preparation keeps the original error and Support ID visible.
Keiko neither uploads nor sends the file. Share it manually through an approved support channel.

The internal diagnostic candidate store uses the Activity Log retention-byte policy, rather than
an independent fixed candidate-count limit. Unreported candidates expire after twenty-four hours.
Under byte pressure, the oldest eligible candidate rolls out and its owned pin and claims are
released. Successfully preparing an export completes the selected candidate and releases its owned
artifacts. The retained Activity Log remains subject to its existing byte and age policy. These
control records support causal reconstruction; they are not a customer-facing count of unresolved
product defects. Read-only health inspection counts readable, unexpired candidates without
expiring files or claiming writer ownership. Capacity changes emit body-free
`support.diagnostics.capacity` evidence with counts only.

If the report action says to open Keiko from the launcher, the local application session was refused.
Open Keiko through its trusted launcher and retry the **same** error's report. Refreshing an old tab
alone cannot restore a session invalidated by a server restart. Full server-evidence reports wait for application bootstrap and require a valid paired session.
Limited client-only reports can still be prepared and downloaded from validated body-free browser
facts without pairing; if the BFF is unavailable, the browser uses the shared canonical producer. Local session
confirmation restores missing scoped cookie projections of an already valid bearer after an upgrade;
it never mints authority or extends the server-owned absolute lifetime. Neither recovery nor error reporting
bypasses that authority.

If Keiko is unavailable, restore the local application, then retry. If report requests are rate
limited, wait one minute before retrying. When the desktop cannot run, an operator can still use the
installed CLI on the originating machine without a browser or model provider:

```bash
keiko support export --correlation-id <support-id> --state-dir <installation-state-directory>
```

Select the same state directory as the affected installation. Do not send raw logs or configuration
as a substitute. A support report cannot recover evidence already removed by retention or a log that
was never durably written; the canonical result records insufficiency or a closed refusal instead
of claiming a complete reconstruction.

The server records `support.report.ui.delivered` only when the attachment response finishes;
its `parentCorrelationId` joins report creation and its `reportDigest` identifies the canonical
artifact. `reportBytes` is canonical size; `transportBytes` is the separate gzip response size.
Cancellation, compression and response-write failures use `support.report.ui.failed` instead.
A refusal uses `support.report.ui.download-refused` with a closed reason. These facts never prove
that the operating system saved the file. Preparation reports the artifact's quality separately
as `reportCompleteness` and `reportLoss`; the preparation event's own completeness/loss describe
whether that event was recorded intact. Availability reasons apply only to client-only scope.

### Local cleanup after preparing a report

Preparing a report retires its temporary incident candidate; it does not prove a download was
saved. Once the candidate is inspected, `support.incident.retirement-started` records the withdrawal
attempt under its request correlation and joins the original incident through its parent correlation.
The terminal `support.incident.dismissed` closes that request and records the intended incident state, explicit `removalStatus`,
`claimsStatus` and `pinRelease`. A failed removal leaves the candidate and its ownership intact,
with claims and pin release `not-attempted`. Failed claim cleanup after removal is a distinct
`dismissed-incomplete` result: the incident is withdrawn, but local cleanup is incomplete. The CLI
says so and returns a nonzero exit status. Both failure paths retain their reduced error class,
frames and cause chain on the terminal line at warning level; the dismissal correlation links to
the incident lifecycle. An already absent owned pin is `not-pinned`, not a cleanup failure.

`retentionDisposition` distinguishes `stored` from `transient` report descriptors. Transient
descriptors have no retained incident pin, so their summary omits `pinDisposition` instead of
claiming a rejected pin attempt. Full server evidence still requires the paired session described
above. A reported completion never carries the `abandoned` retirement reason.

### Recognising a limited report

After validation, `incident.clientReport` identifies a limited artifact with
`serverEvidence: unavailable`, empty registered server evidence and unverified, validated browser
failure facts when available. Its closed `availabilityReason` is one of `session-unavailable`,
`diagnostic-delivery-unavailable`, `service-unavailable`, `client-only-selected` or
`correlation-unavailable`. The last two describe an explicit scope choice or a missing trustworthy
original correlation, not an inferred service outage. A structurally complete canonical report
may still have insufficient diagnostic evidence; integrity and diagnostic sufficiency answer
different questions. Never treat browser descriptors as authoritative server attribution.

`.json.gz` is an outer transport. Section/report digests and `sourceArtifactDigest` cover the
decoded canonical report text, not gzip header metadata or the compressed file bytes. Equivalent
gzip framing may therefore validate to the same artifact digest. Keep a separate SHA-256 of the
received file if a custody workflow requires identity of those exact transport bytes. Decompression
remains bounded and gzip corruption, invalid decoded JSON and changed canonical evidence fail
validation; transport metadata is never interpreted as report evidence.

## On the support team's machine

1. Receive the file manually into an access-controlled workspace, under a locally chosen filename.
   Preserve the received bytes for chain of custody (binary mode, no line-ending or encoding
   conversion). Canonical report bytes are integrity checked after transport decompression. Keep the directory owner-only (0700 on POSIX) and the file owner-only (0600).
   Do not grant an agent broader filesystem/network authority just to handle the report. Do not
   preview its raw
   contents in a terminal, editor, model context or automation before validation.
2. Use a supported Keiko analyzer offline. It reads only the explicitly selected private,
   single-link regular file, bounds the read, validates every section and decoded event, rejects
   controls and checks digests and the exact recorded registry. It never resolves embedded segment
   identifiers, probes a recorded PID, follows a network reference or executes content.

   ```bash
   umask 077
   keiko support analyze ./received-report.json.gz --json > ./analyzed-report.json
   ```

3. Require exit status 0 before using the generated machine view. A rejected input exits 1 and
   produces no analyzed report data; keep its closed failure reason as the finding:
   `corrupt-report` (bytes, encoding or digests do not hold), `unsafe-report` (a value or relation
   the producer never writes), `unsupported-report` (an unknown schema or registry, or a newer
   declared minimum analyzer version, which the message then names), `report-budget-exceeded` (a
   hard bound), `legacy-input` (a raw log or a retired open JSONL bundle), `selection-unavailable`
   or `seed-unavailable` (the requested correlation or seed is not in the report). Product-version
   comparison is bounded, rejects malformed versions and uses numeric release/prerelease
   precedence. Obtain a trusted supported analyzer through the normal governed update process; the
   report cannot supply a schema, binary or installation command. For `legacy-input`, ask for
   regeneration on the originating installation, without importing old config/evidence sections.
4. Give an authorized agent only `analyzed-report.json`, the versioned
   `keiko.support.report-analysis` projection. Read `selection.status/reasons`,
   `analysis.sufficiency`, loss and coverage before asserting that an absence proves anything.
   Integrity is self-consistency; `authenticity` is always `unknown`, including for a completely
   reconstructable report. A sender who can rewrite every checksum can forge self-consistency.
5. Use its ordered timelines, failure clusters, safe frames/causes and available deterministic
   `seed`. `keiko support analyze ./received-report.json --seed` selects the incident correlation
   by default; `--correlation-id` selects another known timeline, and with `--json` emits only that
   validated timeline (`keiko.support.report-timeline`) for `keiko investigate --from-timeline`.
   Each analysis records body-free `support.report.*` lines in the CLI control state.
   `--emit-fixture PATH` prepares
   an existing safe gateway replay fixture and never overwrites a target. Follow the
   [red/green reproduction recipe](reproduction-harness.md); no user-authored reproduction text
   or captured prompt/response is required. Missing replay capabilities remain explicit.

Keep the original and analyzed files within the organization's approved retention and access
policy. No receiver service, database, automatic disclosure, mail composition or external-app
launch is implemented. Built-in encryption, signatures and key distribution/rotation/recovery
are future hardening requiring a real separately governed lifecycle.

## Format and regression compatibility

Schema 1 uses canonical JSON with incident, selection, losslessly compacted registered events and
embedded SHA-256 section/overall digests. The bounds are independent: 10 MiB final file, 1 MiB
incident, 16 MiB decoded events, 64 KiB per event, 20,000 records, depth 12, 250,000 containers,
3,000,000 values and 256 keys per object, checked on the raw text before it is parsed. Strings are
printable ASCII only. Derived ordinary and
update timelines together permit at most 80,000 record occurrences and 64 MiB of UTF-8 record-view
payloads. Parent fan-out is checked before expansion; excessive export evidence is marked
insufficient, and excessive received evidence is rejected before output. Private permissions,
exclusive publication, canonical bytes and bounded decompression are mandatory. Analysis reads in
32 KiB chunks and emits the fully validated machine view in bounded chunks; decompression and
parsing have separate hard ceilings. A 2,000-event production calibration also runs offline under a
128 MiB Node heap with embedded file and network access actively denied.

Producer-only prose/route escape hatches do not cross the received-report boundary: `path`,
`routeTemplate`, `clientNote` and `diagnosticSummary` are explicit redaction markers. Safe route
counts/statuses/digests remain available; these markers are never usable HTTP replay addresses.
Frames and causes are rechecked through their owning reducers, including traversal rejection.

Historical catalog snapshots are immutable repository-owned data, shipped with the reader and
selected by exact registry/schema/catalog identity. Supported coverage starts at release 1.1.9;
unknown identities fail closed rather than using the current schema. `npm run set-version`
regenerates the snapshots from the stable release tags, so every release older than the current
version ships its registry; a drift test fails when one is missing or differs from its release
commit. The frozen pre-move production fixture (#3558) proves historical reconstruction without
restating the writer's identity formula.

The old CLI bundle/sidecar/config/evidence serializers are retired. Their security invariants now
run through the canonical CLI and file-I/O tests: no secret/environment/UI/file capture, exclusive
private publication, unsafe link/permission refusal, zero hostile-data rendering, complete causal
reconstruction, and honest insufficiency. Generic interruption, mutation races and exact-byte
recovery remain pinned in `keiko-security/src/fs-hardening.test.ts`. Reports never open a store for
a diagnostic snapshot, so the store-fingerprint producers were retired with the bundle; the export
test pins that corrupt store files stay byte-for-byte untouched and that no store or vault key is
created. Local raw-log analysis helpers remain developer facilities, not an admission boundary for
received files.

Operator scripts drop inclusion flags and the sidecar step, pass a private directory to `--out`
instead of a filename, and read the versioned machine envelope (`analysis.timelines`,
`analysis.clusters`, `seed`).
