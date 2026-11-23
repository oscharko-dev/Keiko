// An npm registry that answers only to a bearer token, on loopback (#4522). The repository
// credential relay tests and the Coding acceptance task's `npm-internal-registry` project use it as
// the person's private registry: one package, served with the integrity metadata npm verifies, and
// a count of what it answered. Like every shared fixture module under `src/test-support/` it imports
// no other test-support module (ADR-0019 trust rule 8), and its listener is fixture-owned: an
// ephemeral loopback port, ready before `start` returns, closed by `close()`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a registry request carried, as the registry saw it. */
export interface FunctionalNpmRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

export interface FunctionalNpmRegistryOptions {
  /** The one package the registry serves; a scoped name such as `@acceptance/ledger` is fine. */
  readonly packageName: string;
  /** The bearer token every request must carry. */
  readonly token: string;
  readonly version?: string;
  /** The package's `index.js`, a CommonJS module. */
  readonly moduleSource?: string;
  /**
   * The path the registry is served under, such as `/repository/npm-group` for a Nexus group;
   * empty (the root) by default. No trailing slash.
   */
  readonly basePath?: string;
}

export interface FunctionalNpmRegistry {
  /** `http://127.0.0.1:<port>` and the base path: the registry's URL, without a trailing slash. */
  readonly url: string;
  /** Every request received, in order. */
  readonly seen: readonly FunctionalNpmRequest[];
  /** The requests answered so far, by status code, such as `{ "401": 1, "200": 2 }`. */
  readonly statusCounts: () => Readonly<Record<string, number>>;
  readonly close: () => Promise<void>;
}

interface PackedTarball {
  readonly bytes: Buffer;
  readonly integrity: string;
  readonly shasum: string;
}

/** A package tarball with the metadata npm verifies it against. */
function packTarball(options: FunctionalNpmRegistryOptions, version: string): PackedTarball {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-npm-registry-")));
  try {
    const directory = join(root, "tarball", "package");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: options.packageName, version, main: "index.js" }),
    );
    writeFileSync(
      join(directory, "index.js"),
      options.moduleSource ?? "module.exports = 'from the relay';\n",
    );
    const file = join(root, "fixture.tgz");
    execFileSync("tar", ["-czf", file, "-C", join(root, "tarball"), "package"]);
    const bytes = readFileSync(file);
    return {
      bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The request path with its escapes resolved, so `@scope%2fname` and `@scope/name` are one name. */
function decodedPath(url: string): string {
  try {
    return decodeURIComponent(url.split("?", 1)[0] ?? "");
  } catch (error) {
    // A malformed escape names no package; anything else is a defect of the fixture.
    if (error instanceof URIError) return "";
    throw error;
  }
}

/** The registry's answer to one request, by status, headers and body. */
type NpmAnswer = readonly [
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array | string,
];

function routeRequest(
  options: FunctionalNpmRegistryOptions,
  tarball: PackedTarball,
  version: string,
  base: string,
  request: IncomingMessage,
): NpmAnswer {
  if (request.headers.authorization !== `Bearer ${options.token}`) return [401, {}];
  const bareName = options.packageName.split("/").at(-1) ?? options.packageName;
  const basePath = options.basePath ?? "";
  const tarballPath = `/${options.packageName}/-/${bareName}-${version}.tgz`;
  const path = decodedPath(request.url ?? "");
  if (path === `${basePath}/${options.packageName}`) {
    const dist = {
      tarball: `${base}${tarballPath}`,
      integrity: tarball.integrity,
      shasum: tarball.shasum,
    };
    const body = JSON.stringify({
      name: options.packageName,
      "dist-tags": { latest: version },
      versions: { [version]: { name: options.packageName, version, dist } },
    });
    return [200, { "content-type": "application/json" }, body];
  }
  if (path === `${basePath}${tarballPath}`) {
    return [200, { "content-type": "application/octet-stream" }, tarball.bytes];
  }
  return [404, {}];
}

export async function startFunctionalNpmRegistry(
  options: FunctionalNpmRegistryOptions,
): Promise<FunctionalNpmRegistry> {
  const version = options.version ?? "1.0.0";
  const tarball = packTarball(options, version);
  const seen: FunctionalNpmRequest[] = [];
  const counts = new Map<string, number>();
  let base = "";
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    const [status, headers, body] = routeRequest(options, tarball, version, base, request);
    counts.set(String(status), (counts.get(String(status)) ?? 0) + 1);
    response.writeHead(status, headers).end(body);
  };
  const server: Server = createServer(handler);
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", ready);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${options.basePath ?? ""}`;
  return {
    url: base,
    seen,
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
