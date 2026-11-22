import {
  admitRepositoryUrl,
  interpolateEnvironment,
  isInterpolated,
  RefusalTally,
  repositoryResolutionEnvironment,
  REPOSITORY_SECRET_MIN_CHARS,
  type RepositoryCredential,
  type RepositoryRefusalReason,
  type RepositoryResolution,
  type ResolvedRepository,
} from "./repositoryRelayTargets.js";

/**
 * The registries of an npm user config and the credentials npm itself would send to them (#4522).
 * Host-side and pure, like the Maven resolution: the sanitized `.npmrc` a run receives carries no
 * token, so the credential is resolved here and held by the relay.
 *
 * Covered: `registry`, `@scope:registry`, and the auth keys scoped by a registry path as npm scopes
 * them (`//host[:port]/path/:_authToken`, `:_auth`, `:username` with `:_password`), found for a
 * registry at its own path or at the nearest parent path, as npm walks up. `${NAME}` takes its value
 * from the given environment; any other `${...}` form is refused.
 */
const NPM_ENV = /^([A-Za-z_]\w*)$/u;
const NPMRC_MAX_CHARS = 256 * 1024;
const SCOPE_REGISTRY = /^(@[a-z0-9][\w.-]*):registry$/iu;
const AUTH_KEY = /^(\/\/.+\/):(_authToken|_auth|username|_password)$/u;

type AuthField = "_authToken" | "_auth" | "username" | "_password";
type AuthFields = Partial<Record<AuthField, string>>;

function unquoted(value: string): string {
  const quote = value.at(0);
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)
    ? value.slice(1, -1)
    : value;
}

/** The `key=value` pairs of an ini-style config; the last occurrence of a key wins. */
function npmrcEntries(npmrc: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of npmrc.slice(0, NPMRC_MAX_CHARS).split(/\r?\n/u)) {
    const text = line.trim();
    if (text === "" || text.startsWith(";") || text.startsWith("#")) continue;
    const separator = text.indexOf("=");
    if (separator <= 0) continue;
    entries.set(text.slice(0, separator).trim(), unquoted(text.slice(separator + 1).trim()));
  }
  return entries;
}

/** `//host[:port]/path/` normalised the way a registry URL's own host is (default ports dropped). */
function nerfDart(url: URL): string {
  return `//${url.host}${url.pathname}`;
}

function normalisedAuthPrefix(prefix: string, protocol: string): string | undefined {
  const candidate = `${protocol}${prefix}`;
  return URL.canParse(candidate) ? nerfDart(new URL(candidate)) : undefined;
}

function authByPrefix(
  entries: ReadonlyMap<string, string>,
  protocol: string,
): ReadonlyMap<string, AuthFields> {
  const byPrefix = new Map<string, AuthFields>();
  for (const [key, value] of entries) {
    const match = AUTH_KEY.exec(key);
    const prefix = match?.[1] === undefined ? undefined : normalisedAuthPrefix(match[1], protocol);
    if (prefix === undefined || match?.[2] === undefined) continue;
    byPrefix.set(prefix, { ...byPrefix.get(prefix), [match[2]]: value });
  }
  return byPrefix;
}

/** The auth entry for a registry at its own path or, failing that, the nearest parent path. */
function authForRegistry(
  byPrefix: ReadonlyMap<string, AuthFields>,
  url: URL,
): AuthFields | undefined {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const path = `/${segments.slice(0, depth).join("/")}${depth === 0 ? "" : "/"}`;
    const found = byPrefix.get(`//${url.host}${path}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

type FieldResolution =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly reason: RepositoryRefusalReason };

function authField(
  auth: AuthFields,
  field: AuthField,
  env: Readonly<Record<string, string | undefined>>,
): FieldResolution {
  const raw = auth[field];
  if (raw === undefined) return { ok: true, value: undefined };
  const interpolated = interpolateEnvironment(raw, env, NPM_ENV);
  return interpolated.ok ? { ok: true, value: interpolated.value } : interpolated;
}

function decodedBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  // A replacement character means the bytes were not UTF-8: not a credential.
  return decoded.includes("�") ? undefined : decoded;
}

type CredentialResolution =
  | { readonly ok: true; readonly credential?: RepositoryCredential }
  | { readonly ok: false; readonly reason: RepositoryRefusalReason };

function basicCredential(username: string, password: string): CredentialResolution {
  return username === "" || password.length < REPOSITORY_SECRET_MIN_CHARS
    ? { ok: false, reason: "credential-too-short" }
    : { ok: true, credential: { kind: "basic", username, password } };
}

function tokenCredential(token: string): CredentialResolution {
  return token.length < REPOSITORY_SECRET_MIN_CHARS
    ? { ok: false, reason: "credential-too-short" }
    : { ok: true, credential: { kind: "bearer", token } };
}

// `_auth` is base64 of `username:password`.
function authCredential(auth: string): CredentialResolution {
  const decoded = decodedBase64(auth);
  const separator = decoded?.indexOf(":") ?? -1;
  return decoded === undefined || separator <= 0
    ? { ok: false, reason: "credential-incomplete" }
    : basicCredential(decoded.slice(0, separator), decoded.slice(separator + 1));
}

// `username` with `_password`, which is base64 of the password.
function passwordCredential(
  username: string | undefined,
  encoded: string | undefined,
): CredentialResolution {
  if (username === undefined && encoded === undefined) return { ok: true };
  const password = encoded === undefined ? undefined : decodedBase64(encoded);
  return username === undefined || password === undefined
    ? { ok: false, reason: "credential-incomplete" }
    : basicCredential(username, password);
}

function credentialFromFields(
  fields: Readonly<Record<AuthField, string | undefined>>,
): CredentialResolution {
  if (fields._authToken !== undefined) return tokenCredential(fields._authToken);
  if (fields._auth !== undefined) return authCredential(fields._auth);
  return passwordCredential(fields.username, fields._password);
}

function resolveCredential(
  auth: AuthFields | undefined,
  env: Readonly<Record<string, string | undefined>>,
): CredentialResolution {
  if (auth === undefined) return { ok: true };
  const fields: Record<AuthField, string | undefined> = {
    _authToken: undefined,
    _auth: undefined,
    username: undefined,
    _password: undefined,
  };
  for (const field of Object.keys(fields) as AuthField[]) {
    const resolved = authField(auth, field, env);
    if (!resolved.ok) return resolved;
    fields[field] = resolved.value;
  }
  return credentialFromFields(fields);
}

interface Declared {
  readonly source: "registry" | "scoped-registry";
  readonly scope?: string;
  readonly url: string;
}

function declaredRegistries(entries: ReadonlyMap<string, string>): readonly Declared[] {
  const declared: Declared[] = [];
  for (const [key, value] of entries) {
    if (key === "registry") declared.push({ source: "registry", url: value });
    const scope = SCOPE_REGISTRY.exec(key)?.[1];
    if (scope !== undefined)
      declared.push({ source: "scoped-registry", scope: scope.toLowerCase(), url: value });
  }
  return declared;
}

/**
 * Every relayable registry of `npmrc` with the credential npm would send, and a count of what was
 * left out by closed reason. `ownOrigin` is Keiko's own server origin, which is never a target.
 */
export function resolveNpmRegistries(
  npmrc: string,
  env: Readonly<Record<string, string | undefined>>,
  ownOrigin?: string,
): RepositoryResolution {
  const tally = new RefusalTally();
  const entries = npmrcEntries(npmrc);
  const allowedEnv = repositoryResolutionEnvironment(env);
  const repositories: ResolvedRepository[] = [];
  for (const declared of declaredRegistries(entries)) {
    if (isInterpolated(declared.url)) {
      tally.add("url-interpolated");
      continue;
    }
    const admitted = admitRepositoryUrl(declared.url, ownOrigin);
    if (!admitted.ok) {
      tally.add(admitted.reason);
      continue;
    }
    const auth = authForRegistry(authByPrefix(entries, admitted.url.protocol), admitted.url);
    const credential = resolveCredential(auth, allowedEnv);
    if (!credential.ok) {
      tally.add(credential.reason);
      continue;
    }
    repositories.push({
      ecosystem: "npm",
      source: declared.source,
      ...(declared.scope === undefined ? {} : { scope: declared.scope }),
      url: admitted.url.href,
      ...(credential.credential === undefined ? {} : { credential: credential.credential }),
    });
  }
  return { repositories, refusals: tally.toCounts() };
}
