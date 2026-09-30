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

The terminal names the private file in `<stateDir>/support-reports/` and its diagnostic sufficiency.
The filename contains only the product prefix, schema version, incident prefix and UTC date. The
hard maximum is 10 MiB; use `--max-bytes` to lower it for a narrower sharing policy. There is one
file, with embedded integrity, and no attachments or sidecar. Raw logs, screenshots, free-text
notes, arbitrary files, configuration snapshots and evidence manifests cannot be included.
All former inclusion flags are refused.

A report can honestly be `insufficient`: its closed reasons and required event-byte count explain
what is missing. If its header cannot fit, nothing is published. Existing destinations are never
replaced. An interrupted publication leaves private recognizable staging/recovery state; the
shared safe publisher recovers only the exact intended bytes or fails closed. Do not rename a
stage into a report, delete recovery metadata to obtain success, or treat a partial file as valid.
Choose a fresh private output directory only after preserving and inspecting the prior failure evidence.

## On the support team's machine

1. Receive the file manually into an access-controlled workspace, under a locally chosen filename.
   Keep the directory owner-only (0700 on POSIX) and the file owner-only (0600). Do not grant an
   agent broader filesystem/network authority just to handle the report. Do not preview its raw
   contents in a terminal, editor, model context or automation before validation.
2. Use a supported Keiko analyzer offline. It reads only the explicitly selected private,
   single-link regular file, bounds the read, validates every section and decoded event, rejects
   controls and checks digests and the exact recorded registry. It never resolves embedded segment
   identifiers, probes a recorded PID, follows a network reference or executes content.

   ```bash
   umask 077
   keiko support analyze ./received-report.json --json > ./analyzed-report.json
   ```

3. Require exit status 0 before using the generated machine view. A rejected input produces no
   analyzed report data; keep the closed failure reason as the finding. An unsupported schema or
   catalog names its declared minimum analyzer version. Obtain a trusted supported analyzer through
   the normal governed update process; the report cannot supply a schema, binary or installation
   command. Legacy raw logs/open JSONL bundles are refused: ask for regeneration on the originating
   installation, without importing their config/evidence sections.
4. Give an authorized agent only `analyzed-report.json`, the versioned
   `keiko.support.report-analysis` projection. Read `selection.status/reasons`,
   `analysis.sufficiency`, loss and coverage before asserting that an absence proves anything.
   Integrity is self-consistency; `authenticity` is always `unknown`, including for a completely
   reconstructable report. A sender who can rewrite every checksum can forge self-consistency.
5. Use its ordered timelines, failure clusters, safe frames/causes and available deterministic
   `seed`. `keiko support analyze ./received-report.json --seed` selects the incident correlation
   by default; `--correlation-id` selects another known timeline. `--emit-fixture PATH` prepares
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
incident, 16 MiB decoded events, 64 KiB per event, 20,000 records, and depth 12. Private permissions,
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
unknown identities fail closed rather than using the current schema. Maintain snapshots with
`scripts/generate-support-registry-history.mjs`, from reviewed repository commits only. The
frozen pre-extraction production fixture proves historical reconstruction without restating the
writer's identity formula.

The old CLI bundle/sidecar/config/evidence serializers are retired. Their security invariants now
run through the canonical CLI and file-I/O tests: no secret/environment/UI/file capture, exclusive
private publication, unsafe link/permission refusal, zero hostile-data rendering, complete causal
reconstruction, and honest insufficiency. Generic interruption, mutation races and exact-byte
recovery remain pinned in `keiko-security/src/fs-hardening.test.ts`. The store-fingerprint corruption
pin remains against the owning `collectStoreFingerprints` production entry point; reports do not
open stores merely to add a diagnostic snapshot. Local raw-log analysis helpers remain developer
facilities, not an admission boundary for received files.

Operator scripts remove inclusion flags and the sidecar step, pass a private directory to `--out`
instead of a filename, and read the new versioned machine
envelope (`analysis.timelines`, `analysis.clusters`, `seed`). The release impact is new-additions,
high priority, behavioral, supported from the next release after merge (issue #3534). Existing
published release entries are not changed.
