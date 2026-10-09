# Historical decoder snapshot

`decoder-v8-negative-snapshot.ts` is immutable output from `searchText` and
`createWorkspaceIndex` through the existing `WorkspaceIndexStore` save port. The streaming source
was `d219789eddfd2ab5e292e4274f01ba3f8d99f417`; only `binaryDetect.ts` was replaced with its actual
pre-fix source at `59d3bb044d4b342c5448c0d5c883c9877545ecf5` during capture. The decoder was restored
before replay. This distinguishes the historical decoder from the current streaming implementation.

The capture used the same UTF-8 manual, Unicode query, search limits, `memFs` metadata and stable
synthetic file identity as `repoSearch.decoder-upgrade.test.ts`. The old decoder selected a
Windows-1252 declaration inside script text and produced a completed negative match. It scanned
one file without incomplete coverage and saved one record through the production snapshot builder.
No matching, hashing, scoring or snapshot-version formula was reproduced in the fixture.

The regression replays this exact snapshot through the existing load port, with unchanged bytes
and metadata, against the current decoder. Fresh discovery still owns coverage, and the current
decoder's live result is the expected target and physical line. Current-version warm reuse,
changed/deleted files, cancellation and encrypted persistence/corruption controls remain separate.
Do not regenerate the historical snapshot with the current decoder.

With the corrected decoder and the former snapshot version, the final seven regression cases
produced one upgrade failure and six healthy passes. Snapshot version 9 passes all seven unchanged
cases. The same 37 upgrade, streaming-index and request-lifecycle controls pass on macOS and the
documented Node 24.18 Bookworm Linux container; all 80 existing workspace-index controls also pass
on macOS. These are focused producer checks, not final gate or live-model qualification.
