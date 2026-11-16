// Sealed holdout of the MemoriaViva corpus (#4208). A holdout is a part of the corpus that the
// optimizing agent never sees: it is written by a separate session, stored outside the repository and
// encrypted at rest, and only the lab runner opens it, in memory, to report aggregates per class.
//
//   node scripts/testing/memory-lab/corpus/holdout.mjs seal --scenarios <dir> --out <file> \
//        --key-file <path>
//
// The scenario set is encrypted with AES-256-GCM into one file. The key file holds 32 random bytes in
// base64 with mode 0600 and is created when absent. `openHoldout` returns the scenarios in memory and
// never writes plaintext anywhere.
//
// Stated limit: on one development machine this is protection by procedure and encryption at rest,
// not a security boundary against a determined agent with the same user rights. The rule is that an
// optimizing agent never opens the holdout and never reads the key; the runner masks every scenario
// name and writes no scenario text. Rotate the holdout whenever the corpus version changes.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeContinuityJson } from "../../coding-workbench-lab/chat-continuity-campaign.mjs";
import { runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { loadScenarioDirectory, scenarioSetManifest, validateScenario } from "../scenario.mjs";
import { assertOutsideCheckout } from "./paths.mjs";
import { compareStrings } from "../../../lib/compare-strings.mjs";

const FORMAT = "keiko-memory-holdout";
const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const ASSOCIATED_DATA = Buffer.from(`${FORMAT}:${String(VERSION)}`, "utf8");
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class HoldoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "HoldoutError";
  }
}

// The key that masks scenario names is derived from the holdout key, so the encryption key itself
// is never used for a second purpose and never leaves this module.
const MASK_CONTEXT = Buffer.from(`${FORMAT}:mask:v${String(VERSION)}`, "utf8");

function deriveMaskingKey(key) {
  return createHmac("sha256", key).update(MASK_CONTEXT).digest();
}

/**
 * The name a holdout scenario carries in every report: its class, language and a keyed hash of its
 * id (HMAC-SHA256 under `maskingKey`, from `openSealedHoldout`). Scenario ids are short and
 * guessable, so an unkeyed hash of them could be checked against candidate ids; the keyed one cannot.
 */
export function holdoutScenarioName(scenario, maskingKey) {
  if (!Buffer.isBuffer(maskingKey) || maskingKey.length !== KEY_BYTES)
    throw new HoldoutError("a masked scenario name needs the holdout's masking key");
  const digest = createHmac("sha256", maskingKey).update(scenario.id).digest("hex").slice(0, 12);
  return `holdout:${scenario.class}:${scenario.language}:${digest}`;
}

/** The manifest of a holdout set with every scenario id masked; digests are one-way hashes. */
export function holdoutManifest(scenarios, maskingKey) {
  const manifest = scenarioSetManifest(scenarios);
  return {
    ...manifest,
    entries: manifest.entries.map((entry, index) => ({
      ...entry,
      id: holdoutScenarioName(scenarios[index], maskingKey),
    })),
  };
}

function maskedKeys(keys) {
  return keys.map((_, index) => `fact-${String(index + 1)}`);
}

/**
 * The result of one sealed unit as the report may see it: the masked scenario name, probe ids and
 * fact keys replaced by their position, and everything that names a memory or a fact dropped. What
 * remains are verdicts, counts and timings.
 */
export function maskHoldoutResult(result, name) {
  const oracle =
    result.oracle === undefined
      ? {}
      : {
          oracle: {
            seeded: [],
            mismatches: maskedKeys(result.oracle.mismatches),
            preconditionMet: result.oracle.preconditionMet,
          },
        };
  return {
    ...result,
    scenario: name,
    store: {
      ...result.store,
      missing: maskedKeys(result.store.missing),
      verdicts: [],
      memories: [],
    },
    probes: result.probes.map((probe, index) => ({ ...probe, id: `probe-${String(index + 1)}` })),
    ...oracle,
  };
}

// Checkpoints use their own derived key and retain no readable per-unit evidence at rest.
export function holdoutProgressCodec(maskingKey) {
  const key = createHmac("sha256", maskingKey).update("memory-lab-progress-v1").digest();
  return {
    encode: (value) => encrypt(JSON.stringify(value), key),
    decode: (envelope) => JSON.parse(decrypt(envelope, key)),
  };
}

function createKeyFile(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${randomBytes(KEY_BYTES).toString("base64")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function readKey(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new HoldoutError("the key file does not exist");
  }
  if (!stat.isFile()) throw new HoldoutError("the key file must be a regular file");
  if ((stat.mode & 0o077) !== 0)
    throw new HoldoutError("the key file must not be accessible to group or others (mode 0600)");
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== KEY_BYTES) throw new HoldoutError("the key file must hold 32 bytes in base64");
  return key;
}

function encrypt(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(ASSOCIATED_DATA);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(envelope, key) {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(ASSOCIATED_DATA);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HoldoutError("the holdout cannot be opened: wrong key or modified file");
  }
}

/**
 * Encrypts the scenario set of a directory into one file. Creates the key file when it does not
 * exist, refuses paths inside the checkout and refuses to overwrite an existing holdout.
 */
export function sealHoldout({ scenarios, out, keyFile }) {
  // The guard resolves links to judge the destination; the files are then used as spelled, so the
  // key reader still sees, and refuses, a key file that is itself a link.
  assertOutsideCheckout(out, "--out");
  assertOutsideCheckout(keyFile, "--key-file");
  const target = resolve(out);
  const keyPath = resolve(keyFile);
  if (existsSync(target)) throw new HoldoutError("refusing to overwrite an existing holdout");
  const set = loadScenarioDirectory(scenarios);
  if (set.length === 0) throw new HoldoutError("the scenario directory holds no scenario");
  if (!existsSync(keyPath)) createKeyFile(keyPath);
  const envelope = encrypt(JSON.stringify(set), readKey(keyPath));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeContinuityJson(target, envelope);
  return { count: set.length, setDigest: scenarioSetManifest(set).setDigest };
}

function readEnvelope(file) {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new HoldoutError("the holdout file is missing or not a holdout");
  }
  const known =
    envelope?.format === FORMAT &&
    envelope.version === VERSION &&
    envelope.algorithm === ALGORITHM &&
    ["iv", "tag", "data"].every((name) => typeof envelope[name] === "string");
  if (!known) throw new HoldoutError("the holdout file has an unknown format");
  return envelope;
}

/**
 * Opens a sealed holdout in memory and returns its validated scenarios, sorted by id, with the key
 * that masks their names in reports. The plaintext is never written anywhere; a wrong key or a
 * modified file fails without naming any content.
 */
export function openSealedHoldout(file, keyFile) {
  assertOutsideCheckout(file, "--holdout");
  assertOutsideCheckout(keyFile, "--key-file");
  const source = resolve(file);
  const key = readKey(resolve(keyFile));
  const parsed = JSON.parse(decrypt(readEnvelope(source), key));
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new HoldoutError("the holdout holds no scenario");
  const scenarios = parsed.map((scenario) => validateScenario(scenario));
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length)
    throw new HoldoutError("the holdout holds two scenarios with one id");
  return {
    scenarios: scenarios.toSorted((left, right) => compareStrings(left.id, right.id)),
    maskingKey: deriveMaskingKey(key),
  };
}

/** The scenarios of a sealed holdout, opened in memory. */
export function openHoldout(file, keyFile) {
  return openSealedHoldout(file, keyFile).scenarios;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scenarios: { type: "string" },
      out: { type: "string" },
      "key-file": { type: "string" },
    },
  });
  if (positionals[0] !== "seal" || !values.scenarios || !values.out || !values["key-file"])
    throw new RangeError(
      "usage: holdout.mjs seal --scenarios <dir> --out <file> --key-file <path>",
    );
  const sealed = sealHoldout({
    scenarios: resolve(values.scenarios),
    out: values.out,
    keyFile: values["key-file"],
  });
  console.log(
    `PASS memory-lab-holdout sealed=${String(sealed.count)} setDigest=${sealed.setDigest}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
