// Synthetic local Jira laboratory only. The fixed Jira backend never becomes a general proxy.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requirePrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Lab TLS file must be regular");
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

const PRIVATE_ADDRESS_FILE = "private-address";

/**
 * The one optional extra address the front serves besides loopback (#4369): a private-class address
 * of the lab host, so a private-class Jira URL can be walked live and a Windows guest reaches the
 * lab without a tunnel. Only RFC 1918, link-local and unique-local addresses qualify; loopback, the
 * wildcard and every public address are refused, so the lab never listens beyond the private net.
 */
export function validatePrivateAddress(value) {
  const address = String(value ?? "");
  const kind = isIP(address);
  const private4 = kind === 4 && isPrivateIpv4(address.split(".").map(Number));
  const private6 = kind === 6 && /^f[cd][0-9a-f]{2}:/iu.test(address);
  if (!private4 && !private6) throw new TypeError("Lab private address must be a private-class IP");
  return address;
}

/** RFC 1918 and link-local IPv4: 10/8, 172.16/12, 192.168/16, 169.254/16. */
function isPrivateIpv4([first, second]) {
  if (first === 10) return true;
  if (first === 172) return second >= 16 && second <= 31;
  return (first === 192 && second === 168) || (first === 169 && second === 254);
}

/** The Host header values the front accepts: loopback and, when set, the private address. */
export function allowedLabHosts(listenPort, privateAddress) {
  const hosts = [`localhost:${listenPort}`, `127.0.0.1:${listenPort}`];
  if (privateAddress === undefined) return new Set(hosts);
  const address = validatePrivateAddress(privateAddress);
  hosts.push(isIP(address) === 6 ? `[${address}]:${listenPort}` : `${address}:${listenPort}`);
  return new Set(hosts);
}

/** The private address a session was initialized with, or `undefined` for the loopback default. */
export function readLabPrivateAddress(tlsDirectory) {
  const path = join(tlsDirectory, PRIVATE_ADDRESS_FILE);
  if (!existsSync(path)) return undefined;
  requirePrivateFile(path);
  return validatePrivateAddress(readFileSync(path, "utf8").trim());
}

/** Records the address privately; an empty value keeps the loopback-only default. */
export function writeLabPrivateAddress(tlsDirectory, value) {
  if (value === undefined || value === "") return undefined;
  const address = validatePrivateAddress(value);
  mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(tlsDirectory, PRIVATE_ADDRESS_FILE), `${address}\n`, { mode: 0o600 });
  return address;
}

/** The compose files of a session: the private-address override only when one was recorded. */
export function labComposeFiles(baseFile, overrideFile, tlsDirectory) {
  return readLabPrivateAddress(tlsDirectory) === undefined ? [baseFile] : [baseFile, overrideFile];
}

function coversPrivateAddress(directory, privateAddress) {
  if (privateAddress === undefined) return true;
  try {
    const server = new X509Certificate(readFileSync(join(directory, "server.pem")));
    return server.checkIP(privateAddress) === privateAddress;
  } catch {
    return false;
  }
}

function renewalNeeded(directory, paths, observedAtMs, privateAddress) {
  const present = Object.values(paths).filter((path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
  present.forEach(requirePrivateFile);
  if (present.length !== 4) return true;
  // A certificate issued before the private address was recorded does not name it.
  if (!coversPrivateAddress(directory, privateAddress)) return true;
  try {
    return labTlsRemainingSeconds(directory, observedAtMs) <= 7 * 86_400;
  } catch {
    return true;
  }
}

function replaceCertificates(directory, paths, publishFile, privateAddress) {
  if (!Object.values(paths).some(existsSync)) {
    generateCertificates(directory, privateAddress);
  } else {
    const staging = mkdtempSync(join(directory, "renew-"));
    try {
      generateCertificates(staging, privateAddress);
      for (const [name, path] of Object.entries(paths)) publishFile(join(staging, name), path);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

export function initializeLabTls(
  directory,
  { onRenew = () => undefined, now = Date.now, publishFile = renameSync, privateAddress } = {},
) {
  const extra = privateAddress === undefined ? undefined : validatePrivateAddress(privateAddress);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new TypeError("Lab TLS directory is a symlink");
  const paths = Object.fromEntries(
    ["ca.key", "ca.pem", "server.key", "server.pem"].map((name) => [name, join(directory, name)]),
  );
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new TypeError("Invalid lab TLS clock");
  if (!renewalNeeded(directory, paths, observedAtMs, extra)) return paths;
  replaceCertificates(directory, paths, publishFile, extra);
  // A partial publication is refused now and regenerated as a complete generation on the next start.
  labTlsRemainingSeconds(directory, now());
  onRenew();
  return paths;
}

function generateCertificates(directory, privateAddress) {
  const run = (args) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore", timeout: 30_000 });
  createRootCertificate(run);
  createServerCertificate(run, directory, privateAddress);
  for (const name of ["ca.key", "ca.pem", "server.key", "server.pem"])
    requirePrivateFile(join(directory, name));
}

export function labTlsRemainingSeconds(directory, observedAtMs = Date.now()) {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new TypeError("Invalid lab TLS clock");
  const certificates = ["ca", "server"].map((name) => {
    const path = join(directory, `${name}.pem`);
    const key = join(directory, `${name}.key`);
    requirePrivateFile(path);
    requirePrivateFile(key);
    const certificate = new X509Certificate(readFileSync(path));
    if (
      !certificate.checkPrivateKey(createPrivateKey(readFileSync(key))) ||
      Date.parse(certificate.validFrom) > observedAtMs
    )
      throw new TypeError("Lab TLS identity is invalid");
    return certificate;
  });
  const [ca, server] = certificates;
  if (
    !ca.ca ||
    !ca.verify(ca.publicKey) ||
    !server.verify(ca.publicKey) ||
    server.checkIP("127.0.0.1") !== "127.0.0.1"
  )
    throw new TypeError("Lab TLS chain is invalid");
  return Math.floor(
    (Math.min(...certificates.map((cert) => Date.parse(cert.validTo))) - observedAtMs) / 1000,
  );
}

function createRootCertificate(run) {
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "365",
    "-subj",
    "/CN=Keiko synthetic Jira laboratory CA",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}

function createServerCertificate(run, directory, privateAddress) {
  const names =
    privateAddress === undefined
      ? "DNS:localhost,IP:127.0.0.1"
      : `DNS:localhost,IP:127.0.0.1,IP:${privateAddress}`;
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    "/CN=localhost",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  ]);
  writeFileSync(
    join(directory, "server.ext"),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names}\n`,
    { mode: 0o600 },
  );
  run([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.pem",
    "-days",
    "365",
    "-sha256",
    "-extfile",
    "server.ext",
  ]);
}

function portNumber(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new TypeError("Invalid lab port");
  return port;
}

function forward(req, res, backendPort, compose) {
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
    res.writeHead(400).end();
    return;
  }
  const headers = {
    ...req.headers,
    host: `127.0.0.1:${backendPort}`,
    "x-forwarded-proto": "https",
  };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = request(
    {
      hostname: compose ? "jira" : "127.0.0.1",
      port: backendPort,
      method: req.method,
      path: req.url,
      headers,
      timeout: 30_000,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    },
  );
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2_097_152) upstream.destroy();
  });
  req.on("aborted", () => upstream.destroy());
  upstream.on("timeout", () => upstream.destroy());
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * `privateAddress` (optional) adds one private-class address: the certificate names it, the Host
 * guard accepts it and, outside compose, a second listener serves it. The loopback default is
 * unchanged when it is absent. In compose the published ports decide which addresses are reachable.
 */
export function startLabTlsFront(
  directory,
  listenPort = 18443,
  backendPort = 18080,
  compose = false,
  privateAddress = undefined,
) {
  portNumber(listenPort);
  portNumber(backendPort);
  if (listenPort === backendPort) throw new TypeError("Lab frontend and backend ports must differ");
  const hosts = allowedLabHosts(listenPort, privateAddress);
  const files = compose
    ? { "server.key": join(directory, "server.key"), "server.pem": join(directory, "server.pem") }
    : initializeLabTls(directory, { privateAddress });
  Object.values(files).forEach(requirePrivateFile);
  const options = {
    key: readFileSync(files["server.key"]),
    cert: readFileSync(files["server.pem"]),
    minVersion: "TLSv1.2",
  };
  const handler = (req, res) => {
    if (!hosts.has(req.headers.host)) {
      res.writeHead(421).end();
      return;
    }
    forward(req, res, backendPort, compose);
  };
  const server = createServer(options, handler);
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(listenPort, compose ? "0.0.0.0" : "127.0.0.1");
  if (!compose && privateAddress !== undefined) {
    const extra = createServer(options, handler);
    extra.requestTimeout = server.requestTimeout;
    extra.headersTimeout = server.headersTimeout;
    // A private address the host does not hold must stop the front, never be skipped silently.
    extra.on("error", (error) => server.emit("error", error));
    extra.listen(listenPort, privateAddress);
    const close = server.close.bind(server);
    server.close = (callback) => {
      extra.close();
      return close(callback);
    };
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory)
    throw new TypeError(
      "Usage: tls-front.mjs <private-tls-directory> [listen-port] [backend-port] [compose] [private-address]",
    );
  const server = startLabTlsFront(
    resolve(directory),
    portNumber(process.argv[3] ?? 18443),
    portNumber(process.argv[4] ?? 18080),
    process.argv[5] === "compose",
    process.argv[6] === undefined || process.argv[6] === "" ? undefined : process.argv[6],
  );
  server.on("listening", () =>
    console.log(JSON.stringify({ operation: "jira-lab-tls", ready: true })),
  );
  server.on("error", () => {
    console.error("jira-lab-tls: listener unavailable");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
