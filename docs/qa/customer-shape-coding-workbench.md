# Customer-shape Coding Workbench release qualification

Issue #3594 adds a required step immediately before npm publication in `release.yml`. Run it
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
usage in the accepted stream. The gate requires the answer to be visible and the Activity Log to
contain request validation, the compatibility retry, and the usage settlement with a closed source
and completion count. The sidecar may request a buffered answer even when the provider supports
streaming, so both delivery paths must settle usage. A second installed run rejects both stream
shapes and must show the typed
provider failure in the Workbench. The failed run must also have a
installed-build diagnostic with frames that `keiko support analyze` can find by request
correlation. The diagnostic links to the run through `parentCorrelationId`;
`coding-sidecar.gateway.turn-failed` records the closed cause and whether its SSE projection was
published in the run timeline. If the sidecar already delivered a terminal failure, the gateway's
additional event is suppressed and the line records `published: false`; the browser proof still
requires the failure to be visible. The gate reports duration and no prompt body.

The lane runs before `Publish package`, so a red, absent, or timed-out lane prevents publication.
The browser and Yarn runtime are installed as release-job prerequisites. It does not call Azure or
a customer's LiteLLM endpoint, and it does not need a customer repository, credentials, or export.
The same staged package and Yarn machinery are used by `smoke:install`; no second packaging format
is introduced.
