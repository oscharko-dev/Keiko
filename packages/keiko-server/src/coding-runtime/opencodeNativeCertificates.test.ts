import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { afterEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { nativeCertificateReadFilesField } from "./opencodeNativeCertificates.js";

describe("nativeCertificateReadFilesField (#4271)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-certs-")));
    created.push(root);
    mkdirSync(join(root, "PRIVATE_CERTS"), { recursive: true });
    writeFileSync(join(root, "PRIVATE_CERTS", "corporate-ca.pem"), "synthetic\n");
    return root;
  }

  function sink(): { readonly events: ServerLogEvent[]; write(event: ServerLogEvent): void } {
    const events: ServerLogEvent[] = [];
    return { events, write: (event) => events.push(event) };
  }

  it("names the operator's certificate file for the kernel profile and records counts only", () => {
    const root = tree();
    const file = join(root, "PRIVATE_CERTS", "corporate-ca.pem");
    const log = sink();
    const field = nativeCertificateReadFilesField(
      log,
      "run-certs-0001",
      { SSL_CERT_FILE: file, NODE_EXTRA_CA_CERTS: join(root, "PRIVATE_CERTS", "missing.pem") },
      join(root, "home"),
    );
    expect(field).toEqual({ certificateReadFiles: [file] });
    expect(log.events).toHaveLength(1);
    expect(JSON.stringify(log.events[0])).not.toContain("PRIVATE_CERTS");
    const line = expectActivityLogProof(
      "coding-runtime.native-certificates.admitted.emitted-line",
      formatActivityLogProofLine(log.events[0] ?? {}),
    );
    expect(line).toMatchObject({
      op: "coding-runtime.native-certificates.admitted",
      level: "info",
      correlationId: "run-certs-0001",
      namedCount: 2,
      admittedCount: 1,
      fileCount: 1,
    });
  });

  it("adds no field and still records the launch when no certificate variable is set", () => {
    const root = tree();
    const log = sink();
    expect(nativeCertificateReadFilesField(log, "run-certs-0002", {}, join(root, "home"))).toEqual(
      {},
    );
    expect(log.events[0]).toMatchObject({
      op: "coding-runtime.native-certificates.admitted",
      correlationId: "run-certs-0002",
      extra: { namedCount: 0, admittedCount: 0, fileCount: 0 },
    });
  });
});
