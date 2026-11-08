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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requirePrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Lab TLS file must be regular");
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

function renewalNeeded(directory, paths, observedAtMs) {
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
  try {
    return labTlsRemainingSeconds(directory, observedAtMs) <= 7 * 86_400;
  } catch {
    return true;
  }
}

function replaceCertificates(directory, paths, publishFile) {
  if (!Object.values(paths).some(existsSync)) {
    generateCertificates(directory);
  } else {
    const staging = mkdtempSync(join(directory, "renew-"));
    try {
      generateCertificates(staging);
      for (const [name, path] of Object.entries(paths)) publishFile(join(staging, name), path);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

export function initializeLabTls(
  directory,
  { onRenew = () => undefined, now = Date.now, publishFile = renameSync } = {},
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new TypeError("Lab TLS directory is a symlink");
  const paths = Object.fromEntries(
    ["ca.key", "ca.pem", "server.key", "server.pem"].map((name) => [name, join(directory, name)]),
  );
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new TypeError("Invalid lab TLS clock");
  if (!renewalNeeded(directory, paths, observedAtMs)) return paths;
  replaceCertificates(directory, paths, publishFile);
  // A partial publication is refused now and regenerated as a complete generation on the next start.
  labTlsRemainingSeconds(directory, now());
  onRenew();
  return paths;
}

function generateCertificates(directory) {
  const run = (args) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore", timeout: 30_000 });
  createRootCertificate(run);
  createServerCertificate(run, directory);
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

function createServerCertificate(run, directory) {
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
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
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

export function startLabTlsFront(
  directory,
  listenPort = 18443,
  backendPort = 18080,
  compose = false,
) {
  portNumber(listenPort);
  portNumber(backendPort);
  if (listenPort === backendPort) throw new TypeError("Lab frontend and backend ports must differ");
  const files = compose
    ? { "server.key": join(directory, "server.key"), "server.pem": join(directory, "server.pem") }
    : initializeLabTls(directory);
  Object.values(files).forEach(requirePrivateFile);
  const server = createServer(
    {
      key: readFileSync(files["server.key"]),
      cert: readFileSync(files["server.pem"]),
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      if (!new Set([`localhost:${listenPort}`, `127.0.0.1:${listenPort}`]).has(req.headers.host)) {
        res.writeHead(421).end();
        return;
      }
      forward(req, res, backendPort, compose);
    },
  );
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(listenPort, compose ? "0.0.0.0" : "127.0.0.1");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory)
    throw new TypeError(
      "Usage: tls-front.mjs <private-tls-directory> [listen-port] [backend-port]",
    );
  const server = startLabTlsFront(
    resolve(directory),
    portNumber(process.argv[3] ?? 18443),
    portNumber(process.argv[4] ?? 18080),
    process.argv[5] === "compose",
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
