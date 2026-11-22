// An internal Maven repository group that requires a login, on loopback (#4492). The Coding
// acceptance task's `maven-internal-repository` project has a parent POM that only this repository
// serves; everything else Maven needs comes from the cache `npm run provision:acceptance-maven`
// builds, so a case reaches no network. A request without the right Basic credentials gets 401, a
// file the repository does not hold gets 404, and the counts by status are the case's evidence of
// what the build reached. Like every shared fixture module under `src/test-support/` it imports no
// other test-support module (ADR-0019 trust rule 8), and its listener is fixture-owned: an
// ephemeral loopback port, ready before `start` returns, closed by `close()`.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURES = join(REPOSITORY_ROOT, "tests", "fixtures", "coding-acceptance");
/** The repository's private artifacts, in Maven layout: served only behind the login. */
const PRIVATE_REPOSITORY = join(FIXTURES, "maven-repository");
/** The provisioned cache of everything else (`scripts/provision-acceptance-maven.mjs`). */
export const MAVEN_CACHE_DIRECTORY = join(REPOSITORY_ROOT, ".acceptance-maven", "repository");
const MAVEN_CACHE_LOCK = join(FIXTURES, "maven-cache.lock.json");
const PROVISION_COMMAND = "npm run provision:acceptance-maven";

/** The login of the fixture repository. Test values; they open nothing outside this suite. */
export const FUNCTIONAL_MAVEN_USERNAME = "acceptance-reader";
export const FUNCTIONAL_MAVEN_PASSWORD = "acceptance-fixture-password";
/** The repository id a person's `settings.xml` gives the mirror and its `<server>` entry. */
export const FUNCTIONAL_MAVEN_REPOSITORY_ID = "acceptance-internal";

interface MavenCacheLock {
  readonly files: Readonly<Record<string, string>>;
}

export interface FunctionalMavenRepository {
  /** `http://127.0.0.1:<port>`: the repository group's URL. */
  readonly url: string;
  /** The requests answered so far, by status code, such as `{ "401": 12, "200": 80 }`. */
  readonly statusCounts: () => Readonly<Record<string, number>>;
  readonly close: () => Promise<void>;
}

/**
 * The provisioned cache's `.pom` and `.jar` files, checked against the committed lock. A missing
 * or altered cache fails the suite and names the command that builds it: a missing proof runtime
 * must never quietly skip the acceptance cases.
 */
export function verifiedMavenCache(
  cacheDirectory: string = MAVEN_CACHE_DIRECTORY,
  lockFile: string = MAVEN_CACHE_LOCK,
): ServedCache {
  if (!existsSync(cacheDirectory)) {
    throw new Error(`acceptance-maven-cache-missing: run \`${PROVISION_COMMAND}\` once`);
  }
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as MavenCacheLock;
  const actual = new Map(
    cachedArtifacts(cacheDirectory).map((path) => [
      path,
      digest("sha256", readFileSync(join(cacheDirectory, path))),
    ]),
  );
  const expected = Object.entries(lock.files);
  const mismatched =
    expected.filter(([path, sha]) => actual.get(path) !== sha).length +
    [...actual.keys()].filter((path) => !(path in lock.files)).length;
  if (mismatched > 0) {
    throw new Error(
      `acceptance-maven-cache-mismatch: ${String(mismatched)} artifacts differ from the lock; run \`${PROVISION_COMMAND}\``,
    );
  }
  return { directory: cacheDirectory, locked: new Set(Object.keys(lock.files)) };
}

function cachedArtifacts(directory: string): readonly string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(pom|jar)$/u.test(entry.name)) {
        found.push(relative(directory, full).split(sep).join("/"));
      }
    }
  };
  visit(directory);
  return found.sort();
}

function digest(algorithm: "sha1" | "sha256", bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

/** The cache directory a repository serves, and the only files of it that it serves. */
export interface ServedCache {
  readonly directory: string;
  readonly locked: ReadonlySet<string>;
}

/** The real file a path names below `root`, or undefined when it leaves `root` or is no file. */
function fileInside(root: string, decoded: string): string | undefined {
  const candidate = resolve(root, `.${decoded}`);
  if (!existsSync(candidate)) return undefined;
  const real = realpathSync(candidate);
  const inside = relative(realpathSync(root), real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return statSync(real).isFile() ? real : undefined;
}

/**
 * The file a repository path names: any file of the private repository first, then a file of the
 * cache that the lock lists. A symbolic link counts only when its real path stays in its root.
 */
function servedFile(cache: ServedCache, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?", 1)[0] ?? "");
  } catch {
    return undefined;
  }
  const privateFile = fileInside(PRIVATE_REPOSITORY, decoded);
  if (privateFile !== undefined) return privateFile;
  const cached = fileInside(cache.directory, decoded);
  if (cached === undefined) return undefined;
  const name = relative(realpathSync(cache.directory), cached).split(sep).join("/");
  return cache.locked.has(name) ? cached : undefined;
}

/** Maven's checksum requests: the digest of the file the repository serves, computed on demand. */
function checksumOf(cache: ServedCache, urlPath: string): string | undefined {
  const match = /^(.*)\.(sha1|sha256)$/u.exec(urlPath);
  const file = match?.[1] === undefined ? undefined : servedFile(cache, match[1]);
  if (file === undefined || match?.[2] === undefined) return undefined;
  return digest(match[2] === "sha1" ? "sha1" : "sha256", readFileSync(file));
}

/** The bytes a repository path names: a served file, or the checksum of one. */
function bodyFor(cache: ServedCache, urlPath: string): Buffer | undefined {
  const file = servedFile(cache, urlPath);
  if (file !== undefined) return readFileSync(file);
  const checksum = checksumOf(cache, urlPath.split("?", 1)[0] ?? "");
  return checksum === undefined ? undefined : Buffer.from(checksum, "utf8");
}

function authorized(request: IncomingMessage, username: string, password: string): boolean {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return request.headers.authorization === expected;
}

function answer(
  response: ServerResponse,
  counts: Map<string, number>,
  status: number,
  headers: Record<string, string | number>,
  body?: Uint8Array,
): void {
  counts.set(String(status), (counts.get(String(status)) ?? 0) + 1);
  response.writeHead(status, headers);
  response.end(body);
}

function handle(
  cache: ServedCache,
  request: IncomingMessage,
  response: ServerResponse,
  counts: Map<string, number>,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    answer(response, counts, 405, { Allow: "GET, HEAD" });
    return;
  }
  if (!authorized(request, FUNCTIONAL_MAVEN_USERNAME, FUNCTIONAL_MAVEN_PASSWORD)) {
    answer(response, counts, 401, { "WWW-Authenticate": 'Basic realm="acceptance-internal"' });
    return;
  }
  const body = bodyFor(cache, request.url ?? "/");
  if (body === undefined) {
    answer(response, counts, 404, { "Content-Length": 0 });
    return;
  }
  const headers = { "Content-Type": "application/octet-stream", "Content-Length": body.length };
  answer(response, counts, 200, headers, request.method === "HEAD" ? undefined : body);
}

/**
 * Starts the repository on an ephemeral loopback port; the cache is verified first. `cache` names
 * another verified cache directory, for the repository's own tests.
 */
export async function startFunctionalMavenRepository(
  cache: ServedCache = verifiedMavenCache(),
): Promise<FunctionalMavenRepository> {
  const counts = new Map<string, number>();
  const server: Server = createServer((request, response) => {
    handle(cache, request, response, counts);
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", ready);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    statusCounts: () => Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A person's `settings.xml` that sends every artifact request to the repository, with the login in
 * `<servers>` as Maven keeps it.
 */
export function mavenSettingsXml(input: {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
}): string {
  const username = input.username ?? FUNCTIONAL_MAVEN_USERNAME;
  const password = input.password ?? FUNCTIONAL_MAVEN_PASSWORD;
  return `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <mirrors>
    <mirror>
      <id>${FUNCTIONAL_MAVEN_REPOSITORY_ID}</id>
      <name>Internal repository group</name>
      <url>${escapeXml(input.url)}</url>
      <mirrorOf>*</mirrorOf>
    </mirror>
  </mirrors>
  <servers>
    <server>
      <id>${FUNCTIONAL_MAVEN_REPOSITORY_ID}</id>
      <username>${escapeXml(username)}</username>
      <password>${escapeXml(password)}</password>
    </server>
  </servers>
</settings>
`;
}

/** Writes `<home>/.m2/settings.xml`, the file Maven reads for the person who owns `home`. */
export function writeMavenPersonSettings(home: string, settingsXml: string): void {
  mkdirSync(join(home, ".m2"), { recursive: true });
  writeFileSync(join(home, ".m2", "settings.xml"), settingsXml, { mode: 0o600 });
}

/**
 * Runs `work` with this process's `HOME` pointed at `home` (`os.homedir()` follows it), and puts the
 * previous value back whatever `work` does. Cases run one after another in their own process, so
 * nothing else reads the changed value while it holds.
 */
export async function withPersonHome<T>(home: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}
