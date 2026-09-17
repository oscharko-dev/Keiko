import { URL } from "node:url";

const registryProbeConnectTimeoutSeconds = 15;
const registryProbeMaxTimeSeconds = 60;

export function registryVersionEndpoint(pkg, registry) {
  const registryUrl = new URL(registry);
  const prefix = registryUrl.pathname.endsWith("/")
    ? registryUrl.pathname
    : `${registryUrl.pathname}/`;
  const packagePath = pkg.name.split("/").map(encodeURIComponent).join("/");
  registryUrl.pathname = `${prefix}${packagePath}/${encodeURIComponent(pkg.version)}`;
  registryUrl.search = "";
  registryUrl.hash = "";
  return registryUrl.toString();
}

export function registryVersionProbeArgs(pkg, registry) {
  return [
    "--silent",
    "--show-error",
    "--location",
    "--connect-timeout",
    String(registryProbeConnectTimeoutSeconds),
    "--max-time",
    String(registryProbeMaxTimeSeconds),
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    registryVersionEndpoint(pkg, registry),
  ];
}

function transientRegistryHttpStatus(status) {
  const code = Number(status);
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

export function classifyRegistryVersionResult(pkg, result) {
  if (result.error !== undefined) {
    return { kind: "transient", reason: "spawn-error", version: "" };
  }
  if (result.status !== 0) {
    return {
      kind: "transient",
      reason: `curl-exit-${String(result.status ?? "unknown")}`,
      version: "",
    };
  }
  const status = result.stdout.trim();
  if (status === "200") return { kind: "available", version: pkg.version };
  if (status === "404") return { kind: "missing", version: "" };
  if (transientRegistryHttpStatus(status)) {
    return { kind: "transient", reason: `http-${status}`, version: "" };
  }
  return {
    kind: "fatal",
    message: `${pkg.spec} registry version endpoint returned HTTP ${status}.`,
    version: "",
  };
}

export function classifyDistTagResult(result) {
  if (result.error !== undefined) {
    return { kind: "transient", reason: "spawn-error", version: "" };
  }
  if (result.status === 0) {
    const version = result.stdout.trim();
    return version === "" ? { kind: "missing", version } : { kind: "available", version };
  }
  const viewOutput = `${result.stdout}\n${result.stderr}`;
  if (viewOutput.includes("E404") || viewOutput.includes("No match found")) {
    return { kind: "missing", version: "" };
  }
  return {
    kind: "transient",
    reason: `npm-exit-${String(result.status ?? "unknown")}`,
    version: "",
  };
}

export function resolveVersionExistence({ attempts, onPending, read, wait }) {
  let observation = read();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (observation.kind === "available") return { exists: true, observation };
    if (observation.kind === "missing") return { exists: false, observation };
    if (attempt < attempts) {
      onPending(observation, attempt);
      wait();
      observation = read();
    }
  }
  return { exists: undefined, observation };
}

export function verificationSucceeded(pkg, state) {
  return (
    state.version.kind === "available" &&
    state.version.version === pkg.version &&
    state.tag.kind === "available" &&
    state.tag.version === pkg.version
  );
}

export function verificationObservation(result) {
  return result.version || result.reason || result.kind;
}

export function verificationFailure(pkg, state, registry, tag) {
  if (state.version.kind !== "available" || state.version.version !== pkg.version) {
    const observed = verificationObservation(state.version);
    if (state.version.kind === "transient") {
      return (
        `${pkg.spec} registry availability remained transient after the bounded verification ` +
        `budget (observed ${observed}). Re-run the governed release verification; do not ` +
        "publish again or change deployment state while package existence is unknown."
      );
    }
    return (
      `${pkg.spec} is not available in ${registry} after publish (observed ${observed}). ` +
      "npm Trusted Publishing may still be clearing server-side quarantine; wait for the " +
      "version-specific registry endpoint to return HTTP 200, then re-run release verification."
    );
  }
  if (state.tag.kind !== "available" || state.tag.version !== pkg.version) {
    const observed = verificationObservation(state.tag);
    return (
      `${pkg.name}@${tag} points to ${observed}, expected ${pkg.version}. ` +
      "If the version endpoint is visible but the tag remains stale, run the governed release " +
      "orchestrator from the exact tagged commit with an operator-held npm token and the original " +
      "qualified release inputs; otherwise wait and re-run verification."
    );
  }
  return undefined;
}

export function waitForVerifiedPackageState({ attempts, onPending, pkg, read, wait }) {
  let state = read();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (verificationSucceeded(pkg, state)) return state;
    if (attempt < attempts) {
      onPending(state, attempt);
      wait();
      state = read();
    }
  }
  return state;
}

export function resolveDistTagAction({ currentTag, hasToken, pkg, verify }) {
  if (currentTag.kind === "available" && currentTag.version === pkg.version) {
    return { kind: "verified" };
  }
  if (!hasToken || currentTag.kind === "transient") {
    const state = verify();
    if (verificationSucceeded(pkg, state)) return { kind: "verified" };
    if (!hasToken || state.version.kind !== "available" || state.tag.kind === "transient") {
      return { kind: "failed", state };
    }
  }
  return { kind: "repair" };
}
