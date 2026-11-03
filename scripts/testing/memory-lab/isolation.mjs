// Isolation rules of the MemoriaViva lab (#4207): what a run may touch and what it must keep to
// itself. Real conversation text never leaves the machine and never stays in a kept database; the
// measured product only talks to models on this machine; the measured product is the one the
// operator named. Each rule is a small pure check the runner applies before an instance starts, so a
// violation is refused up front and is never mistaken for a failed unit of the measurement.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

/**
 * A refusal of the operator's configuration (a provider outside this machine, an environment the
 * repository `.env` would change). It aborts the run: no unit of the measurement can succeed, so it
 * must not be recorded as one unit failure among many.
 */
export class LabConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LabConfigurationError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REAL_TEXT_CLASS_PREFIX = "anchor-";
const REAL_CONVERSATION_CLASS = "anchor-real";

function hostOf(provider) {
  try {
    return new URL(provider?.baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function readConfigText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new LabConfigurationError(
      `the gateway configuration cannot be read (${String(error?.code ?? "error")})`,
    );
  }
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new LabConfigurationError("the gateway configuration is not valid JSON");
  }
}

/**
 * Reads the gateway configuration a live run points the product at and refuses it unless every
 * provider it names (not only the two models of the run: the product probes each configured
 * provider at start) lies on this machine: host 127.0.0.1, localhost or ::1. Everything a run reads
 * and writes stays on the machine, so a provider elsewhere would receive the conversations. Returns
 * the SHA-256 of the file's bytes, which the manifest records as the run's `configDigest`.
 */
export function assertLoopbackGatewayConfig(path) {
  const text = readConfigText(path);
  const providers = parseConfig(text)?.providers;
  if (!Array.isArray(providers) || providers.length === 0)
    throw new LabConfigurationError("the gateway configuration names no provider");
  const remote = providers.filter((provider) => !LOOPBACK_HOSTS.has(hostOf(provider)));
  if (remote.length > 0) {
    const names = remote.map((provider) => String(provider?.modelId ?? "unnamed")).join(", ");
    throw new LabConfigurationError(
      `the gateway configuration names ${String(remote.length)} provider(s) outside this machine (${names}); a run talks to 127.0.0.1, localhost or ::1 only`,
    );
  }
  return { digest: createHash("sha256").update(text).digest("hex") };
}

/**
 * A long live run starts one instance per unit, and each reads the configuration file afresh. The
 * file is therefore checked again before every instance: it must still be loopback-only and still
 * the file whose digest the manifest records, or a provider added half way through would receive the
 * conversations of every later unit.
 */
export function assertGatewayConfigUnchanged(path, digest) {
  if (assertLoopbackGatewayConfig(path).digest !== digest)
    throw new LabConfigurationError(
      "the gateway configuration changed while the run was in progress",
    );
}

/** True for a scenario whose text comes from the real-conversation anchor (#4208). */
export function isAnchorScenario(scenario) {
  return scenario.class.startsWith(REAL_TEXT_CLASS_PREFIX);
}

/**
 * Bodies are retained only when the run asks for it, and never for anchor text unless the run is
 * the labelling pass (`labelPass`, `--label-pass`): the one run that writes real text into its run
 * files so that a person can label what the product stored (anchor/label.mjs), into a private
 * directory outside every work tree. A forgotten `--no-retain-bodies` therefore cannot leak it.
 */
export function retainBodiesFor(scenario, retainBodies, labelPass = false) {
  if (retainBodies !== true) return false;
  return !isAnchorScenario(scenario) || labelPass === true;
}

/**
 * `--keep` leaves every instance's chat database on disk, and a real conversation would stay in it
 * as plain text. A run over real conversations therefore never keeps instance state.
 */
export function assertKeepAllowed(scenarios, keep) {
  if (keep !== true) return;
  if (scenarios.some((scenario) => scenario.class === REAL_CONVERSATION_CLASS))
    throw new RangeError(
      "--keep cannot be combined with real-conversation scenarios (class anchor-real): the kept instance state would hold the real text",
    );
}
