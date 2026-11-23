import {
  everyMavenRepositoryElement,
  normalizedMavenRepositoryUrl,
  resolveMavenRepositories,
} from "../repository-relay/mavenRepositoryCredentials.js";
import { resolveNpmRegistries } from "../repository-relay/npmRepositoryCredentials.js";
import {
  repositoryRelayBaseUrl,
  type RepositoryCredentialRelay,
} from "../repository-relay/repositoryCredentialRelay.js";
import { decodeXmlText, parseXmlElements } from "../repository-relay/repositoryRelayXml.js";
import {
  REPOSITORY_REFUSAL_REASONS,
  type RepositoryResolution,
  type ResolvedRepository,
} from "../repository-relay/repositoryRelayTargets.js";

// A native run builds with Maven or npm against the person's internal repository (#4522). The
// person's credential for it lives in a file the run never reads, so Keiko binds the repository to
// its credential relay instead: the build settings of the run name the relay's loopback address and
// carry a capability for this run and this repository, and the relay adds the credential outside the
// run. Everything here runs on the host, before the run starts; the resolved credential is only
// ever handed to the relay and is never written to a file of the run.

/** The user name every relayed Maven repository is given; the password is the run's capability. */
export const RELAY_MAVEN_USERNAME = "keiko-relay";

/** Why a repository was left out of the binding: a resolution refusal, or one of the binding's own. */
export const NATIVE_RELAY_REFUSAL_REASONS = [
  ...REPOSITORY_REFUSAL_REASONS,
  "bind-refused",
  "id-missing",
  "id-ambiguous",
  "rewrite-missed",
] as const;
export type NativeRelayRefusalReason = (typeof NATIVE_RELAY_REFUSAL_REASONS)[number];

export interface NativeRepositoryRelayInput {
  readonly relay: RepositoryCredentialRelay;
  /** The run's attested loopback origin: the gateway's, which the native sandbox admits. */
  readonly origin: string;
  /** The environment `${env.NAME}` placeholders of the person's files are read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface BoundMavenRepository {
  readonly id: string;
  /** The normalised upstream URL, which names the settings elements this binding rewrites. */
  readonly url: string;
  readonly relayId: string;
  readonly capability: string;
}

export interface BoundNpmRegistry {
  /** `registry`, or the lower-cased `@scope:registry` key. */
  readonly key: string;
  /** The normalised upstream URL of the registry. */
  readonly url: string;
  readonly relayId: string;
  readonly capability: string;
}

export interface BoundRepositories {
  readonly maven: readonly BoundMavenRepository[];
  readonly npm: readonly BoundNpmRegistry[];
  /** One entry per repository left out, with duplicates. */
  readonly refusals: readonly NativeRelayRefusalReason[];
}

export interface RepositoryRelaySources {
  readonly runId: string;
  readonly mavenSettings: string | undefined;
  readonly mavenSecurity: string | undefined;
  readonly npmrc: string | undefined;
  /** The run's signal: an aborted run revokes its bindings before `releaseRun` is reached. */
  readonly signal?: AbortSignal | undefined;
}

function expandedRefusals(resolution: RepositoryResolution): NativeRelayRefusalReason[] {
  return Object.entries(resolution.refusals).flatMap(([reason, count]) =>
    Array.from({ length: count }, () => reason as NativeRelayRefusalReason),
  );
}

function bindOne(
  input: NativeRepositoryRelayInput,
  sources: Pick<RepositoryRelaySources, "runId" | "signal">,
  repository: ResolvedRepository,
): { readonly relayId: string; readonly capability: string } | undefined {
  const { runId, signal } = sources;
  return input.relay.bind({
    runId,
    ecosystem: repository.ecosystem,
    upstreamBaseUrl: repository.url,
    ...(repository.credential === undefined ? {} : { credential: repository.credential }),
    secrets: [],
    ownOrigin: input.origin,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The ids that two resolved repositories declare with different URLs. */
function ambiguousIds(repositories: readonly ResolvedRepository[]): ReadonlySet<string> {
  const urls = new Map<string, Set<string>>();
  for (const repository of repositories) {
    if (repository.id === undefined || repository.id === "") continue;
    const known = urls.get(repository.id) ?? new Set<string>();
    known.add(repository.url);
    urls.set(repository.id, known);
  }
  return new Set([...urls].filter(([, known]) => known.size > 1).map(([id]) => id));
}

/**
 * One binding per Maven repository id: a `<server>` is per id, so a second URL cannot share it. An
 * id that two repositories declare with different URLs is bound for none of them: a shared `<server>`
 * would send the capability to whichever host the run's Maven asked, and a capability is for one
 * repository. Each distinct URL of such an id is counted once as `id-ambiguous`.
 */
function bindMaven(
  input: NativeRepositoryRelayInput,
  sources: RepositoryRelaySources,
  resolution: RepositoryResolution,
  refusals: NativeRelayRefusalReason[],
): BoundMavenRepository[] {
  const bound: BoundMavenRepository[] = [];
  const ambiguous = ambiguousIds(resolution.repositories);
  const counted = new Set<string>();
  for (const repository of resolution.repositories) {
    const id = repository.id;
    if (id === undefined || id === "") {
      refusals.push("id-missing");
      continue;
    }
    if (ambiguous.has(id)) {
      const key = JSON.stringify([id, repository.url]);
      if (!counted.has(key)) refusals.push("id-ambiguous");
      counted.add(key);
      continue;
    }
    if (bound.some((entry) => entry.id === id)) continue;
    const binding = bindOne(input, sources, repository);
    if (binding === undefined) refusals.push("bind-refused");
    else bound.push({ id, url: repository.url, ...binding });
  }
  return bound;
}

function npmKey(repository: ResolvedRepository): string {
  return repository.scope === undefined ? "registry" : `${repository.scope}:registry`;
}

function bindNpm(
  input: NativeRepositoryRelayInput,
  sources: RepositoryRelaySources,
  resolution: RepositoryResolution,
  refusals: NativeRelayRefusalReason[],
): BoundNpmRegistry[] {
  const bound: BoundNpmRegistry[] = [];
  for (const repository of resolution.repositories) {
    const binding = bindOne(input, sources, repository);
    if (binding === undefined) refusals.push("bind-refused");
    else bound.push({ key: npmKey(repository), url: repository.url, ...binding });
  }
  return bound;
}

const EMPTY_RESOLUTION: RepositoryResolution = { repositories: [], refusals: {} };

/**
 * Resolves the repositories of the person's own files and binds each one to the relay for this run.
 * A file the caller did not pass (absent, refused or not modelled by the sanitizer) binds nothing.
 */
export function bindRepositoryRelays(
  input: NativeRepositoryRelayInput,
  sources: RepositoryRelaySources,
): BoundRepositories {
  const mavenResolution =
    sources.mavenSettings === undefined
      ? EMPTY_RESOLUTION
      : resolveMavenRepositories(
          sources.mavenSettings,
          sources.mavenSecurity,
          input.env,
          input.origin,
        );
  const npmResolution =
    sources.npmrc === undefined
      ? EMPTY_RESOLUTION
      : resolveNpmRegistries(sources.npmrc, input.env, input.origin);
  const refusals = [...expandedRefusals(mavenResolution), ...expandedRefusals(npmResolution)];
  return {
    maven: bindMaven(input, sources, mavenResolution, refusals),
    npm: bindNpm(input, sources, npmResolution, refusals),
    refusals,
  };
}

// ---- Maven ----------------------------------------------------------------------------------

// An element may carry attributes (`<repository xmlns="...">`); the pattern's name group is closed
// so `<repositories>` never matches. Whatever the pattern misses, `relayMavenSettings` finds out.
const MAVEN_REPOSITORY_ELEMENT =
  /<(mirror|repository|pluginRepository)((?:\s[^<>]*)?)>([\s\S]*?)<\/\1>/gu;
const MAVEN_ID_ELEMENT = /<id(?:\s[^<>]*)?>([^<]*)<\/id>/u;
const MAVEN_URL_ELEMENT = /(<url(?:\s[^<>]*)?>)([^<]*)<\/url>/u;
const PROXY_ELEMENT = /<proxy>([\s\S]*?)<\/proxy>/gu;
const LOOPBACK_NON_PROXY_HOSTS = "127.0.0.1|localhost";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The element's `<url>` pointed at the relay when its id and URL are a bound repository's. Id and
 * URL are decoded by the parser's own decoder, so the rewrite and the resolution that produced the
 * binding read one identity (`x&#121;z` is `xyz` for both).
 */
function relayedElement(
  inner: string,
  bound: readonly BoundMavenRepository[],
  input: NativeRepositoryRelayInput,
): string {
  const id = MAVEN_ID_ELEMENT.exec(inner)?.[1];
  const url = MAVEN_URL_ELEMENT.exec(inner)?.[2];
  if (id === undefined || url === undefined) return inner;
  const decodedId = decodeXmlText(id)?.trim();
  const decodedUrl = decodeXmlText(url)?.trim();
  if (decodedId === undefined || decodedUrl === undefined) return inner;
  const normalized = normalizedMavenRepositoryUrl(decodedUrl, input.origin);
  const match = bound.find((entry) => entry.id === decodedId && entry.url === normalized);
  if (match === undefined) return inner;
  const relayed = escapeXml(repositoryRelayBaseUrl(input.origin, match.relayId));
  return inner.replace(MAVEN_URL_ELEMENT, (_whole, open: string) => `${open}${relayed}</url>`);
}

/** A proxy never carries loopback: the relay answers on it. */
function loopbackNonProxy(inner: string): string {
  const existing = /<nonProxyHosts>([^<]*)<\/nonProxyHosts>/u.exec(inner);
  if (existing === null) {
    return `${inner}<nonProxyHosts>${LOOPBACK_NON_PROXY_HOSTS}</nonProxyHosts>`;
  }
  const hosts = (existing[1] ?? "").trim();
  const next = hosts === "" ? LOOPBACK_NON_PROXY_HOSTS : `${hosts}|${LOOPBACK_NON_PROXY_HOSTS}`;
  return inner.replace(existing[0], () => `<nonProxyHosts>${next}</nonProxyHosts>`);
}

function serverElements(bound: readonly BoundMavenRepository[]): string {
  const servers = bound.map(
    (entry) =>
      `<server><id>${escapeXml(entry.id)}</id><username>${RELAY_MAVEN_USERNAME}</username>` +
      `<password>${entry.capability}</password></server>`,
  );
  return `<servers>\n${servers.join("\n")}\n</servers>\n`;
}

function rewriteMavenSettings(
  sanitizedXml: string,
  bound: readonly BoundMavenRepository[],
  input: NativeRepositoryRelayInput,
): string {
  const rewritten = sanitizedXml
    .replace(
      MAVEN_REPOSITORY_ELEMENT,
      (_block, name: string, attributes: string, inner: string) =>
        `<${name}${attributes}>${relayedElement(inner, bound, input)}</${name}>`,
    )
    .replace(PROXY_ELEMENT, (_block, inner: string) => `<proxy>${loopbackNonProxy(inner)}</proxy>`);
  return rewritten.replace(/<\/settings>\s*$/u, () => `${serverElements(bound)}</settings>\n`);
}

type UnrelayedReason = "id-ambiguous" | "rewrite-missed";

/**
 * Why a bound entry is not safe to carry, read from the settings as the run's Maven will read them:
 * an element of its id that is not on its relay URL would send the entry's capability to that
 * element's host (`id-ambiguous` when it names another repository) or means the rewrite did not
 * recognise an element the resolution did (`rewrite-missed`). Every mirror and profile repository
 * counts, active or not: a profile the person activates on the command line reads the same server.
 */
function unrelayedReason(
  entry: BoundMavenRepository,
  elements: ReturnType<typeof everyMavenRepositoryElement>,
  input: NativeRepositoryRelayInput,
): UnrelayedReason | undefined {
  const relayUrl = repositoryRelayBaseUrl(input.origin, entry.relayId);
  const mine = elements.filter((element) => element.id === entry.id);
  const stray = mine.filter((element) => element.url !== relayUrl);
  if (mine.length > 0 && stray.length === 0) return undefined;
  const foreign = stray.some(
    (element) =>
      element.url === undefined ||
      normalizedMavenRepositoryUrl(element.url, input.origin) !== entry.url,
  );
  return foreign ? "id-ambiguous" : "rewrite-missed";
}

/** The settings of a run with its Maven repositories on the relay, and what that kept or dropped. */
export interface RelayedMavenSettings {
  readonly xml: string;
  /** The entries whose repositories are all on the relay; the only ones that have a `<server>`. */
  readonly bound: readonly BoundMavenRepository[];
  /** One closed reason per entry that was dropped and revoked. */
  readonly dropped: readonly NativeRelayRefusalReason[];
}

/**
 * The sanitized settings with every bound repository's URL on the relay, a `<server>` per id whose
 * password is the run's capability, and loopback exempt from every proxy. The credential the person
 * keeps is not in the output; the capability opens one repository for this run only.
 *
 * The result is read back the way Maven reads it. An entry whose id still names an element that is
 * not on its relay URL is revoked and rewritten away (no `<server>`, the real URL restored for
 * every element), so a capability can never reach a host other than the one it was minted for.
 */
export function relayMavenSettings(
  sanitizedXml: string,
  bound: readonly BoundMavenRepository[],
  input: NativeRepositoryRelayInput,
  dropped: readonly NativeRelayRefusalReason[] = [],
): RelayedMavenSettings {
  const xml = rewriteMavenSettings(sanitizedXml, bound, input);
  const root = parseXmlElements(xml);
  const elements = root === undefined ? [] : everyMavenRepositoryElement(root);
  const verdicts = bound.map((entry) => ({
    entry,
    reason: unrelayedReason(entry, elements, input),
  }));
  const missed = verdicts.filter((verdict) => verdict.reason !== undefined);
  if (missed.length === 0) return { xml, bound, dropped };
  for (const { entry } of missed) input.relay.revoke(entry.relayId);
  return relayMavenSettings(
    sanitizedXml,
    verdicts.filter((verdict) => verdict.reason === undefined).map((verdict) => verdict.entry),
    input,
    [
      ...dropped,
      ...missed.flatMap((verdict) => (verdict.reason === undefined ? [] : [verdict.reason])),
    ],
  );
}

/**
 * The JVM properties that make Maven send its first request with the Basic credential. The relay
 * answers an unauthenticated request without a challenge Maven could answer, so the credential must
 * go with the first request. `aether.transport.http.preemptiveAuth` is Maven 3.10's resolver 2
 * property, `aether.connector.http.preemptiveAuth` Maven 3.9's resolver 1.9 one; each Maven ignores
 * the other.
 */
export const MAVEN_PREEMPTIVE_AUTH_PROPERTIES: Readonly<Record<string, string>> = {
  "aether.transport.http.preemptiveAuth": "true",
  "aether.connector.http.preemptiveAuth": "true",
};

// ---- npm ------------------------------------------------------------------------------------

function npmLineKey(line: string): string {
  const index = line.indexOf("=");
  return (index < 0 ? line : line.slice(0, index)).trim().toLowerCase();
}

/** How npm routes a tarball a lockfile pins: a closed value for the admission line. */
export const NPM_LOCKFILE_ROUTINGS = ["always", "registry-host", "npm-default"] as const;
export type NpmLockfileRouting = (typeof NPM_LOCKFILE_ROUTINGS)[number];

const PUBLIC_NPM_REGISTRY_HOST = "registry.npmjs.org";

/**
 * The `replace-registry-host` a run's npm needs so a tarball its lockfile pins reaches the relay
 * (#4491). npm moves only `registry.npmjs.org` onto the configured registry by default, so a lockfile
 * written against the person's own registry would fetch its tarballs from that registry directly:
 * without the person's credential, and below Full access without a network. Below Full access every
 * pinned tarball moves onto the relay (`always`; the run has no other way out). With Full access only
 * the default registry's host does, so a git or public tarball keeps its own host. Undefined leaves
 * npm's default, as when the default registry is not bound or is the public one.
 */
export function npmLockfileRegistryHost(
  bound: readonly BoundNpmRegistry[],
  networkless: boolean,
): string | undefined {
  const registry = bound.find((entry) => entry.key === "registry");
  if (registry === undefined) return undefined;
  if (networkless) return "always";
  const host = new URL(registry.url).hostname;
  return host === PUBLIC_NPM_REGISTRY_HOST ? undefined : host;
}

export function npmLockfileRouting(host: string | undefined): NpmLockfileRouting {
  if (host === undefined) return "npm-default";
  return host === "always" ? "always" : "registry-host";
}

/**
 * The sanitized `.npmrc` with each bound registry on the relay and the run's capability as its
 * token under the key npm derives from the relay's address. The relay refuses a POST, so the audit
 * request is switched off; npm's update check is too, since it reads npm's own packument (tens of
 * megabytes) through the relay from the person's registry on every run (#4491). `lockfileHost` is
 * the run's `npmLockfileRegistryHost`.
 */
export function relayNpmConfig(
  sanitizedText: string,
  bound: readonly BoundNpmRegistry[],
  input: NativeRepositoryRelayInput,
  lockfileHost?: string,
): string {
  const lockfile = lockfileHost === undefined ? [] : [`replace-registry-host=${lockfileHost}`];
  const replaced = new Set([
    ...bound.map((entry) => entry.key.toLowerCase()),
    "audit",
    "update-notifier",
  ]);
  const kept = sanitizedText
    .split("\n")
    .filter((line) => line.trim() !== "" && !replaced.has(npmLineKey(line)));
  const host = new URL(input.origin).host;
  const relayed = bound.flatMap((entry) => {
    const base = repositoryRelayBaseUrl(input.origin, entry.relayId);
    return [
      `${entry.key}=${base}`,
      `//${host}${new URL(base).pathname}:_authToken=${entry.capability}`,
    ];
  });
  const quiet = ["audit=false", "update-notifier=false"];
  return `${[...kept, ...quiet, ...relayed, ...lockfile].join("\n")}\n`;
}

/** A proxy list the run's tools consult, with loopback added so the relay is never proxied. */
export function withLoopbackNoProxy(inherited: string | undefined): string {
  const names = (inherited ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return [...names, ...["127.0.0.1", "localhost"].filter((name) => !names.includes(name))].join(
    ",",
  );
}
