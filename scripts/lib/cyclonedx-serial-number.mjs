import { createHash } from "node:crypto";

// actions/attest accepts a CycloneDX SBOM only when it carries bomFormat, specVersion and
// serialNumber. The serial number is derived from the rest of the document as an RFC 9562
// name-based UUIDv8 over its SHA-256: a reproducible staging run writes a byte-identical SBOM, and
// any change to the content yields a new serial number. Every writer of an attested portable SBOM
// passes its document through this last, so a rewrite never keeps a stale serial number.
const FORMAT_FIELDS = new Set(["bomFormat", "specVersion", "serialNumber"]);

export function withCyclonedxSerialNumber(document) {
  const { bomFormat, specVersion } = document;
  const rest = Object.fromEntries(
    Object.entries(document).filter(([key]) => !FORMAT_FIELDS.has(key)),
  );
  const bytes = createHash("sha256")
    .update(JSON.stringify({ bomFormat, specVersion, ...rest }))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
  return { bomFormat, specVersion, serialNumber: `urn:uuid:${uuid}`, ...rest };
}
