import { createDecipheriv, createHash } from "node:crypto";
import {
  childElements,
  childText,
  parseXmlElements,
  type XmlElement,
} from "./repositoryRelayXml.js";
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
  type RepositorySource,
  type ResolvedRepository,
} from "./repositoryRelayTargets.js";

/**
 * The repositories of a Maven `settings.xml` and the credentials Maven itself would send to them
 * (#4522). Host-side and pure: the sanitized settings a run receives carry no `<server>`, so the
 * credential is resolved here, held by the relay and never written to the run.
 *
 * Covered: `mirrors/mirror` (`id`, `url`, `mirrorOf`), the `repositories` and `pluginRepositories`
 * of every profile named in `activeProfiles` or marked `activeByDefault`, and the `servers/server`
 * entry whose `id` equals the repository's. A password is plain, `${env.NAME}`, or Maven-encrypted
 * (`{...}`). The encryption is `plexus-cipher`'s: with a master password from
 * `settings-security.xml` (itself encrypted under the fixed phrase `settings.security`),
 * AES-128-CBC with a key and IV from SHA-256 over the passphrase and an 8-byte salt. It is verified
 * against values the real Maven produced (`mavenRepositoryCredentials.test.ts`).
 */
const MAVEN_ENV = /^env\.([A-Za-z_][A-Za-z0-9_.]*)$/u;
const MASTER_PASSPHRASE = "settings.security";
const DECORATED = /^\{([A-Za-z0-9+/=\s]+)\}$/u;
const SALT_BYTES = 8;
const BLOCK_BYTES = 16;

/** The text of a Maven-encrypted value, or `undefined` for a value that is not one. */
function encryptedPayload(value: string): string | undefined {
  const match = DECORATED.exec(value.trim());
  const payload = match?.[1]?.replaceAll(/\s/gu, "");
  return payload === undefined || payload.length < 32 ? undefined : payload;
}

/**
 * `{base64}` decrypted with `passphrase`: salt (8 bytes), padding length (1 byte), ciphertext, and
 * that many random padding bytes. Undefined when the value does not decrypt under the passphrase.
 */
function decryptMaven(payload: string, passphrase: string): string | undefined {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < SALT_BYTES + 1 + BLOCK_BYTES) return undefined;
  const randomTail = raw.readUInt8(SALT_BYTES);
  const ciphertext = raw.subarray(SALT_BYTES + 1, raw.length - randomTail);
  if (ciphertext.length === 0 || ciphertext.length % BLOCK_BYTES !== 0) return undefined;
  const material = createHash("sha256")
    .update(Buffer.from(passphrase, "utf8"))
    .update(raw.subarray(0, SALT_BYTES))
    .digest();
  const decipher = createDecipheriv(
    "aes-128-cbc",
    material.subarray(0, BLOCK_BYTES),
    material.subarray(BLOCK_BYTES, 2 * BLOCK_BYTES),
  );
  // The padding is checked here, not by the cipher: a wrong passphrase or a damaged value ends in
  // invalid padding, which is the closed reason `encrypted-decrypt-failed`, counted by the caller.
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const padding = paddingLength(padded);
  return padding === undefined
    ? undefined
    : padded.subarray(0, padded.length - padding).toString("utf8");
}

/** The PKCS#5 padding length of a block-aligned plaintext; undefined when the padding is invalid. */
function paddingLength(padded: Buffer): number | undefined {
  const pad = padded.at(-1) ?? 0;
  const valid =
    pad >= 1 &&
    pad <= BLOCK_BYTES &&
    padded.subarray(padded.length - pad).every((byte) => byte === pad);
  return valid ? pad : undefined;
}

type MasterPassword =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "known"; readonly password: string };

function masterPassword(settingsSecurityXml: string | undefined): MasterPassword {
  if (settingsSecurityXml === undefined) return { state: "absent" };
  const root = parseXmlElements(settingsSecurityXml);
  if (root?.name !== "settingsSecurity") return { state: "invalid" };
  const master = childText(root, "master");
  if (master === undefined || master === "") return { state: "absent" };
  const payload = encryptedPayload(master);
  const password = payload === undefined ? undefined : decryptMaven(payload, MASTER_PASSPHRASE);
  return password === undefined ? { state: "invalid" } : { state: "known", password };
}

interface ServerEntry {
  readonly username: string | undefined;
  readonly password: string | undefined;
}

function serverEntries(root: XmlElement): ReadonlyMap<string, ServerEntry> {
  const servers = new Map<string, ServerEntry>();
  for (const container of childElements(root, "servers")) {
    for (const server of childElements(container, "server")) {
      const id = childText(server, "id");
      // The first entry of an id wins, as the first matching declaration does in Maven's merge.
      if (id !== undefined && !servers.has(id))
        servers.set(id, {
          username: childText(server, "username"),
          password: childText(server, "password"),
        });
    }
  }
  return servers;
}

type CredentialResolution =
  | { readonly ok: true; readonly credential?: RepositoryCredential }
  | { readonly ok: false; readonly reason: RepositoryRefusalReason };

function plainOrEncrypted(
  value: string,
  master: MasterPassword,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: RepositoryRefusalReason } {
  const payload = encryptedPayload(value);
  if (payload === undefined) return { ok: true, value };
  if (master.state === "absent") return { ok: false, reason: "encrypted-master-missing" };
  const decrypted = master.state === "known" ? decryptMaven(payload, master.password) : undefined;
  return decrypted === undefined
    ? { ok: false, reason: "encrypted-decrypt-failed" }
    : { ok: true, value: decrypted };
}

function resolvePassword(
  raw: string,
  master: MasterPassword,
  env: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof plainOrEncrypted> {
  const interpolated = interpolateEnvironment(raw, env, MAVEN_ENV);
  return interpolated.ok ? plainOrEncrypted(interpolated.value, master) : interpolated;
}

function resolveCredential(
  server: ServerEntry | undefined,
  master: MasterPassword,
  env: Readonly<Record<string, string | undefined>>,
): CredentialResolution {
  if (server === undefined || (server.username === undefined && server.password === undefined))
    return { ok: true };
  if (server.username === undefined || server.password === undefined)
    return { ok: false, reason: "credential-incomplete" };
  const username = interpolateEnvironment(server.username, env, MAVEN_ENV);
  if (!username.ok) return username;
  const password = resolvePassword(server.password, master, env);
  if (!password.ok) return password;
  if (username.value === "" || password.value.length < REPOSITORY_SECRET_MIN_CHARS)
    return { ok: false, reason: "credential-too-short" };
  return {
    ok: true,
    credential: { kind: "basic", username: username.value, password: password.value },
  };
}

interface Declared {
  readonly source: RepositorySource;
  readonly id: string | undefined;
  readonly url: string | undefined;
  readonly mirrorOf?: string | undefined;
}

function declaredEntries(
  container: XmlElement,
  collection: string,
  entry: string,
  source: RepositorySource,
): readonly Declared[] {
  return childElements(container, collection).flatMap((group) =>
    childElements(group, entry).map((element) => ({
      source,
      id: childText(element, "id"),
      url: childText(element, "url"),
      mirrorOf: childText(element, "mirrorOf"),
    })),
  );
}

function allProfiles(root: XmlElement): readonly XmlElement[] {
  return childElements(root, "profiles").flatMap((group) => childElements(group, "profile"));
}

function isActiveProfile(profile: XmlElement, named: ReadonlySet<string>): boolean {
  const activation = childElements(profile, "activation")[0];
  return (
    named.has(childText(profile, "id") ?? "") ||
    (activation !== undefined && childText(activation, "activeByDefault") === "true")
  );
}

function activeProfileNames(root: XmlElement): ReadonlySet<string> {
  return new Set(
    childElements(root, "activeProfiles").flatMap((group) =>
      childElements(group, "activeProfile").map((profile) => profile.text),
    ),
  );
}

function profileRepositories(profile: XmlElement): readonly Declared[] {
  return [
    ...declaredEntries(profile, "repositories", "repository", "repository"),
    ...declaredEntries(profile, "pluginRepositories", "pluginRepository", "plugin-repository"),
  ];
}

function declaredRepositories(root: XmlElement): readonly Declared[] {
  const named = activeProfileNames(root);
  return [
    ...declaredEntries(root, "mirrors", "mirror", "mirror"),
    ...allProfiles(root)
      .filter((profile) => isActiveProfile(profile, named))
      .flatMap(profileRepositories),
  ];
}

/** The repositories of profiles that are neither listed in `activeProfiles` nor active by default. */
function inactiveProfileRepositories(root: XmlElement): readonly Declared[] {
  const named = activeProfileNames(root);
  return allProfiles(root)
    .filter((profile) => !isActiveProfile(profile, named))
    .flatMap(profileRepositories);
}

/**
 * Every mirror and every profile repository of a parsed `settings.xml`, active or not, with the
 * `id` and `url` the parser read. The run binding uses it to prove that no element sharing a bound
 * id can still send that id's credential to the repository's real host.
 */
export function everyMavenRepositoryElement(
  root: XmlElement,
): readonly { readonly id: string | undefined; readonly url: string | undefined }[] {
  return [
    ...declaredEntries(root, "mirrors", "mirror", "mirror"),
    ...allProfiles(root).flatMap(profileRepositories),
  ];
}

/**
 * The normalised URL a declared repository URL resolves to (environment placeholders filled in,
 * user info refused), or undefined when the resolution would have left it out. The run binding
 * uses it to find the `<url>` of the settings element a resolved repository came from.
 */
export function normalizedMavenRepositoryUrl(
  declared: string,
  ownOrigin: string | undefined,
): string | undefined {
  if (isInterpolated(declared)) return undefined;
  const admitted = admitRepositoryUrl(declared, ownOrigin);
  return admitted.ok ? admitted.url.href : undefined;
}

export interface MavenResolutionContext {
  readonly servers: ReadonlyMap<string, ServerEntry>;
  readonly master: MasterPassword;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ownOrigin: string | undefined;
}

function resolveDeclared(
  declared: Declared,
  context: MavenResolutionContext,
  tally: RefusalTally,
): ResolvedRepository | undefined {
  if (declared.url === undefined || declared.url === "") {
    tally.add("url-missing");
    return undefined;
  }
  if (isInterpolated(declared.url)) {
    tally.add("url-interpolated");
    return undefined;
  }
  const admitted = admitRepositoryUrl(declared.url, context.ownOrigin);
  if (!admitted.ok) {
    tally.add(admitted.reason);
    return undefined;
  }
  const credential = resolveCredential(
    declared.id === undefined ? undefined : context.servers.get(declared.id),
    context.master,
    context.env,
  );
  if (!credential.ok) {
    tally.add(credential.reason);
    return undefined;
  }
  return {
    ecosystem: "maven",
    source: declared.source,
    ...(declared.id === undefined ? {} : { id: declared.id }),
    ...(declared.mirrorOf === undefined ? {} : { mirrorOf: declared.mirrorOf }),
    url: admitted.url.href,
    ...(credential.credential === undefined ? {} : { credential: credential.credential }),
  };
}

/**
 * Every relayable Maven repository of `settingsXml`, each with the credential Maven would send, and
 * a count of what was left out by closed reason. `ownOrigin` is Keiko's own server origin, which is
 * never a target. A document with a DOCTYPE or any entity it does not model resolves nothing.
 */
export function resolveMavenRepositories(
  settingsXml: string,
  settingsSecurityXml: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  ownOrigin?: string,
): RepositoryResolution {
  const tally = new RefusalTally();
  const root = parseXmlElements(settingsXml);
  if (root?.name !== "settings") {
    tally.add("document-refused");
    return { repositories: [], refusals: tally.toCounts() };
  }
  const context: MavenResolutionContext = {
    servers: serverEntries(root),
    master: masterPassword(settingsSecurityXml),
    env: repositoryResolutionEnvironment(env),
    ownOrigin,
  };
  const repositories = declaredRepositories(root).flatMap((declared) => {
    const resolved = resolveDeclared(declared, context, tally);
    return resolved === undefined ? [] : [resolved];
  });
  // A repository of an inactive profile is not relayed (Maven would not use it unless the person
  // activates the profile on the command line): counted so a 401 for it can be explained.
  const inactive = inactiveProfileRepositories(root).length;
  if (inactive > 0) tally.add("profile-inactive", inactive);
  return { repositories, refusals: tally.toCounts() };
}
