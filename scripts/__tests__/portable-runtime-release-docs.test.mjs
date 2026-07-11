import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contractPath = "docs/release/portable-runtime-artifact-contract.md";
const workflowPath = "docs/release/release-publish-workflow.md";
const contract = readFileSync(contractPath, "utf8");
const workflow = readFileSync(workflowPath, "utf8");
const approvals = JSON.parse(readFileSync("portable-runtime-approvals.json", "utf8"));

function embeddedManifest() {
  const section = contract.slice(contract.indexOf("## Manifest Schema Draft"));
  const match = /```json\n([\s\S]*?)\n```/u.exec(section);
  if (match?.[1] === undefined) throw new Error("portable manifest example is missing");
  return JSON.parse(match[1]);
}

describe("portable runtime release documentation", () => {
  it("distinguishes portable manifest v1 from sidecar approval v2", () => {
    const manifest = embeddedManifest();
    const documented = manifest.sidecarRuntimes[0];
    const approved = approvals.sidecarRuntimes[0];

    expect(manifest.schemaVersion).toBe(1);
    expect(documented.approvalSchemaVersion).toBe(2);
    expect(documented.upstream).toEqual(approved.upstream);
    expect(documented.adapterCompatibility).toEqual(approved.adapterCompatibility);
    expect(documented.protocolSchema).toEqual(approved.protocolSchema);
    expect(documented.releaseApproval).toEqual(approved.releaseApproval);
    expect(documented.license).toEqual(approved.license);
    expect(documented.license.sha256).toBe(documented.licenseEvidence.sha256);
    expect(documented.executableTreeAlgorithm).toBe(approved.executableTreeAlgorithm);
    expect(documented.executableTreeSha256).toBe(
      approved.archives[documented.platformTarget].executableTreeSha256,
    );
  });

  it("removes the fictional sidecar protocol and records raw HTTP/SSE schema provenance", () => {
    const releaseDocs = `${contract}\n${workflow}`;

    expect(releaseDocs).not.toContain("coding-sidecar-v1");
    expect(releaseDocs).toContain("http-sse");
    expect(releaseDocs).toContain("upstream-raw-bytes");
    expect(releaseDocs).toContain(
      "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
    );
    expect(releaseDocs).toContain("474abdd7ee60f4b67476cfcef7e5311beff4a824");
  });

  it("documents closed redistribution and whole-product promotion boundaries", () => {
    const approvedNames = approvals.sidecarRuntimes.map((runtime) => runtime.name);
    const releaseDocs = `${contract}\n${workflow}`;

    expect(approvedNames).not.toContain("codex");
    expect(releaseDocs).toContain("Codex is absent");
    expect(releaseDocs).toContain("redistribution-unapproved");
    expect(releaseDocs).toContain("no global-install fallback");
    expect(releaseDocs).toContain("Whole-product crash-safe promotion");
    expect(releaseDocs).toContain("no independent promotion");
    expect(releaseDocs).toContain("no independent sidecar update, rollback, or downgrade");
  });
});
