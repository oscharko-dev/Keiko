// An offline backup of this disposable session only. Never starts or restores any service.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSession } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import { inspectServices } from "./lab-services.mjs";

export async function snapshotFileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  assert.ok(bytes > 0, "A snapshot must contain actual backup bytes");
  return { bytes, sha256: hash.digest("hex") };
}
async function privateDockerOutput(args, path) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", descriptor, "ignore"],
        timeout: 600_000,
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new TypeError("Owned snapshot command failed")),
      );
    });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return snapshotFileDigest(path);
}

export async function snapshotQualificationSession(session) {
  // Reuse the existing image, labels, published-port and peer ownership admission.
  const services = await inspectServices(session);
  const id = randomUUID();
  const directory = join(session.directory, `api-snapshot-${id}`);
  const pending = join(session.directory, "api-snapshot.pending.json");
  privateJson(pending, { id, phase: "stop-may-have-started", reconcileBeforeRetry: true }, true);
  mkdirSync(directory, { mode: 0o700 });
  // Stop the sole writer before either snapshot. The database stays up solely for pg_dump.
  execFileSync("docker", ["stop", "--time", "60", services.tls.Id, services.jira.Id], {
    stdio: "ignore",
    timeout: 150_000,
  });
  const database = await privateDockerOutput(
    [
      "exec",
      services.database.Id,
      "pg_dump",
      "-U",
      "jira",
      "-d",
      "jira",
      "--format=custom",
      "--no-owner",
      "--no-acl",
    ],
    join(directory, "database.dump"),
  );
  const jiraHome = await privateDockerOutput(
    ["cp", `${services.jira.Id}:/var/atlassian/application-data/jira/.`, "-"],
    join(directory, "jira-home.tar"),
  );
  const record = {
    schemaVersion: 1,
    id,
    project: session.project,
    jiraVersion: session.jiraVersion,
    jiraImageDigest: session.jiraImageDigest,
    servicesStopped: true,
    database,
    jiraHome,
  };
  privateJson(join(directory, "snapshot.json"), record, true);
  rmSync(pending);
  return record;
}

export async function requireQualificationSnapshot(session, id) {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const directory = join(session.directory, `api-snapshot-${id}`);
  const { readPrivateFile } = await import("./lab-client.mjs");
  const record = JSON.parse(readPrivateFile(join(directory, "snapshot.json")));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, id);
  assert.equal(record.project, session.project);
  assert.equal(record.jiraVersion, session.jiraVersion);
  assert.equal(record.jiraImageDigest, session.jiraImageDigest);
  assert.equal(record.servicesStopped, true);
  for (const [name, proof] of [
    ["database.dump", record.database],
    ["jira-home.tar", record.jiraHome],
  ]) {
    const stat = lstatSync(join(directory, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o077, 0);
    assert.deepEqual(await snapshotFileDigest(join(directory, name)), proof);
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length)
      throw new TypeError("Usage: api-qualification-snapshot.mjs <private-session>");
    const record = await snapshotQualificationSession(loadSession(directory));
    console.log(
      JSON.stringify({
        operation: "jira-api-qualification-snapshot",
        completed: true,
        snapshotId: record.id,
        files: 2,
        servicesStopped: true,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        operation: "jira-api-qualification-snapshot",
        completed: false,
        errorType: error instanceof Error ? error.name : "unknown",
        reconcileRequired: true,
      }),
    );
    process.exitCode = 1;
  }
}
