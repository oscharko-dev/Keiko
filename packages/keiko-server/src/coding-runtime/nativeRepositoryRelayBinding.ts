import {
  normalizedMavenRepositoryUrl,
  resolveMavenRepositories,
} from "../repository-relay/mavenRepositoryCredentials.js";
import { resolveNpmRegistries } from "../repository-relay/npmRepositoryCredentials.js";
import {
  repositoryRelayBaseUrl,
  type RepositoryCredentialRelay,
} from "../repository-relay/repositoryCredentialRelay.js";
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
}

function expandedRefusals(resolution: RepositoryResolution): NativeRelayRefusalReason[] {
  return Object.entries(resolution.refusals).flatMap(([reason, count]) =>
    Array.from({ length: count }, () => reason as NativeRelayRefusalReason),
  );
}

function bindOne(
  input: NativeRepositoryRelayInput,
  runId: string,
  repository: ResolvedRepository,
): { readonly relayId: string; readonly capability: string } | undefined {
  return input.relay.bind({
    runId,
    ecosystem: repository.ecosystem,
    upstreamBaseUrl: repository.url,
    ...(repository.credential === undefined ? {} : { credential: repository.credential }),
    secrets: [],
    ownOrigin: input.origin,
  });
}

/** One binding per Maven repository id: a `<server>` is per id, so a second URL cannot share it. */
function bindMaven(
  input: NativeRepositoryRelayInput,
  runId: string,
  resolution: RepositoryResolution,
  refusals: NativeRelayRefusalReason[],
): BoundMavenRepository[] {
  const bound: BoundMavenRepository[] = [];
  for (const repository of resolution.repositories) {
    const id = repository.id;
    if (id === undefined || id === "") {
      refusals.push("id-missing");
      continue;
    }
    const same = bound.find((entry) => entry.id === id);
    if (same !== undefined) {
      if (same.url !== repository.url) refusals.push("id-ambiguous");
      continue;
    }
    const binding = bindOne(input, runId, repository);
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
  runId: string,
  resolution: RepositoryResolution,
  refusals: NativeRelayRefusalReason[],
): BoundNpmRegistry[] {
  const bound: BoundNpmRegistry[] = [];
  for (const repository of resolution.repositories) {
    const binding = bindOne(input, runId, repository);
    if (binding === undefined) refusals.push("bind-refused");
    else bound.push({ key: npmKey(repository), ...binding });
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
    maven: bindMaven(input, sources.runId, mavenResolution, refusals),
    npm: bindNpm(input, sources.runId, npmResolution, refusals),
    refusals,
  };
}

// ---- Maven ----------------------------------------------------------------------------------

const MAVEN_REPOSITORY_ELEMENT = /<(mirror|repository|pluginRepository)>([\s\S]*?)<\/\1>/gu;
const PROXY_ELEMENT = /<proxy>([\s\S]*?)<\/proxy>/gu;
const LOOPBACK_NON_PROXY_HOSTS = "127.0.0.1|localhost";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** The element's `<url>` pointed at the relay when its id and URL are a bound repository's. */
function relayedElement(
  inner: string,
  bound: readonly BoundMavenRepository[],
  input: NativeRepositoryRelayInput,
): string {
  const id = /<id>([^<]*)<\/id>/u.exec(inner)?.[1];
  const url = /<url>([^<]*)<\/url>/u.exec(inner)?.[1];
  if (id === undefined || url === undefined) return inner;
  const normalized = normalizedMavenRepositoryUrl(unescapeXml(url).trim(), input.origin);
  const match = bound.find(
    (entry) => entry.id === unescapeXml(id).trim() && entry.url === normalized,
  );
  if (match === undefined) return inner;
  const relayed = escapeXml(repositoryRelayBaseUrl(input.origin, match.relayId));
  return inner.replace(/<url>[^<]*<\/url>/u, () => `<url>${relayed}</url>`);
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

/**
 * The sanitized settings with every bound repository's URL on the relay, a `<server>` per id whose
 * password is the run's capability, and loopback exempt from every proxy. The credential the person
 * keeps is not in the output; the capability opens one repository for this run only.
 */
export function relayMavenSettings(
  sanitizedXml: string,
  bound: readonly BoundMavenRepository[],
  input: NativeRepositoryRelayInput,
): string {
  const rewritten = sanitizedXml
    .replace(
      MAVEN_REPOSITORY_ELEMENT,
      (_block, name: string, inner: string) =>
        `<${name}>${relayedElement(inner, bound, input)}</${name}>`,
    )
    .replace(PROXY_ELEMENT, (_block, inner: string) => `<proxy>${loopbackNonProxy(inner)}</proxy>`);
  return rewritten.replace(/<\/settings>\s*$/u, () => `${serverElements(bound)}</settings>\n`);
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

/**
 * The sanitized `.npmrc` with each bound registry on the relay and the run's capability as its
 * token under the key npm derives from the relay's address. The relay refuses a POST, so the audit
 * request is switched off.
 */
export function relayNpmConfig(
  sanitizedText: string,
  bound: readonly BoundNpmRegistry[],
  input: NativeRepositoryRelayInput,
): string {
  const replaced = new Set([...bound.map((entry) => entry.key.toLowerCase()), "audit"]);
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
  return `${[...kept, "audit=false", ...relayed].join("\n")}\n`;
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
