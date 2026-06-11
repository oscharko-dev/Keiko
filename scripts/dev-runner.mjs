import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(repoRoot, "packages", "keiko-ui");
const requireFromUi = createRequire(join(uiDir, "package.json"));

const host = "127.0.0.1";
const publicPort = Number(process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT ?? "1983");
const bffPort = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
const nextPort = Number(process.env.KEIKO_DEV_NEXT_PORT ?? "3000");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = resolve(process.env.KEIKO_DEV_PID_FILE ?? join(stateDir, "dev-ui.pid.json"));
const bffScript = join(repoRoot, "scripts", "dev-bff.mjs");
const nextBin = requireFromUi.resolve("next/dist/bin/next");
const children = new Set();
let server;
let shuttingDown = false;

function writeState(extra = {}) {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(
    pidFile,
    `${JSON.stringify(
      {
        runnerPid: process.pid,
        publicPort,
        bffPort,
        nextPort,
        children: Array.from(children)
          .map((child) => child.pid)
          .filter((pid) => pid !== undefined),
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function spawnChild(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });
  children.add(child);
  writeState();
  child.on("exit", (code, signal) => {
    children.delete(child);
    writeState({ lastExit: { label, code, signal } });
    if (!shuttingDown) {
      console.error(`[dev] ${label} exited unexpectedly.`);
      shutdown(1);
    }
  });
  child.on("error", (error) => {
    console.error(`[dev] ${label} failed: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function proxyHttp(req, res, targetPort) {
  const headers = { ...req.headers, host: `${host}:${String(targetPort)}` };
  const upstream = request(
    {
      hostname: host,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("Development upstream is not available.");
  });
  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, targetPort) {
  const upstream = connect(targetPort, host, () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === "host") continue;
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) upstream.write(`${name}: ${item}\r\n`);
    }
    upstream.write(`host: ${host}:${String(targetPort)}\r\n`);
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const destroyTunnel = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyTunnel);
  socket.on("error", destroyTunnel);
}

function targetPortFor(pathname) {
  return pathname.startsWith("/api/") || pathname === "/api" ? bffPort : nextPort;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.close(() => undefined);
  for (const child of children) {
    if (child.pid !== undefined) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.pid !== undefined) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 5_000).unref();
  if (children.size === 0) process.exit(code);
}

spawnChild("bff", process.execPath, [bffScript], {
  cwd: repoRoot,
  env: {
    KEIKO_DEV_BFF_PORT: String(bffPort),
    KEIKO_STATE_DIR: stateDir,
  },
});

spawnChild(
  "next",
  process.execPath,
  [nextBin, "dev", "--hostname", host, "--port", String(nextPort)],
  {
    cwd: uiDir,
    env: {
      PORT: String(nextPort),
    },
  },
);

server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${String(publicPort)}`);
  proxyHttp(req, res, targetPortFor(url.pathname));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${host}:${String(publicPort)}`);
  proxyUpgrade(req, socket, head, targetPortFor(url.pathname));
});

server.listen(publicPort, host, () => {
  writeState({ ready: true });
  console.log(`[dev] listening on http://${host}:${String(publicPort)}`);
});

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
