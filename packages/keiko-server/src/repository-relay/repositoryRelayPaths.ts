import type { RepositoryEcosystem } from "./repositoryRelayTargets.js";

/**
 * The request paths the repository relay (#4522) forwards. A run asks for a repository file; the
 * relay turns the path into one upstream path, and only for a shape the ecosystem's own clients
 * produce. Nothing is decoded and nothing is normalised: a path either is one of these shapes or is
 * refused, so an encoded slash, a dot segment, an absolute URL or a query cannot move a request
 * outside the repository's base path.
 */
export const REPOSITORY_PATH_MAX_CHARS = 1024;
export const REPOSITORY_PATH_MAX_SEGMENTS = 32;

export type RepositoryPathKind = "maven-text" | "maven-binary" | "npm-packument" | "npm-tarball";

export type RepositoryPathRefusal = "path-invalid" | "path-too-long" | "path-unsupported";

export type RepositoryPathAdmission =
  | {
      readonly ok: true;
      readonly kind: RepositoryPathKind;
      /** Relative to the repository's base URL; no leading slash. */
      readonly upstreamPath: string;
    }
  | { readonly ok: false; readonly reason: RepositoryPathRefusal };

const MAVEN_SEGMENT = /^[A-Za-z0-9._+~@-]{1,200}$/u;
const NPM_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/u;
const NPM_SCOPE = /^@[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/u;
const NPM_TARBALL_FILE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}\.tgz$/u;
const ENCODED_SLASH = /%2f/giu;
// Files a Maven client reads as text: POMs, metadata, Gradle module metadata, checksums, signatures.
const MAVEN_TEXT_FILE = /\.(?:pom|xml|module|json|txt|properties|sha1|sha256|sha512|md5|asc)$/iu;

function isDotOnly(segment: string): boolean {
  return /^\.+$/u.test(segment);
}

function mavenPath(path: string): RepositoryPathAdmission {
  const segments = path.split("/");
  if (segments.some((segment) => !MAVEN_SEGMENT.test(segment) || isDotOnly(segment)))
    return { ok: false, reason: "path-invalid" };
  const file = segments.at(-1) ?? "";
  // A repository file has an extension; a directory request is not one.
  if (!file.includes(".") || segments.length < 2) return { ok: false, reason: "path-unsupported" };
  return {
    ok: true,
    kind: MAVEN_TEXT_FILE.test(file) ? "maven-text" : "maven-binary",
    upstreamPath: path,
  };
}

function npmPackageName(segments: readonly string[]): string | undefined {
  const [first, second] = segments;
  if (first === undefined) return undefined;
  if (first.startsWith("@"))
    return second !== undefined && NPM_SCOPE.test(first) && NPM_NAME.test(second)
      ? `${first}/${second}`
      : undefined;
  return NPM_NAME.test(first) ? first : undefined;
}

// A scoped packument is requested as `@scope%2fname`, the one encoded character npm clients send.
function npmPackument(path: string): RepositoryPathAdmission | undefined {
  const encoded = /^(@[^/%]+)%2f([^/%]+)$/iu.exec(path);
  const name =
    encoded === null
      ? npmPackageName(path.split("/"))
      : npmPackageName([encoded[1] ?? "", encoded[2] ?? ""]);
  // For a plain path the name must be the whole path: `pkg/extra` names `pkg` and is not a packument.
  if (name === undefined || (encoded === null && name !== path)) return undefined;
  return { ok: true, kind: "npm-packument", upstreamPath: name.replace("/", "%2F") };
}

// `name/-/name-1.0.0.tgz`, `@scope/name/-/name-1.0.0.tgz`, and the `@scope/name-1.0.0.tgz` file path
// some registries put after the `-` directory.
function npmTarball(segments: readonly string[]): RepositoryPathAdmission | undefined {
  const marker = segments.indexOf("-");
  if (marker < 1 || marker > 2) return undefined;
  const name = npmPackageName(segments.slice(0, marker));
  const file = segments.slice(marker + 1);
  const scoped = file.length === 2 && file[0] !== undefined && NPM_SCOPE.test(file[0]);
  const last = file.at(-1);
  if (name === undefined || last === undefined || !NPM_TARBALL_FILE.test(last)) return undefined;
  if (file.length !== 1 && !scoped) return undefined;
  return { ok: true, kind: "npm-tarball", upstreamPath: segments.join("/") };
}

// The one encoded character an npm client sends is the slash of a scoped packument name.
function npmPath(path: string): RepositoryPathAdmission {
  if (path.replaceAll(ENCODED_SLASH, "").includes("%"))
    return { ok: false, reason: "path-invalid" };
  const segments = path.split("/");
  const admitted =
    segments.includes("-") && !path.includes("%") ? npmTarball(segments) : npmPackument(path);
  return admitted ?? { ok: false, reason: "path-unsupported" };
}

/** What every ecosystem refuses first: an empty, absolute, directory, dotted or oversized path. */
function pathShapeRefusal(rawPath: string): RepositoryPathRefusal | undefined {
  if (rawPath.length > REPOSITORY_PATH_MAX_CHARS) return "path-too-long";
  if (rawPath === "" || rawPath.startsWith("/") || rawPath.endsWith("/")) return "path-invalid";
  const segments = rawPath.split("/");
  if (segments.length > REPOSITORY_PATH_MAX_SEGMENTS) return "path-too-long";
  return segments.some((segment) => segment === "" || isDotOnly(segment))
    ? "path-invalid"
    : undefined;
}

/**
 * The upstream path of a repository request, or why it is refused. `rawPath` is the path as it was
 * sent, after the relay's own prefix and without its query: encoded characters are still encoded.
 */
export function admitRepositoryPath(
  ecosystem: RepositoryEcosystem,
  rawPath: string,
): RepositoryPathAdmission {
  const refusal = pathShapeRefusal(rawPath);
  if (refusal !== undefined) return { ok: false, reason: refusal };
  return ecosystem === "maven" ? mavenPath(rawPath) : npmPath(rawPath);
}
