import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { labSessionConnection } from "./lab-client.mjs";
import { readLabPrivateAddress } from "./tls-front.mjs";

const execute = promisify(execFile);

/** The loopback binding, plus the one recorded private address when the session has one (#4369). */
function publishedPort(container, inside, outside, privateAddress) {
  const published = Object.fromEntries(
    Object.entries(container.NetworkSettings.Ports).filter(([, bindings]) => bindings !== null),
  );
  const byAddress = (left, right) => left.HostIp.localeCompare(right.HostIp);
  const expected = ["127.0.0.1", ...(privateAddress === undefined ? [] : [privateAddress])]
    .map((HostIp) => ({ HostIp, HostPort: String(outside) }))
    .sort(byAddress);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(published).map(([key, list]) => [key, [...list].sort(byAddress)]),
    ),
    { [`${inside}/tcp`]: expected },
  );
}

export function validateServices(session, containers, privateAddress = undefined) {
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
  publishedPort(services.tls, selected.httpsPort, selected.httpsPort, privateAddress);
  assert.deepEqual(services.tls.Config.Cmd, [
    "node",
    "/opt/tls-front.mjs",
    "/tls",
    String(selected.httpsPort),
    "8080",
    "compose",
    ...(privateAddress === undefined ? [] : [privateAddress]),
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

/**
 * Read-only admission: a foreign Jira is never stopped or shared by this session. Separate
 * sessions own separate projects, ports and licenses, so an operator may run them side by side
 * with the exact `KEIKO_JIRA_LAB_PARALLEL=allow`, for example the model-free API qualification
 * beside one model-driven run. Docker must still answer; any other value keeps the window exclusive.
 */
export async function requireExclusiveLab(session) {
  const running = await labDocker([
    "ps",
    "--filter",
    "label=com.docker.compose.service=jira",
    "--format",
    '{{.Label "com.docker.compose.project"}}',
  ]);
  if (process.env.KEIKO_JIRA_LAB_PARALLEL === "allow") return;
  if (running.split("\n").some((project) => project.length > 0 && project !== session.project))
    throw new TypeError("Another Jira laboratory is running; wait for an exclusive window");
}

/**
 * Containers of this session whose network no longer exists (Docker removes unused networks, also
 * those of stopped lab stacks). Such a stack cannot start: its containers still name the removed
 * network. Returns the container names with the missing network's name, or an empty list.
 */
export async function containersOfMissingNetwork(session, docker = labDocker) {
  const ids = (
    await docker([
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${session.project}`,
    ])
  )
    .split("\n")
    .filter((id) => id.length > 0);
  if (ids.length === 0) return [];
  const existing = new Set(
    (await docker(["network", "ls", "-q", "--no-trunc"])).split("\n").filter((id) => id.length > 0),
  );
  // A reading Docker does not answer in JSON is no diagnosis: `compose up` then reports its own error.
  let inspected;
  try {
    inspected = JSON.parse(await docker(["inspect", ...ids]));
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  return inspected.flatMap((container) =>
    Object.entries(container.NetworkSettings?.Networks ?? {})
      .filter(([, network]) => !existing.has(network.NetworkID))
      .map(([network]) => ({ container: String(container.Name).replace(/^\//u, ""), network })),
  );
}

/** What to do about a stopped stack whose network was removed: nothing is lost, the volumes hold the state. */
export const MISSING_NETWORK_REMEDY =
  "Docker removed the network of this stopped laboratory (an unused-network prune). Its data is in the named volumes. " +
  "Save `docker inspect` of exactly the containers listed, `docker rm` exactly those containers (never with -v, never a volume, never a prune), " +
  "then run the session start again: it recreates them on a new network.";

export async function inspectServices(session) {
  await requireExclusiveLab(session);
  const ids = (
    await labDocker(["ps", "-q", "--filter", `label=com.docker.compose.project=${session.project}`])
  ).split("\n");
  assert.equal(ids.length, 3);
  const services = validateServices(
    session,
    JSON.parse(await labDocker(["inspect", ...ids])),
    readLabPrivateAddress(join(session.directory, "secrets", "tls")),
  );
  const images = JSON.parse(
    await labDocker(["image", "inspect", labSessionConnection(session).jiraImage]),
  );
  assert.equal(images.length, 1);
  validateLabImage(session, services.jira, images[0]);
  return services;
}
