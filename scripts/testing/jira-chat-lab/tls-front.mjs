// Synthetic local Jira laboratory only. The fixed loopback backend never becomes a general proxy.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requirePrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("Lab TLS file must be regular");
  chmodSync(path, 0o600);
}

export function initializeLabTls(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new TypeError("Lab TLS directory is a symlink");
  const paths = Object.fromEntries(
    ["ca.key", "ca.pem", "server.key", "server.pem"].map((name) => [name, join(directory, name)]),
  );
  if (Object.values(paths).every(existsSync)) {
    Object.values(paths).forEach(requirePrivateFile);
    return paths;
  }
  if (Object.values(paths).some(existsSync)) throw new TypeError("Incomplete lab TLS material");
  const run = (args) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore", timeout: 30_000 });
  createRootCertificate(run);
  createServerCertificate(run, directory);
  Object.values(paths).forEach(requirePrivateFile);
  return paths;
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
    "7",
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
    "7",
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

function forward(req, res, backendPort) {
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
      hostname: "127.0.0.1",
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

export function startLabTlsFront(directory, listenPort = 18443, backendPort = 18080) {
  portNumber(listenPort);
  portNumber(backendPort);
  if (listenPort === backendPort) throw new TypeError("Lab frontend and backend ports must differ");
  const files = initializeLabTls(directory);
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
      forward(req, res, backendPort);
    },
  );
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(listenPort, "127.0.0.1");
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
