# ADR-0184: Repository credential relay for Coding runs

## Status

Accepted (2026-11-22, owner priority recorded on #4491 and #4522: macOS first, Windows parity after
its project commands run).

Amends:

- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md): the native build-settings
  admission (#4271) no longer leaves a run without dependency access. Its credential rule is
  unchanged: the run never holds a repository credential.
- #4522: the planned host-side npm bootstrap is replaced by this relay. ADR-0043 D17 stays as it is
  for the governed verifier.

Builds on [ADR-0181](ADR-0181-shared-managed-mcp-host.md) and its MCP credential relay (#3903 AC3).
On Windows it relies on the loopback relay of [ADR-0043](ADR-0043-enforced-execution-isolation.md)
D21.

## Context

A Coding run checks its own change by building and testing the project in its shell. For a Maven
or npm project whose dependencies come from an internal repository that requires a login, this
fails in every mode:

- **Credentials.** The build-settings admission copies the person's `~/.m2/settings.xml` without
  `servers`, and the npm user config without its tokens. That is intended: a model must never be
  able to read or send a repository password.
- **Below Full access.** The run has no network. Maven runs offline against the person's read-only
  cache, so any artifact the person never built is missing.
- **At Full access.** The run starts from an empty private Maven repository. The mirror answers
  `401`, because the run has no credentials.

A run that cannot build cannot verify. The verification gate then correctly refuses `succeeded`,
but the run has no way to reach a verified result. For projects behind an internal repository,
which is the usual case in a company, the Coding Workbench cannot do its job.

`docs/qa/opencode-capability-parity.md` already recorded the missing piece: "a registry proxy for
the native shell is not yet implemented".

## Decision

### D1 — One relay, generalized from the MCP credential relay

The server serves a repository credential relay on the run's attested loopback origin, under
`/api/coding-sidecar/repository/<relayId>/<path>`. The router takes the rest of the path as one
`*path` segment. The relay shares its capability store with the MCP credential relay
(`relay/relayCapabilityStore.ts`): one capability per run and per repository, a random relay id, the
capability stored only as a hash and compared in constant time, revoked when the run ends. A run
presents the capability as the Basic password (Maven) or the Bearer token (npm). There is no second
mechanism. The route needs no CSRF exemption: only `GET` and `HEAD` are routed, and the relay
authenticates the capability itself.

### D2 — Targets and credentials come from the person, never from the project or the run

- **Targets.** A relay target is a mirror, or a repository or plugin repository of an active profile,
  from the person's own user-level `~/.m2/settings.xml`, or a registry from the person's own
  user-level `~/.npmrc`. A workspace `.mvn` directory, a project `.npmrc`, an environment variable
  of the run or a request can neither add a target nor change one. Keiko's own origin is never a
  target; loopback spellings of its port count as its origin. Configured loopback and private-network
  targets are allowed, because an internal repository is exactly that.
- **No interpolation in a URL.** A repository URL is taken as written. A `${…}` in a Maven
  `<url>` or an npm `registry` value is refused (`url-interpolated`): the host decides where a
  credential goes.
- **Credentials.** Keiko resolves them in the server: `servers` entries matched by id, `${env.…}`
  (npm: `${NAME}`) in the credential fields only, Maven-encrypted passwords decrypted with the
  person's `settings-security.xml`, and the npm auth keys scoped to a registry (`_authToken`,
  `_auth`, `username` with `_password`). Environment reads use a filtered copy of Keiko's
  environment: names starting with `KEIKO_` and the names of model providers and gateways are
  never visible to a resolver. The resolved credential stays in the relay; the run's settings carry
  the capability instead.
- **Minimum length.** A credential shorter than eight characters is not bound
  (`credential-too-short`): it could not be told apart from ordinary bytes of an artifact, so the
  relay could not keep D4's promise for it.

### D3 — Requests are reads in the repository layout

- **Methods.** `GET` and `HEAD` only. Nothing is published, and a query string is refused.
- **Paths.** The path must match the layout grammar of its ecosystem: Maven artifacts, POMs,
  checksums, signatures and metadata; npm packuments and tarballs. Nothing is decoded or
  normalised, and a dot segment, an encoded slash outside a scoped npm name, an absolute URL or a
  directory request is refused. The path kind decides how the body is read: POMs, metadata, module
  files and checksums are text; jars and other files are binary; packuments are text; tarballs are
  binary.
- **Redirects.** At most three. A same-origin redirect keeps the credential. A cross-origin
  redirect is followed only to `https`, never to Keiko's own origin, and without the credential.
  A public upstream may only be redirected to public addresses.
- **Responses.** A compressed answer (`Content-Encoding`) is refused, because its content cannot be
  scanned (`content-encoding-refused`). The relay never forwards an upstream error body or status
  text: an upstream `401`, `403` or `5xx` is answered with Keiko's own closed refusal.
- **Budgets.** Each binding has a request count and a byte budget, and each response has a byte cap.

### D4 — Responses never return a credential

A response that contains a credential form is refused before the run reads the bytes that spell it.
Text and JSON are read whole and scanned in every spelling a parser restores. A binary stream goes
through a rolling window that holds back the last `longest form - 1` bytes. A match fails closed
(`credential-in-response`); the relay never rewrites an artifact. npm packuments are rewritten so
that every tarball URL under the upstream registry points at the relay; tarball URLs on other hosts
are left unchanged.

### D5 — The run binding

For each resolved target the build-settings admission (`nativeBuildSettings`,
`nativeRepositoryRelayBinding`) binds a relay capability for the run, with the run's attested
loopback origin as the base (the gateway URL's origin), and writes the run's private settings. It
reads only the person's user-level files and writes no secret: the real credential is never written
to a file of the run.

- **Maven.** The mirror, repository and plugin repository URLs that were bound are rewritten to
  their relay URLs, one binding per repository id. A `<server>` per id carries the fixed user name
  `keiko-relay` and the capability as its password. A second URL under the same id is not bound
  (`id-ambiguous`), and a repository without an id cannot carry a `<server>` (`id-missing`). Maven
  runs online (`offline=false`) in every mode when at least one target is bound, because it reaches
  the relay and nothing else. Every `<proxy>` gains `127.0.0.1|localhost` in `nonProxyHosts`. Maven
  sends its first request with the Basic credential: the relay on a relayed Host refuses an
  unauthenticated first request before it could challenge (Windows), so every platform sets
  `aether.transport.http.preemptiveAuth=true` (Maven 3.10, resolver 2) and
  `aether.connector.http.preemptiveAuth=true` (Maven 3.9, resolver 1.9) in the run's
  `JAVA_TOOL_OPTIONS`. Verified against Maven 3.10.0: with only the connector property the first
  request carried no `Authorization`; with the transport property it did.
- **Cache.** Unchanged by the relay. Below Full access the person's read-only Maven cache stays
  chained behind the run's writable repository (`maven.repo.local.tail`) and answers before the
  relay is asked; at Full access the run has its private repository only.
- **npm.** `registry` and each `@scope:registry` point at their relay URLs, and
  `//127.0.0.1:<port>/api/coding-sidecar/repository/<id>/:_authToken=<capability>` carries the
  capability under the exact host spelling npm derives from the relay URL. `audit=false`, because
  the relay refuses a POST. `NO_PROXY` and `no_proxy` gain `127.0.0.1,localhost` for the run, extending
  the inherited list.
- **Nothing resolved.** The run's settings, environment and Java properties stay exactly as ADR-0137
  describes.
- **Release.** `releaseRun` revokes every binding of a run when the run is disposed; no capability
  outlives its run.
- **Activity Log.** The `coding-runtime.native-build-settings.admitted` line gains
  `relayMavenBoundCount`, `relayNpmBoundCount`, `relayRefusedCount` and `relayRefusalReasons`, a closed
  list: the resolution refusals plus `bind-refused`, `id-missing` and `id-ambiguous`.

### D6 — Modes

The relay is available in every mode. It only reads, only reaches repositories the person
configured, and never hands out a credential. Whether a build command may run is still decided by
the mode's command rule. Below Full access the run gets dependency access without internet access.

### D7 — Platforms

- **macOS.** The native shell reaches the relay on the attested loopback origin.
- **Windows.** The relay is server code on the attested origin that the D21 relay already forwards.
  The host-admission allowlist of runtime routes includes the relay prefix, with its capability
  required. It takes effect for a Windows run once project commands run there (#4493, #4496).
- **Linux.** The community-tier rule of ADR-0183 applies: the server code is the same, and
  qualification is for macOS and Windows.

### D8 — Activity Log

The relay (`coding-runtime.repository-relay`) records its binding, every refusal and failure, and
one settled summary per binding when its run is released. The lines carry the ecosystem, method,
closed outcome and reason, the upstream status class, counts, bytes and durations. They never carry
a URL, host, path, artifact coordinate, username or credential. A successful artifact request is
not logged one by one; the settled summary counts it.

## Limits

- **Credential in a served file.** A password of eight or nine characters that also occurs in a
  file the repository serves is refused as `credential-in-response`. The relay fails closed rather
  than let a short, common value through. Use a repository token instead of such a password.
- **Binary content.** Binary bodies are scanned for the raw and base64 forms only. Content inside a
  compressed archive cannot be scanned, so a jar or tarball that carries the credential in
  compressed form passes.
- **Coordinate channel.** A run can encode data into the artifact coordinates it requests, and that
  data reaches the internal repository. If the repository proxies a public one, it travels further.
  The grammar and the budgets keep this channel narrow; they do not close it.
- **Full access.** A run at Full access can read every artifact the person may read and also has
  the internet. That is the same reach it already has over the project's source.
- **Active profiles only.** Repositories of a profile that is neither active by default nor named
  in `activeProfiles` are not bound. A profile the run activates by `-P` reaches its real URL
  without a credential.
- **Gradle.** Gradle names its repositories in build scripts. It is not covered yet; an init script
  in the private Gradle home can bind it to the same relay later.
- **Git hosts.** Check runs, reviews and comments on the Git host are not covered.

## Alternatives considered

- **Give the run the password.** Rejected: the model could read and send it.
- **Chain the person's cache at Full access too.** Rejected as the fix: it only helps with an
  artifact the person has already built, and it opens the same reach as D6 for less benefit.
- **Resolve dependencies before the run.** Rejected for Maven: plugins and their providers are
  resolved during the build, so a pre-resolution cannot foresee them reliably.
- **A general HTTP proxy for the run.** Rejected: it would open arbitrary egress.

## Consequences

- A Maven or npm project behind an authenticated internal repository builds and tests in its run,
  in every mode, without the password entering the run.
- The #4492 acceptance task carries a Maven case behind a login, in all three modes, plus a wrong
  password case; each case also scans the run's state, private home, task workspace and Activity Log
  lines for the password and its base64 forms.
- A hermetic test drives the real Maven and the real npm against the relay with the settings the
  binding writes, including the negative case of a revoked binding.
