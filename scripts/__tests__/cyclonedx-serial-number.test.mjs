import { describe, expect, it } from "vitest";

import { withCyclonedxSerialNumber } from "../lib/cyclonedx-serial-number.mjs";

// actions/attest (v4.2.0, the pinned SHA f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6, src/sbom.ts)
// accepts a CycloneDX SBOM only when bomFormat, serialNumber and specVersion are all present. The
// portable SBOM carried no serialNumber, so the first stable tag run that reached "Attest SBOM for
// windows-x64 portable artifact" (run 34828847044, 2026-09-14) failed with "Unsupported SBOM format.
// Must be valid SPDX or CycloneDX JSON.".

// CycloneDX 1.6 JSON schema, properties.serialNumber.pattern.
const CYCLONEDX_SERIAL_NUMBER =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function portableSbom(sha256 = "a".repeat(64)) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [
      {
        type: "application",
        "bom-ref": "keiko-runtime-supervisor",
        name: "keiko-runtime-supervisor",
        hashes: [{ alg: "SHA-256", content: sha256 }],
      },
    ],
  };
}

describe("withCyclonedxSerialNumber", () => {
  it("gives the SBOM every field actions/attest requires to accept CycloneDX", () => {
    const sbom = withCyclonedxSerialNumber(portableSbom());

    expect(Boolean(sbom.bomFormat && sbom.serialNumber && sbom.specVersion)).toBe(true);
    expect(sbom.serialNumber).toMatch(CYCLONEDX_SERIAL_NUMBER);
  });

  it("derives an RFC 9562 name-based UUIDv8, so staging stays reproducible", () => {
    const first = withCyclonedxSerialNumber(portableSbom());
    const second = withCyclonedxSerialNumber(portableSbom());
    const uuid = first.serialNumber.slice("urn:uuid:".length);

    expect(second).toStrictEqual(first);
    expect(uuid[14]).toBe("8");
    expect(["8", "9", "a", "b"]).toContain(uuid[19]);
  });

  it("changes the serial number when the components change", () => {
    expect(withCyclonedxSerialNumber(portableSbom("b".repeat(64))).serialNumber).not.toBe(
      withCyclonedxSerialNumber(portableSbom()).serialNumber,
    );
  });

  it("re-derives from the content, ignoring a serial number already in the document", () => {
    const derived = withCyclonedxSerialNumber(portableSbom());
    const stale = { ...derived, serialNumber: "urn:uuid:00000000-0000-8000-8000-000000000000" };

    expect(withCyclonedxSerialNumber(stale)).toStrictEqual(derived);
    expect(withCyclonedxSerialNumber(derived)).toStrictEqual(derived);
  });

  it("keeps the document fields and puts the serial number beside the format", () => {
    const sbom = withCyclonedxSerialNumber(portableSbom());

    expect(Object.keys(sbom)).toStrictEqual([
      "bomFormat",
      "specVersion",
      "serialNumber",
      "version",
      "components",
    ]);
    expect(sbom.components).toStrictEqual(portableSbom().components);
  });
});
