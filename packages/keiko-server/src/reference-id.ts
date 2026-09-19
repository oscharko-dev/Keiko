// Ids a client persists as a reference: chat ids, PR description proposal ids and Figma snapshot
// run ids (#3557 review).
//
// Every value a browser persists in its workspace snapshot passes the shared secret-shape heuristic,
// with no exemption: shape alone never proves where a value came from. That heuristic's
// payment-card rule reads the digits across a random UUID's last hyphen as a Luhn-valid card
// number for about 2 in 10,000 ids, so such an id was redacted at persistence, and a restored
// window could never find its target again. The server owns these ids, so it draws only ids the
// heuristic never flags, and the client needs no exemption.

import { randomUUID } from "node:crypto";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/runtime/memory";

// A flagged draw has a probability of about 2e-4, so 32 consecutive ones never happen by chance;
// reaching the bound means the random source is broken, which must fail loudly.
const MAX_REFERENCE_ID_DRAWS = 32;

/** A random v4 UUID that the shared secret-shape heuristic does not flag, even after `prefix`. */
export function newReferenceId(prefix = "", draw: () => string = randomUUID): string {
  for (let attempt = 0; attempt < MAX_REFERENCE_ID_DRAWS; attempt += 1) {
    const id = `${prefix}${draw()}`;
    if (!looksLikeSecretShape(id)) return id;
  }
  throw new Error("No reference id outside the secret-shape heuristic was drawn.");
}
