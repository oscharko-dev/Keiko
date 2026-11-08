import { expect, it, vi, type Mock } from "vitest";
import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  EMAIL_TEMPLATE_ACTOR,
  emailTemplateFixture,
} from "../../../tests/support/jira-email-template-fixture.js";
import {
  executeJiraEmailTemplateRead,
  executeJiraEmailTemplateMutation as mutate,
  isJiraEmailTemplateMutation,
} from "./jira-managed-email-templates.js";
import type { JiraEmailTemplatePorts } from "./jira-email-template-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { scriptedJiraMutationRequest } from "./jira-test-request/_support.js";

const ACTOR = { ok: true, status: 200, body: EMAIL_TEMPLATE_ACTOR } as const;
const ACK = { ok: true, status: 204, body: undefined } as const;
type EmailScenario = ReturnType<typeof emailTemplateFixture> & {
  request: ReturnType<typeof scriptedJiraMutationRequest>;
  download: Mock<JiraEmailTemplatePorts["download"]>;
  inspect: Mock<JiraEmailTemplatePorts["inspect"]>;
  source: Mock<NonNullable<JiraEmailTemplatePorts["source"]>>;
  upload: Mock<NonNullable<JiraEmailTemplatePorts["upload"]>>;
};
function scenario(): EmailScenario {
  const fixture = emailTemplateFixture();
  const request = scriptedJiraMutationRequest([ACTOR, ACTOR, ACK]);
  const download = vi
    .fn<JiraEmailTemplatePorts["download"]>()
    .mockResolvedValue({ ok: true, status: 200, bytes: fixture.bytes });
  const inspect = vi
    .fn<JiraEmailTemplatePorts["inspect"]>()
    .mockResolvedValue({ ok: true, value: fixture.pack });
  const source = vi.fn<NonNullable<JiraEmailTemplatePorts["source"]>>().mockResolvedValue({
    ok: true,
    content: {
      name: fixture.expectedFile.name,
      bytes: fixture.bytes,
      sha256: fixture.pack.archiveSha256,
    },
  });
  const upload = vi.fn<NonNullable<JiraEmailTemplatePorts["upload"]>>().mockResolvedValue(ACK);
  return { ...fixture, request, download, inspect, source, upload };
}

it("observes complete metadata without exposing template text, URLs or file bytes", async () => {
  const s = scenario();
  const result = await executeJiraEmailTemplateRead({}, s);
  expect(result.data).toEqual({
    outcome: "succeeded",
    selectionScope: "complete-exported-email-template-pack",
    archiveBytes: s.pack.archiveBytes,
    archiveSha256: s.pack.archiveSha256,
    manifestSha256: s.pack.manifestSha256,
    entryCount: 2,
    items: s.pack.entries,
  });
  expect(JSON.stringify(result)).not.toContain("$issue.summary");
  expect(s.request).not.toHaveBeenCalled();
  expect(s.upload).not.toHaveBeenCalled();
});
it.each([
  { path: "elsewhere" },
  { downloadUrl: "https://invalid.example/pack" },
  { includeContent: true },
] as const)("refuses arbitrary export selectors before HTTP", async (args) => {
  const s = scenario();
  expect(await executeJiraEmailTemplateRead(args, s)).toMatchObject({
    isError: true,
    data: { reason: "field-validation" },
  });
  expect(s.download).not.toHaveBeenCalled();
});
it("requires exact inspector provenance instead of trusting an unrelated manifest", async () => {
  const s = scenario();
  s.inspect.mockResolvedValue({ ok: true, value: { ...s.pack, archiveSha256: "f".repeat(64) } });
  expect(await executeJiraEmailTemplateRead({}, s)).toMatchObject({
    isError: true,
    data: { reason: "malformed-payload" },
  });
});
it("sends only the admitted raw ZIP once and retains its hash without claiming staging proof", async () => {
  const s = scenario();
  expect(await mutate("jira.upload-email-template-pack", s.uploadArgs, s)).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: {
      userKey: EMAIL_TEMPLATE_ACTOR.key,
      emailTemplateAction: "upload",
      uploadSha256: s.pack.archiveSha256,
      uploadBytes: s.bytes.byteLength,
    },
  });
  expect(s.source).toHaveBeenCalledWith({
    kind: "connected-file",
    path: "docs/templates.zip",
    maxBytes: JIRA_ATTACHMENT_MAX_BYTES,
    purpose: "jira-email-template-pack",
  });
  expect(s.upload).toHaveBeenCalledExactlyOnceWith(s.bytes);
  expect(s.request.mock.calls).toEqual([["myself", "GET", undefined, "json"]]);
  expect(s.download).not.toHaveBeenCalled();
});
it.each(["name", "size", "hash"])("refuses changed %s before upload", async (kind) => {
  const s = scenario();
  const expectedFile = { ...s.expectedFile };
  if (kind === "name") expectedFile.name = "other.zip";
  if (kind === "size") expectedFile.sizeBytes++;
  if (kind === "hash") expectedFile.sha256 = "f".repeat(64);
  expect(
    await mutate("jira.upload-email-template-pack", { ...s.uploadArgs, expectedFile }, s),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(s.upload).not.toHaveBeenCalled();
});
it("does not use model expectedFile as a source grant", async () => {
  const s = scenario();
  s.source.mockResolvedValue({ ok: false, reason: "conflict" });
  expect(await mutate("jira.upload-email-template-pack", s.uploadArgs, s)).toEqual({
    ok: false,
    reason: "conflict",
  });
  expect(s.upload).not.toHaveBeenCalled();
});
it("copies source bytes before async inspection and uploads that exact owned snapshot", async () => {
  const s = scenario();
  const original = Uint8Array.from(s.bytes);
  s.inspect.mockImplementation(() => {
    s.bytes.fill(0);
    return Promise.resolve({ ok: true, value: s.pack });
  });
  expect(await mutate("jira.upload-email-template-pack", s.uploadArgs, s)).toMatchObject({
    ok: false,
    reason: "unavailable",
  });
  expect(s.upload).toHaveBeenCalledExactlyOnceWith(original);
});
it.each(["jira.apply-email-template-pack", "jira.revert-email-template-pack"] as const)(
  "%s rebinds actor and active data, writes once, then preserves independent observation as unconfirmed",
  async (operation) => {
    const s = scenario();
    const args = operation === "jira.apply-email-template-pack" ? s.applyArgs : s.revertArgs;
    const action = operation === "jira.apply-email-template-pack" ? "apply" : "revert";
    expect(await mutate(operation, args, s)).toMatchObject({
      ok: false,
      reason: "unavailable",
      receipt: {
        userKey: EMAIL_TEMPLATE_ACTOR.key,
        emailTemplateAction: action,
        priorManifestSha256: s.pack.manifestSha256,
        observedManifestSha256: s.pack.manifestSha256,
      },
    });
    expect(s.request.mock.calls).toEqual([
      ["myself", "GET", undefined, "json"],
      ["myself", "GET", undefined, "json"],
      [`email-templates/${action}`, "POST", undefined, "none"],
    ]);
    expect(s.download).toHaveBeenCalledTimes(2);
    expect(s.upload).not.toHaveBeenCalled();
  },
);
it("does not turn an unchanged active export into a no-op or staged identity claim", async () => {
  const s = scenario();
  const result = await mutate("jira.apply-email-template-pack", s.applyArgs, s);
  expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  expect(result).not.toHaveProperty("detail.unchanged");
  expect(result).not.toHaveProperty("receipt.uploadSha256");
  expect(s.request.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it.each(["upload", "apply", "revert"] as const)(
  "preflights %s without a native effect",
  async (action) => {
    const s = scenario();
    const cases = {
      upload: ["jira.upload-email-template-pack", s.uploadArgs],
      apply: ["jira.apply-email-template-pack", s.applyArgs],
      revert: ["jira.revert-email-template-pack", s.revertArgs],
    } as const;
    const [operation, args] = cases[action];
    expect(await mutate(operation, args, s, true)).toMatchObject({
      ok: true,
      receipt: { emailTemplateAction: action },
    });
    expect(s.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    expect(s.upload).not.toHaveBeenCalled();
  },
);
it("refuses changed active content before a global effect", async () => {
  const s = scenario();
  expect(
    await mutate(
      "jira.apply-email-template-pack",
      { ...s.applyArgs, expectedActiveManifestSha256: "a".repeat(64) },
      s,
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(s.request).toHaveBeenCalledTimes(1);
});
it("refuses actor drift on the second read before a global effect", async () => {
  const s = scenario();
  s.request = scriptedJiraMutationRequest([
    ACTOR,
    { ...ACTOR, body: { key: "other-actor", name: "other" } },
  ]);
  expect(await mutate("jira.revert-email-template-pack", s.revertArgs, s)).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  expect(s.request).toHaveBeenCalledTimes(2);
});
it.each(["timeout", "effect-denied", "cancelled", "permission-denied"] as const)(
  "keeps %s after one upload attempt without replay",
  async (reason) => {
    const s = scenario();
    s.upload.mockResolvedValue({ ok: false, reason });
    expect(await mutate("jira.upload-email-template-pack", s.uploadArgs, s)).toMatchObject({
      ok: false,
      reason,
      receipt: { uploadSha256: s.pack.archiveSha256 },
    });
    expect(s.upload).toHaveBeenCalledTimes(1);
  },
);
it("retains acknowledged context when fresh active data cannot be read", async () => {
  const s = scenario();
  s.download
    .mockResolvedValueOnce({ ok: true, status: 200, bytes: s.bytes })
    .mockResolvedValueOnce({ ok: false, reason: "permission-denied" });
  expect(await mutate("jira.apply-email-template-pack", s.applyArgs, s)).toMatchObject({
    ok: false,
    reason: "permission-denied",
    receipt: { priorManifestSha256: s.pack.manifestSha256 },
  });
  expect(s.request.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it("preserves the ACK receipt around a programmer defect during readback", async () => {
  const s = scenario();
  s.download
    .mockResolvedValueOnce({ ok: true, status: 200, bytes: s.bytes })
    .mockRejectedValueOnce(new TypeError("synthetic defect"));
  await expect(mutate("jira.revert-email-template-pack", s.revertArgs, s)).rejects.toBeInstanceOf(
    JiraAcknowledgedMutationError,
  );
  expect(s.request.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it.each([
  ["jira.upload-email-template-pack", { acceptStagedTemplateReplacement: false }],
  ["jira.apply-email-template-pack", { acceptUnverifiedStagedPack: false }],
  ["jira.revert-email-template-pack", { acceptGlobalTemplateChange: false }],
] as const)(
  "requires explicit %s consequences before reading source or native state",
  async (operation, changes) => {
    const s = scenario();
    const inputs: Record<Parameters<typeof mutate>[0], CatalogJsonObject> = {
      "jira.upload-email-template-pack": s.uploadArgs,
      "jira.apply-email-template-pack": s.applyArgs,
      "jira.revert-email-template-pack": s.revertArgs,
    };
    expect(await mutate(operation, { ...inputs[operation], ...changes }, s)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(s.request).not.toHaveBeenCalled();
    expect(s.source).not.toHaveBeenCalled();
  },
);
it("has no arbitrary email or archive operation", () => {
  expect(isJiraEmailTemplateMutation("jira.upload-email-template-pack")).toBe(true);
  expect(isJiraEmailTemplateMutation("jira.send-email")).toBe(false);
});
