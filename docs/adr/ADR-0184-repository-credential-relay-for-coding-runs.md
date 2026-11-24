# ADR-0184: Repository credential relay for Coding runs

## Status

Accepted (2026-11-22, owner priority recorded on #4491 and #4522: macOS first, Windows parity after
its project commands run).

Amends:

- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md): the native build-settings
  admission (#4271) no longer leaves a run without dependency access. Its credential rule is
  unchanged: the run never holds a repository credential that Keiko read from a file. A credential
  Keiko resolves from its own process environment is the one limit on macOS (D2).
- #4522: the planned host-side npm bootstrap is replaced by this relay. ADR-0043 D17 stays as it is
  for the governed verifier.
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) D1 and
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md) D1:
  their mode descriptions name this relay as the one path to the person's own repositories below
  Full access, beside the read-only Maven cache (owner decision 2026-11-22, D6). The policy matrix
  is unchanged.

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
- **An environment credential is as private as Keiko's exec environment.** `${env.NAME}` (Maven)
  and `${NAME}` (npm) are read from Keiko's own process environment. A variable the person exported
  in the shell that starts Keiko sits in the server's exec environment, and Node cannot scrub that
  copy. On macOS a run's shell can read it with `sysctl(KERN_PROCARGS2)`, which the kernel answers
  for any process of the same user in every mode and no Seatbelt rule gates
  ([ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) D10; the kernel rule belongs to
  #4521). The qualification case "pins the KERN_PROCARGS2 limit" in
  `opencodeNativeQualification.real.test.ts` records it: a Node process started with a credential
  shaped variable shows it to the shell of a real native run in Ask for approval, Supervised
  workspace and Full access. The remedy is to keep the credential in `~/.m2/settings.xml` (plain
  or Maven-encrypted) or in the user `~/.npmrc` and never to export it into the environment that
  starts Keiko. Keiko reads those files itself and never writes the credential into a file or
  variable of the run (D5), and the run cannot read them: the native read boundary of
  `runtime-gateway.test.ts` ("native profile: denies a workspace .env, an external canary …")
  proves on the real kernel that a run's interpreter and shell read neither the person's
  `~/.npmrc` nor `~/.m2/settings.xml`, and no `.npmrc` anywhere, while the same reads succeed
  without the boundary.
- **Minimum length.** A credential shorter than eight characters is not bound
  (`credential-too-short`): it could not be told apart from ordinary bytes of an artifact, so the
  relay could not keep D4's promise for it.

### D3 — Requests are reads in the repository layout

- **Methods.** `GET` and `HEAD` only. Nothing is published, and a query string is refused.
- **Paths.** The path must match the layout grammar of its ecosystem: Maven artifacts, POMs,
  checksums, signatures and metadata; npm packuments and tarballs. Nothing is decoded or
  normalised, and a dot segment, an encoded slash outside a scoped npm name, an absolute URL or a
  directory request is refused. An npm tarball path names its package exactly: everything before
  the `-` directory is the name, so `pkg/extra/-/pkg-1.0.0.tgz` is refused. An npm tarball may also
  arrive under the registry's own base path (`repository/npm-group/pkg/-/pkg-1.0.0.tgz` for a
  registry at `.../repository/npm-group/`): that is how npm sends a tarball its lockfile pins once
  `replace-registry-host` moves the pinned URL onto the relay, keeping the URL's path (#4491). Only a
  tarball shape directly under that base path is admitted, relative to the base. The path kind
  decides how the body is read: POMs, metadata, module files and checksums are text; jars and other
  files are binary; packuments are text; tarballs are binary.
- **Redirects.** At most three. A same-origin redirect keeps the credential. A cross-origin
  redirect is followed only to `https`, never to Keiko's own origin, and without the credential.
  The network rule: a public upstream may be redirected only to public addresses, a private one
  only from a private upstream, and loopback only from a loopback upstream
  (`redirect-network-refused`).
- **Own origin.** A binding names Keiko's own origin, which must be an `http://` loopback origin
  with an explicit port (`own-origin-invalid` otherwise). The run binding passes the gateway URL's
  origin, which is the attested one.
- **Responses.** A compressed answer (`Content-Encoding`) is refused, because its content cannot be
  scanned (`content-encoding-refused`). The relay never forwards an upstream error body or status
  text: an upstream `401`, `403` or `5xx` is answered with Keiko's own closed refusal.
- **Budgets and caps.** Each binding has a request count and a byte budget, and each response has
  a byte cap. At most 16 requests per binding and 32 per process are in flight; a request beyond
  that is answered `503` with `Retry-After: 1` (`relay-busy`), which Maven and npm retry. Their
  default parallelism (Maven resolver threads, npm sockets) stays below the per-binding cap: the
  real-client test sees no `relay-busy`. A stalled client (`client-stalled`) and an upstream that
  does not answer in time (`upstream-timeout`) end the exchange with a closed refusal.

### D4 — Responses never return a credential

A response that contains a credential form is refused before the run reads the bytes that spell it.
Text and JSON are read whole and scanned in every spelling a parser restores. A binary stream goes
through a rolling window that holds back the last `longest form - 1` bytes. A match fails closed
(`credential-in-response`); the relay never rewrites an artifact. npm packuments are rewritten so
that every tarball URL under the upstream registry points at the relay base the run was given, on
the bound loopback origin; tarball URLs on other hosts are left unchanged. A binding whose run's npm
moves the tarballs onto the relay itself (D5, `rewritePackumentTarballs: false`) gets the packument
unchanged, so a lockfile the run writes pins the person's registry, never the relay (#4491). "Under" is decided on
parsed URLs, not on the literal text: scheme and host in any case and an explicit default port name
the same registry, the path stays case-sensitive, and dot segments are resolved first, so a tarball
URL cannot climb out of the registry path. The request's `Host`
never chooses that base: a proxy in front of Keiko rewrites it (the development runner names its
own backend port), and npm sends the run's capability only to the origin its configuration names,
so a tarball moved onto another port would be fetched without it (#4530).

### D5 — The run binding

For each resolved target the build-settings admission (`nativeBuildSettings`,
`nativeRepositoryRelayBinding`) binds a relay capability for the run, with the run's attested
loopback origin as the base (the gateway URL's origin), and writes the run's private settings. It
reads only the person's user-level files and writes no secret: the real credential is never written
to a file of the run.

- **Maven.** The mirror, repository and plugin repository URLs that were bound are rewritten to
  their relay URLs, one binding per repository id. A `<server>` per id carries the fixed user name
  `keiko-relay` and the capability as its password. An id that two repositories declare with
  different URLs is bound for none of them (`id-ambiguous`, once per distinct URL): the shared
  `<server>` would send the capability to whichever host Maven asked. A repository without an id
  cannot carry a `<server>` (`id-missing`). The rewrite reads ids and URLs with the XML reader's own
  decoder (`x&#121;z` is `xyz` for both), and the rewritten settings are then read back the way Maven
  reads them: a bound id that still names an element not on its relay URL, in any mirror or any
  profile, active or not, is revoked and its elements restored (`id-ambiguous` when that element names
  another repository, `rewrite-missed` when the rewrite did not recognise an element the resolution
  did), so no `<server>` is emitted for it. A repository of an inactive profile is not relayed and is
  counted as `profile-inactive`, so an authentication failure for it is explainable. Maven
  runs online (`offline=false`) in every mode when at least one target is bound, because it reaches
  the relay and nothing else. Every `<proxy>` gains `127.0.0.1|localhost` in `nonProxyHosts`. Maven
  sends its first request with the Basic credential: the relay on a relayed Host refuses an
  unauthenticated first request before it could challenge (Windows), so every platform sets
  `aether.transport.http.preemptiveAuth=true` (Maven 3.10, resolver 2) and
  `aether.connector.http.preemptiveAuth=true` (Maven 3.9, resolver 1.9) in the run's
  `JAVA_TOOL_OPTIONS`. Verified against Maven 3.10.0: with only the connector property the first
  request carried no `Authorization`; with the transport property it did. Verified against Maven
  3.9.9 (#4530): without the connector property its first request carried no `Authorization`; with
  it every request did. The real-client test names the Maven it proves
  (`KEIKO_REPOSITORY_RELAY_MAVEN_VERSION`) and fails on any other.
- **Cache.** Unchanged by the relay. Below Full access the person's read-only Maven cache stays
  chained behind the run's writable repository (`maven.repo.local.tail`) and answers before the
  relay is asked; at Full access the run has its private repository only.
- **npm.** `registry` and each `@scope:registry` point at their relay URLs, and
  `//127.0.0.1:<port>/api/coding-sidecar/repository/<id>/:_authToken=<capability>` carries the
  capability under the exact host spelling npm derives from the relay URL. `audit=false`, because
  the relay refuses a POST, and `update-notifier=false`, because npm's update check reads npm's own
  packument (tens of megabytes) through the relay from the person's registry on every run (#4491).
  **Tarballs (#4491).** npm records in a lockfile the tarball URL it fetched. A packument the
  relay rewrote therefore made a lockfile the run wrote pin Keiko's relay, whose address and
  binding last one run: a later run, a colleague and CI could not install from it. A lockfile
  written outside the run pins each tarball on the person's registry, which npm by default moves
  onto the configured registry only from `registry.npmjs.org`, so it was fetched from there
  directly: without the credential, and below Full access without a network. npm moves a tarball
  only onto the default registry, so when the default `registry` is bound and every bound npm
  registry is that one URL (a scope naming the same Nexus group included), the run's npm routes the
  tarballs itself: each binding passes packuments unchanged, and the config carries
  `replace-registry-host`, `always` below Full access, where the run has no other way out (a git or
  URL dependency fails there anyway), and the default registry's host name at Full access, so a
  git, URL or `registry.npmjs.org` tarball keeps its own host, which Full access may reach. npm's
  own default stays for a public default registry. A scope bound to another URL, or a scope without
  a bound default registry, keeps the relay's packument rewrite and npm's default for every registry
  of the run, as before: there a lockfile the run writes pins the relay, and one pinned on the
  person's registry is not routed. The routing covers npm's install path (`npm install`, `npm ci`,
  `npx`). For `npm pack <package>`, `npm cache add` and an install from a lockfile written with
  `omit-lockfile-registry-resolved`, npm's own fetcher applies the setting instead: it moves the
  tarball onto the relay's origin without the relay's path, which fails, below Full access and at
  Full access for a registry without a port, and fetches it from the person's registry without the
  credential at Full access for a registry that names a port.
  npm reads its environment before its user config, and npm exports a configured `registry` as
  `npm_config_registry` to every process it starts, so a Keiko started through `npx` or `npm run`
  hands the person's registry to the run (the native profile inherits that name, ADR-0137): with
  the default registry bound, an inherited name is replaced by the relay in both spellings, and the
  run's npm never reaches that registry around the relay. A run that inherits no name gets none, so
  npm's own precedence stands and a project `.npmrc` keeps outranking the run's user config. With
  the default registry not bound, an inherited name passes unchanged: it carries no credential, the
  run is offline below Full access, and at Full access the registry refuses the unauthenticated
  request.
  `NO_PROXY` and `no_proxy` gain `127.0.0.1,localhost` for the run,
  extending the inherited list.
  The runtime's environment carries `npm_config_offline=true` below Full access, and npm reads the
  environment before its user config, so the config alone would leave a shell's `npm install` offline.
  When at least one npm target is bound, the run's environment therefore also carries the marker
  `KEIKO_NATIVE_NPM_RELAY=bound`, and the generated native policy plugin lifts `npm_config_offline`
  from the environment of a shell it starts at every mode; without a bound npm target a shell below
  Full access stays offline. The marker never reaches a shell (the plugin's `KEIKO_` strip removes
  it), and the runtime's own environment keeps `npm_config_offline=true`, so its package manager
  (plugin dependencies, formatter installs) stays offline below Full access. The shell reaches only
  loopback below Full access, so the relay is the one registry an install can reach.
- **Nothing resolved.** The run's settings, environment and Java properties stay exactly as ADR-0137
  describes.
- **Release.** `releaseRun` revokes every binding of a run when the run is disposed; no capability
  outlives its run. Each binding also carries the run's prepare signal, so a run that is aborted
  revokes its bindings before `releaseRun` is reached, and a binding that the read-back drops is
  revoked at once (`RepositoryCredentialRelay.revoke`).
- **The person's Maven files stay out of reach.** The run never writes or reads the person's
  `~/.m2/settings.xml` or `~/.m2/settings-security.xml`: the native profile's write allowlist is the
  workspace and the run's private state, and the read allowlist names only the read-only cache and
  wrapper distributions of `~/.m2` (`native-maven-settings-protection.test.ts` pins both).
- **Activity Log.** The `coding-runtime.native-build-settings.admitted` line gains
  `relayMavenBoundCount`, `relayNpmBoundCount`, `relayRefusedCount` and `relayRefusalReasons`, a closed
  list: the resolution refusals (including the informational `profile-inactive`) plus
  `bind-refused`, `id-missing`, `id-ambiguous` and `rewrite-missed`, and `relayNpmTarballRouting`
  (`always`, `registry-host`, `npm-default` or `relay-url`), how the run's npm reaches its
  registries' tarballs, and `relayNpmRegistryEnvironment` (`relay`, `inherited` or `none`), how
  the run's environment names npm's registry.

### D6 — Modes

The relay is available in every mode. It only reads, only reaches repositories the person
configured, and never hands out a credential. Whether a build command may run is still decided by
the mode's command rule; the relay read itself needs no approval. Below Full access the run gets
dependency access without a network route of its own: it reaches only Keiko's loopback origin, and
Keiko reads from the configured repository.

### D7 — Platforms

- **macOS.** The native shell reaches the relay on the attested loopback origin. Below Full access
  every JVM of the run gets `java.net.preferIPv4Stack=true` in its `JAVA_TOOL_OPTIONS` when the
  origin is `127.0.0.1` (#4530): macOS 15.8 refuses a JVM's default dual-stack socket to
  `127.0.0.1` under the loopback-only Seatbelt rule ("Operation not permitted"), while Node.js,
  curl and the same JVM on its IPv4 stack connect. Without the property Maven never reached the
  relay there (no request on the relay, `relayMavenBoundCount` 1). An IPv6 origin (`::1`) keeps
  the default stack. Full access has no loopback-only rule and keeps the default.
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

### D9 — Network class of the first hop, and memory

The credential-bearing first hop keeps the network class of the person's own configured
repository: private and loopback addresses are allowed, and Keiko's own ports and metadata and
link-local addresses are denied. It carries the trust the person gave that host in their own Maven
or npm settings, which is the same exposure as running Maven on the host. A DNS change of that
configured host is outside what the relay can judge. Cross-origin hops are narrowed to the
upstream's class (D3). A text body is buffered whole, up to 64 MiB per answer, and the process
holds at most a 512 MiB text budget; the budget counts buffered bytes once, so peak memory during
the credential scan and a packument rewrite can be a small multiple of it.

### D10 — Private targets and redirects, unlike the MCP credential relay

The MCP credential relay refuses loopback and private-network targets and every redirect
(`mcpCredentialRelay.ts`, `redirect-refused`). This relay admits private and loopback targets (D2,
D9) and up to three redirects (D3). The difference follows from what each relay forwards:

- **What a request can carry.** The MCP relay forwards a request body the model wrote to a tool
  server. Forwarding it to an internal address would give the model a credentialed write path into
  the person's network. This relay forwards no body and no query string, only `GET` and `HEAD` on a
  path in the ecosystem's layout grammar (D3), so it can only read what the configured repository
  serves. The coordinate channel that remains is named under Limits.
- **Where the target lives.** An authenticated Maven or npm repository is usually internal: a
  company repository manager on a private address. Refusing private targets would refuse the case
  this relay exists for. The target still comes only from the person's own settings, never from the
  project or the run (D2), and Keiko's own ports, metadata and link-local addresses stay denied (D9).
- **Redirects.** A repository manager or registry can answer an ordinary read with a redirect, for
  example to the storage that holds the artifact or tarball, and Maven and npm follow it. Refusing
  every redirect would break such builds. The relay follows at most three. It keeps the credential
  only on the same origin, follows a cross-origin redirect only to `https` and without the
  credential, never to Keiko's own origin, and never into a more private network class than the
  configured upstream (D3). Following a redirect in the MCP relay could replay a model-written body
  to a location the operator never registered, so it refuses them.

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
  in `activeProfiles` are not bound; each is counted as `profile-inactive`. A profile the run
  activates by `-P` reaches its real URL without a credential, and an inactive-profile repository that
  shares an id with a bound one makes that id unrelayed (`id-ambiguous`), never a credential for the
  other host.
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
  in every mode, without a password from the person's settings files entering the run (D2 names the
  limit for an environment credential on macOS).
- The #4492 acceptance task carries a Maven case behind a login, in all three modes, plus a wrong
  password case; each case also scans the run's state, private home, task workspace and Activity Log
  lines for the password and its base64 forms.
- A hermetic test drives the real Maven and the real npm against the relay with the settings the
  binding writes, including the negative case of a revoked binding.
