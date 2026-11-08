import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { labSessionConnection } from "./lab-client.mjs";

const execute = promisify(execFile);

function publishedPort(container, inside, outside) {
  const published = Object.fromEntries(
    Object.entries(container.NetworkSettings.Ports).filter(([, bindings]) => bindings !== null),
  );
  assert.deepEqual(published, {
    [`${inside}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(outside) }],
  });
}

export function validateServices(session, containers) {
  assert.match(session.project, /^keiko-jira-4081-[a-z0-9-]{1,32}$/u);
  const selected = labSessionConnection(session);
  const services = {};
  for (const container of containers) {
    assert.equal(container.Config.Labels["com.docker.compose.project"], session.project);
    const service = container.Config.Labels["com.docker.compose.service"];
    assert.ok(new Set(["jira", "tls", "database"]).has(service));
    assert.equal(services[service], undefined);
    assert.match(container.Id, /^[a-f0-9]{64}$/u);
    assert.equal(container.State.Running, true);
    services[service] = container;
  }
  assert.equal(Object.keys(services).length, 3);
  assert.equal(services.jira.Config.Image, selected.jiraImage);
  publishedPort(services.jira, 8080, selected.httpPort);
  publishedPort(services.tls, selected.httpsPort, selected.httpsPort);
  assert.deepEqual(services.tls.Config.Cmd, [
    "node",
    "/opt/tls-front.mjs",
    "/tls",
    String(selected.httpsPort),
    "8080",
    "compose",
  ]);
  return services;
}

/** Config.Image alone is a label; bind the running image ID to the selected immutable digest. */
export function validateLabImage(session, container, image) {
  const selected = labSessionConnection(session);
  assert.equal(container.Config.Image, selected.jiraImage);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(container.Image, image.Id);
  assert.ok(Array.isArray(image.RepoDigests));
  const digest = `atlassian/jira-software@sha256:${selected.jiraImageDigest}`;
  assert.ok(image.RepoDigests.some((entry) => entry === digest || entry === `docker.io/${digest}`));
}

export async function labDocker(args) {
  const result = await execute("docker", args, { timeout: 60_000, maxBuffer: 1_048_576 });
  return result.stdout.trim();
}

/** Read-only admission: a foreign Jira is never stopped or shared by this session. */
export async function requireExclusiveLab(session) {
  const running = await labDocker([
    "ps",
    "--filter",
    "label=com.docker.compose.service=jira",
    "--format",
    '{{.Label "com.docker.compose.project"}}',
  ]);
  if (running.split("\n").some((project) => project.length > 0 && project !== session.project))
    throw new TypeError("Another Jira laboratory is running; wait for an exclusive window");
}

export async function inspectServices(session) {
  await requireExclusiveLab(session);
  const ids = (
    await labDocker(["ps", "-q", "--filter", `label=com.docker.compose.project=${session.project}`])
  ).split("\n");
  assert.equal(ids.length, 3);
  const services = validateServices(session, JSON.parse(await labDocker(["inspect", ...ids])));
  const images = JSON.parse(
    await labDocker(["image", "inspect", labSessionConnection(session).jiraImage]),
  );
  assert.equal(images.length, 1);
  validateLabImage(session, services.jira, images[0]);
  return services;
}
