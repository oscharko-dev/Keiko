/**
 * The vocabulary the repository credential relay (#4522) shares between the host-side credential
 * resolution and the relay itself: what a repository is, which credential forms exist, why a
 * repository or a credential is left out, and which URLs may be a relay target at all.
 *
 * Everything here is host-side. A resolved credential lives only in Keiko's own process and is never
 * written to a run; the run holds a capability for one repository instead.
 */

export type RepositoryEcosystem = "maven" | "npm";

export type RepositoryCredential =
  | { readonly kind: "basic"; readonly username: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: string };

/**
 * A credential shorter than this cannot be told apart from ordinary bytes in an artifact, so the
 * relay could not keep its promise to refuse a response that echoes it. Shorter secrets are not bound.
 */
export const REPOSITORY_SECRET_MIN_CHARS = 8;

/** Why a repository, or the credential of one, was left out of a resolution. Closed; never a value. */
export const REPOSITORY_REFUSAL_REASONS = [
  "document-refused",
  "url-missing",
  "url-unsupported",
  "url-userinfo",
  "url-own-origin",
  "url-interpolated",
  "interpolation-unsupported",
  "env-unavailable",
  "credential-incomplete",
  "credential-too-short",
  "encrypted-master-missing",
  "encrypted-decrypt-failed",
] as const;
export type RepositoryRefusalReason = (typeof REPOSITORY_REFUSAL_REASONS)[number];

export type RepositoryRefusalCounts = Readonly<Partial<Record<RepositoryRefusalReason, number>>>;

/** Where a Maven repository was declared; an npm registry is `registry` or `scoped-registry`. */
export type RepositorySource =
  "mirror" | "repository" | "plugin-repository" | "registry" | "scoped-registry";

export interface ResolvedRepository {
  readonly ecosystem: RepositoryEcosystem;
  readonly source: RepositorySource;
  /** Maven: the `id` of the mirror or repository. Absent for npm. */
  readonly id?: string;
  /** Maven mirrors only: the `mirrorOf` pattern, as written. */
  readonly mirrorOf?: string;
  /** npm scoped registries only: the scope including its `@`. */
  readonly scope?: string;
  /** The upstream base URL, normalised: http or https, no user info, a trailing slash, no query. */
  readonly url: string;
  /** Absent for an anonymous repository. */
  readonly credential?: RepositoryCredential;
}

export interface RepositoryResolution {
  /** Every repository that can be relayed; a repository whose credential cannot be had is not here. */
  readonly repositories: readonly ResolvedRepository[];
  /** How many repositories or credentials were left out, by closed reason. */
  readonly refusals: RepositoryRefusalCounts;
}

export class RefusalTally {
  private readonly counts = new Map<RepositoryRefusalReason, number>();

  public add(reason: RepositoryRefusalReason): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  public toCounts(): RepositoryRefusalCounts {
    return Object.fromEntries(this.counts);
  }
}

/**
 * The environment a person's repository files may read credentials from. Keiko's own names and the
 * names of model providers and gateways never are: a settings file that points a repository at a
 * foreign host and a credential at `${env.KEIKO_GATEWAY_API_KEY}` would otherwise hand that key to it.
 */
const DENIED_ENVIRONMENT_NAME =
  /^KEIKO_|(?:^|_)(?:OPENAI|ANTHROPIC|AZURE|GEMINI|GOOGLE|MISTRAL|COHERE|GROQ|LITELLM|OPENROUTER|HUGGINGFACE|HF|DEEPSEEK|XAI|BEDROCK|AWS|GATEWAY)(?:_|$)/iu;

export function repositoryResolutionEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !DENIED_ENVIRONMENT_NAME.test(name)),
  );
}

/** A repository URL is never interpolated: its host is where a credential is sent. */
export function isInterpolated(value: string): boolean {
  return value.includes("${");
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * Whether `target` is Keiko's own server. Loopback spellings of one port are one origin: a relay
 * that pointed at `localhost:<port>` while Keiko answers on `127.0.0.1:<port>` would let a run
 * reach Keiko's own routes through the relay.
 */
export function isOwnServerOrigin(target: URL, ownOrigin: string | undefined): boolean {
  if (ownOrigin === undefined) return false;
  // An unparsable own origin cannot prove a target is foreign: fail closed.
  if (!URL.canParse(ownOrigin)) return true;
  const own = new URL(ownOrigin);
  if (effectivePort(target) !== effectivePort(own)) return false;
  if (target.hostname === own.hostname) return true;
  return LOOPBACK_NAMES.has(target.hostname) && LOOPBACK_NAMES.has(own.hostname);
}

export type RepositoryUrlAdmission =
  | { readonly ok: true; readonly url: URL }
  | {
      readonly ok: false;
      readonly reason: "url-unsupported" | "url-userinfo" | "url-own-origin";
    };

/**
 * A repository URL a relay may target: http or https, no query, no fragment, and no user info. User
 * info is refused rather than moved into the credential: a repository that needs it names a
 * `<server>` or an `_authToken`, and a URL that carries a secret is also one a build tool prints.
 */
export function admitRepositoryUrl(
  raw: string,
  ownOrigin: string | undefined,
): RepositoryUrlAdmission {
  if (!URL.canParse(raw.trim())) return { ok: false, reason: "url-unsupported" };
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "url-unsupported" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "url-userinfo" };
  if (url.search !== "") return { ok: false, reason: "url-unsupported" };
  if (isOwnServerOrigin(url, ownOrigin)) return { ok: false, reason: "url-own-origin" };
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { ok: true, url };
}

/** `${NAME}` and `${env.NAME}` resolved from the given environment; anything else is refused. */
export type InterpolationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "interpolation-unsupported" | "env-unavailable" };

const PLACEHOLDER = /\$\{([^}]*)\}/gu;

export function interpolateEnvironment(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  pattern: RegExp,
): InterpolationResult {
  let reason: "interpolation-unsupported" | "env-unavailable" | undefined;
  const resolved = value.replace(PLACEHOLDER, (placeholder: string, inner: string) => {
    const name = pattern.exec(inner)?.[1];
    if (name === undefined) {
      reason ??= "interpolation-unsupported";
      return placeholder;
    }
    const found = env[name];
    if (found === undefined) {
      reason ??= "env-unavailable";
      return placeholder;
    }
    return found;
  });
  return reason === undefined ? { ok: true, value: resolved } : { ok: false, reason };
}
