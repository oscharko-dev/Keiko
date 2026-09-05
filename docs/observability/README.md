# Observability: the server activity log

Keiko writes one operator-readable activity log for every local install, unconditionally — there
is no environment variable that turns it off, only one (`KEIKO_LOG_LEVEL`) that turns its volume
down. This page documents the log itself, how its lines join together across a request's
lifecycle, and how to read it with `keiko support export` / `keiko support analyze`. It is the
consumer-facing counterpart to [ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md),
which records the design decisions behind everything described here.

## File location, rotation, retention

The log lives at `<stateDir>/logs/server.log` — `<stateDir>` is `./.keiko` by default, or wherever
`--state-dir` / `KEIKO_STATE_DIR` points. It is JSON Lines: one `JSON.stringify`-serialized object
per line, written synchronously so that the last line on disk before a hang or a crash is the last
line the process actually reached.

Rotation is day-based, keyed to the UTC calendar day, and **hard-link-atomic across processes**:
at the first write after midnight UTC, the process links the finished day's file to
`server-<YYYY-MM-DD>.log` (`link(2)`, which fails closed with `EEXIST` if a peer process already
made that link) before starting a fresh `server.log`. This is why two Keiko processes sharing a
state directory never race each other into overwriting a finished day's archive — a plain
`rename` would lose that race; a hard link cannot. On a filesystem with no hard-link support
(FAT/exFAT removable media), rotation falls back to a guarded rename instead of never rotating.

Retention is a **rolling 7-day window** of rotated `server-<date>.log` files, pruned oldest-first
on every rotation. The current, not-yet-rotated `server.log` is never counted against or dropped
by retention.

## Log level

`KEIKO_LOG_LEVEL` gates volume, not content: an event below the configured threshold returns
before any string or JSON work happens at all, so a quiet level is also the cheap one. Accepted
values are `debug`, `info` (the default when unset or unrecognized), `warn`, and `error`, plus the
threshold-only `silent` to turn the log off entirely. A handful of common aliases are also
accepted (`trace`/`verbose` → `debug`, `warning` → `warn`, `fatal`/`critical` → `error`,
`off`/`none` → `silent`); a typo falls back to `info` rather than crashing the process or silently
disabling the log the operator is trying to read.

## The op catalog

Every log line's `op` field is a value from a closed, generated vocabulary — never a free string
an operator has to guess the meaning of. The checked-in catalog,
[`op-catalog.generated.json`](op-catalog.generated.json), lists every `op` this build can emit
alongside its `category`, owning package, and call site, and is regenerated and drift-tested by
`scripts/generate-op-catalog.mjs` whenever a new operation is added. A `<dynamic>` entry marks a
forwarding call site that receives its `op` value from a caller rather than minting its own; the
catalog also lists that caller's own literal separately, so the vocabulary is always traceable to
where it actually originates.

## Redaction scope, stated honestly

Every field this log can carry passes through `redactLogFields` before it reaches disk. That
guarantee has an honest, stated limit, reused verbatim from the redaction test suite's own header
(`packages/keiko-server/src/observability/log-redaction.test.ts`) rather than restated in looser
words here:

> Scope, stated honestly: the guarantee is over CONTENT SHAPES (prose, markup/JSON, control
> characters, credential formats, filesystem paths, over-long strings), not over arbitrary short
> opaque tokens. A caller who base64-encodes a body into a 20-character identifier defeats any
> redactor, and no policy that still admits `errorCode: "INVALID_CAPSULE_PLAN"` can distinguish
> the two. Everything a real body, prompt, document or key actually looks like is covered.

Nothing in this log is ever a prompt, a response, document text, a secret, or an absolute
filesystem path that could carry an operator's username — only counts, closed-vocabulary labels,
hashes, and shapes.

## Joining lines across a request's lifecycle

Every `ServerLogEvent` line carries `pid`, `instanceId` (8 hex characters, minted once per process
start), and a process-wide, monotonically allocated `seq`. Together, `(pid, instanceId, seq)` give
a **total, gap-free order within one process lifetime** — but that is the full extent of the
ordering guarantee. There is no true cross-process global order: two different process lifetimes
each count `seq` from their own start, so a `seq` value from one process is not orderable against
the same `seq` value from another by the tuple alone. The wall-clock `ts` field is a best-effort
tiebreak hint only, never a guarantee, and should not be relied on to order lines across processes.

Cross-process (and cross-request) causality is instead established through two id fields:

- **`correlationId`** ties every line belonging to one logical operation together — one chat turn,
  one indexing job, one gateway call, one WebSocket session — across the UI, the BFF, the model
  gateway, and back.
- **`parentCorrelationId`** is set on a background operation (a harness run, a workflow event)
  spawned from a request whose id is already known, pointing back at the spawning request's
  `correlationId`. A top-level request has no parent. This is the mechanism for walking from "what
  the customer directly triggered" to "what that triggered in turn" — `correlationId` alone names
  only the current operation, not its ancestry.

Read the log in this order for one failure:

1. Find the `correlationId` of the request the customer reported (the UI shows it, or the server's
   error response echoes it back in `X-Keiko-Correlation-Id` / `error.correlationId`).
2. Collect every line sharing that `correlationId` — this is one process lifetime's worth of a
   single logical operation, so `(pid, instanceId, seq)` orders them exactly.
3. Follow any `parentCorrelationId` you find back to the request that spawned it, and repeat.
4. For an error, read `errorKind` for the closed-vocabulary classification, and (when present)
   `extra.frames` / `extra.causeChain` for the dist-anchored Keiko-code stack — see
   [`reproduction-harness.md`](reproduction-harness.md) for how to read a frame against the exact
   product version that produced it.
5. For process-level events (`process.started`, `process.heartbeat`, `process.exiting`), which
   carry no `correlationId` and so never belong to a per-correlation timeline, read
   `keiko support analyze`'s `processes[]` summary instead, keyed by `(pid, instanceId)`.

## Worked example: `keiko support analyze`

Given a raw `server.log` (or a full support bundle from `keiko support export` — the analyzer
auto-detects either), reconstruct the timeline for one correlation id:

```bash
keiko support analyze .keiko/logs/server.log --correlation-id 3f9a2b7c-1e44-4d21-9a02-6b1c9e0a5f31
```

```text
correlationId=3f9a2b7c-1e44-4d21-9a02-6b1c9e0a5f31 lines=4 durationMs=812
  2026-08-21T09:14:02.118Z 118 info http request [812ms]
  2026-08-21T09:14:02.204Z 119 info gateway gateway.chat.started
  2026-08-21T09:14:02.887Z 121 error gateway gateway.chat.failed [GATEWAY_RATE_LIMIT] [683ms]
  2026-08-21T09:14:02.901Z 122 info http request [812ms]
```

Each line orders by `seq` (the second column) within the process lifetime that wrote it — never
by file position, for a v2 line. Reading top to bottom: the request line opens the timeline, the
gateway call starts, the gateway call fails with a rate limit, and the request line's own record
closes it out. `--json` emits the same reconstruction as a machine-readable `LogTimeline`
(`lines`, `firstTs`, `lastTs`, `durationMs`, `errorKinds`, and — when any line in the timeline
carried them — `frames`) instead of the human-rendered form above; omitting `--correlation-id`
prints every timeline found in the file, plus the file-wide `processes[]`/`legacyLineCount`/
`warnings` summary described above.

A line successfully parsed but missing the full `(pid, instanceId, seq)` triple is a **legacy
line** — one written before this envelope shipped, still inside the log's 7-day retention window.
It is never dropped or misordered; it is ordered by its own file position, counted in
`legacyLineCount`, and named in exactly one `warnings[]` entry when that count is nonzero. Treat
that warning as an instruction to read the file position ordering with less confidence for those
specific lines, not as a defect.

Epic #3384's repository-delivery journey (intake, mutation authority, verified commit, push, draft
PR, CI readiness, description generation/apply, and the recorded journey outcome) reconstructs on
the same per-correlation timeline as every other operation — `git.delivery.*`,
`git.pr-description`/`git.pr-description.receipt`, `git.journey-observation`/
`git.journey-outcome.recorded`, `coding-context.github*` and `git-change.chat.*` lines simply
appear on it like any other line, and `--clusters` groups them the same way. `keiko support
analyze --seed --correlation-id <id>` additionally assembles an `issueToPrJourney` view onto the
`ReproductionSeed`: one step per recognised line, tagged with a closed `phase`
(`intake`/`authority`/`commit`/`push`/`pr`/`readiness`/`description`/`outcome`) and carrying the
emitter's own `status`/`reason` and the digest/id fields (`runId`, `headSha`, `evidenceRef`,
`snapshotDigest`, …) a replay needs — every value copied verbatim off the producer's own
closed-vocabulary `extra`, never invented. Each step's fields are read back through the SAME
`redactLogFields` choke point the activity-log sink itself writes through; a line whose `extra`
carries a body-bearing value under an otherwise-innocuous name is reported by field name under that
step's `redactionViolations` and withheld from the seed instead of rendered, and a `redactionVerified:
false` step (no redactor supplied) carries no content fields at all rather than trusting an
unverified line.

## See also

- [ADR-0173](../adr/ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md) — the full
  design record: why each envelope field is reserved, the ordering guarantee's exact limit, the
  redaction escape hatches, and the support-bundle format.
- [`reproduction-harness.md`](reproduction-harness.md) — turning one correlation id's evidence into
  a red-then-green regression test.
- [Troubleshooting guide](../troubleshooting/README.md) — the `logs/server.log` row in the
  "Log locations and debug mode" table, alongside the other operator-facing log files.
