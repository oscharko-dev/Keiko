# Customer-shape Coding Workbench release qualification

Issue #3594 adds a required macOS qualification job before npm publication in `release.yml`. Run it
locally with:

```bash
npm run qualify:coding-workbench:customer-shape
```

The command builds the current candidate, stages the npm package through the existing installable
smoke producer, and installs it with pinned Yarn 4.9.1 from the local seeded registry into a fresh
project folder. The package's `keiko start` then serves the real UI and BFF. A browser pairs the
Workbench, binds synthetic Git repositories with HTTPS and scp-like non-GitHub origins, selects
**Ask for approval**, and starts a turn. The gateway is a local LiteLLM/vLLM-shaped twin: it rejects streamed
`stream_options` with HTTP 400, then sends `content: null`, a ping comment, and an answer without
usage in the accepted stream after a 35-second upstream delay. The gate requires the answer to be visible and the Activity Log to
contain request validation, the compatibility retry, usage settlement with a closed source and
completion count, and an accepted outcome for the same run and request after terminal delivery.
The sidecar may request a buffered answer even when the provider supports
streaming, so both delivery paths must settle usage. A separate installed run proves that a
governed `keiko_workspace_discover` call completes and its result reaches a visible follow-up
answer. Another run closes the accepted stream after partial text without a finish reason or
`[DONE]`; the browser must show `stream-incomplete` rather than a successful partial reply. A
final run rejects both stream shapes and must show the typed provider failure in the Workbench.
Each failed run must also have an
installed-build diagnostic with frames that `keiko support analyze` can find by request
correlation. The diagnostic links to the run through `parentCorrelationId`;
`coding-sidecar.gateway.turn-failed` records the closed cause and whether its SSE projection was
published in the run timeline. If the sidecar already delivered a terminal failure, the gateway's
additional event is suppressed and the line records `publicationReason: terminal-run`; the browser proof still
requires the failure to be visible. The gate reports duration and no prompt body.

The publication job depends on the successful macOS qualification job, so a red, absent, or timed-out
lane prevents publication. The qualification job installs Chromium; the qualifier provisions pinned
Yarn 4.9.1 through the installable smoke machinery. The separate Ubuntu publication job builds its
own workspace packages before importing the publisher. The lane does not call Azure or
a customer's LiteLLM endpoint, and it does not need a customer repository, credentials, or export.
The same staged package and Yarn machinery are used by `smoke:install`; no second packaging format
is introduced.

The `Coding Workbench customer-shape qualification` workflow also runs this command on macOS 15
for relevant `dev` pull requests. This measures the candidate before a release tag is requested.
It reports closed Git attestation facts for the selected Xcode toolchain and the system Command
Line Tools before the browser run, without printing either executable path.
When the selected Git fails Keiko's ownership or path checks, the runtime may use only the fixed
Command Line Tools Git after it passes the same checks. The Activity Log records which attested
candidate was used, without recording its path.
On failure, the qualifier prints a bounded summary of registered Activity Log operations, reviewed
start or handshake codes, and local twin request flags before deleting its temporary state. Values
outside the reviewed vocabularies are redacted. An empty request list means the turn did not reach
the local LiteLLM twin; inspect the runtime start or handshake code before changing the gateway.
