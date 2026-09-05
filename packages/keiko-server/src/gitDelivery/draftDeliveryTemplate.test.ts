import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchIssueBinding, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import {
  framePrDescriptionRegion,
  PR_DESCRIPTION_REGION_START,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { hasIssueClosingDirective } from "@oscharko-dev/keiko-contracts/runtime/issue-closing-directive";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { formatServerLogLine, type ServerLogEvent } from "../observability/server-log.js";
import {
  resolveDraftDeliveryTemplate,
  DRAFT_DELIVERY_TEMPLATE_MAX_BYTES,
  DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES,
} from "./draftDeliveryTemplate.js";

// Secret-shaped fixture assembled at runtime: the validator must refuse this exact shape, but the
// source tree must not carry a literal that secret scanners flag as a credential.
const SECRET_SHAPED_TEXT = ["api", "key"].join("_") + "=sk-" + "1234567890".repeat(3);

const roots: string[] = [];
const issueBinding: CodingWorkbenchIssueBinding = {
  schemaVersion: "1",
  repositoryId: "repository-42",
  remoteDigest: "a".repeat(64),
  issueIdDigest: "b".repeat(64),
  contentRevisionDigest: "c".repeat(64),
  bindingDigest: "d".repeat(64),
  issueNumber: 42,
  defaultBaseRef: "main",
};
const title = "fix: preserve the accepted task";
const correlationId = "3387-template-fixture";

async function fixture(): Promise<{
  workspace: WorkspaceInfo;
  write: (relativePath: string, text: string | Uint8Array) => Promise<void>;
  log: ServerLogEvent[];
  input: Parameters<typeof resolveDraftDeliveryTemplate>[0];
}> {
  const root = nodeWorkspaceFs.realPath(await mkdtemp(join(tmpdir(), "draft-template-")));
  roots.push(root);
  const workspace: WorkspaceInfo = {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  const log: ServerLogEvent[] = [];
  return {
    workspace,
    write: async (path, text): Promise<void> => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    },
    log,
    input: {
      workspace,
      issueBinding,
      title,
      correlationId,
      activityLog: {
        write: (event): void => {
          log.push(event);
        },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("issue-bound default pull request template composition", () => {
  it("creates one trusted closing line and the shared empty region without a template", async () => {
    const f = await fixture();
    const result = resolveDraftDeliveryTemplate(f.input);
    expect(result).toEqual({
      status: "ready",
      title,
      titleDigest: sha256Hex(title),
      body: `Closes #42\n\n${framePrDescriptionRegion("")}`,
      bodyDigest: sha256Hex(`Closes #42\n\n${framePrDescriptionRegion("")}`),
      templateBytes: 0,
    });
  });

  it.each([
    "pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.MD",
    "docs/Pull_Request_Template.txt",
    "PULL_REQUEST_TEMPLATE",
  ])("resolves documented defaults and preserves every accepted source byte: %s", async (path) => {
    const f = await fixture();
    const template = "## Review\r\n\r\n- [ ] Check café 😀\r\n\t ";
    await f.write(path, template);
    const result = resolveDraftDeliveryTemplate(f.input);
    expect(result).toMatchObject({
      status: "ready",
      templateDigest: sha256Hex(template),
      templateBytes: Buffer.byteLength(template),
    });
    if (result.status !== "ready") throw new Error("template unexpectedly refused");
    expect(result.body).toBe(`${template}\n\nCloses #42\n\n${framePrDescriptionRegion("")}`);
    expect(result.body.split(PR_DESCRIPTION_REGION_START)).toHaveLength(2);
    expect(result.body.match(/Closes #42/gu)).toHaveLength(1);
    expect(result.bodyDigest).toBe(sha256Hex(result.body));
    expect(hasIssueClosingDirective(template)).toBe(false);
  });

  it("does not recursively select a custom template or infer another issue from text", async () => {
    const f = await fixture();
    await f.write(".github/PULL_REQUEST_TEMPLATE/feature.md", "Closes #999");
    await f.write("docs/pull_request_template.md", "Refs #999\n");
    const result = resolveDraftDeliveryTemplate(f.input);
    expect(result).toMatchObject({
      status: "ready",
      body: `Refs #999\n\n\nCloses #42\n\n${framePrDescriptionRegion("")}`,
    });
  });

  it("rejects secret-bearing titles instead of publishing a sanitized variant", async () => {
    const f = await fixture();
    expect(
      resolveDraftDeliveryTemplate({
        ...f.input,
        title: SECRET_SHAPED_TEXT,
      }),
    ).toEqual({ status: "blocked", reason: "title-invalid" });
  });

  it("accepts an empty template and records its identity separately from absence", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "");
    expect(resolveDraftDeliveryTemplate(f.input)).toMatchObject({
      status: "ready",
      templateBytes: 0,
      templateDigest: sha256Hex(""),
    });
  });

  it("refuses multiple default locations before reading their bodies", async () => {
    const f = await fixture();
    await f.write(".github/pull_request_template.md", "one");
    await f.write("docs/pull_request_template.txt", "two");
    const read = vi.fn(nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor);
    expect(
      resolveDraftDeliveryTemplate({
        ...f.input,
        fs: { ...nodeWorkspaceFs, readFileUtf8WithinRootSameDescriptor: read },
      }),
    ).toEqual({ status: "blocked", reason: "template-ambiguous" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "Closes #99",
    "fixed: other/repo#99",
    "RESOLVES https://github.com/other/repo/issues/99",
  ])("refuses authored closing directives in either metadata field: %s", async (text) => {
    const f = await fixture();
    expect(resolveDraftDeliveryTemplate({ ...f.input, title: text })).toEqual({
      status: "blocked",
      reason: "issue-directive",
    });
    await f.write("pull_request_template.md", text);
    expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
      status: "blocked",
      reason: "issue-directive",
    });
  });

  it.each([PR_DESCRIPTION_REGION_START, "<!-- KEIKO : PR-DESCRIPTION:v999:end -->"])(
    "refuses preexisting or malformed managed markers: %s",
    async (marker) => {
      const f = await fixture();
      await f.write("pull_request_template.md", marker);
      expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
        status: "blocked",
        reason: "managed-region-marker",
      });
      expect(resolveDraftDeliveryTemplate({ ...f.input, title: marker })).toEqual({
        status: "blocked",
        reason: "managed-region-marker",
      });
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    "refuses invalid frozen issue number %s",
    async (issueNumber) => {
      const f = await fixture();
      expect(
        resolveDraftDeliveryTemplate({
          ...f.input,
          issueBinding: { ...issueBinding, issueNumber },
        }),
      ).toEqual({ status: "blocked", reason: "invalid-issue-binding" });
    },
  );

  it.each(["", "  ", "title\nCloses #9", "unsafe\u202eheading", "x".repeat(257)])(
    "refuses invalid title %j before template reads",
    async (invalidTitle) => {
      const f = await fixture();
      const readDir = vi.fn(nodeWorkspaceFs.readDir);
      expect(
        resolveDraftDeliveryTemplate({
          ...f.input,
          title: invalidTitle,
          fs: { ...nodeWorkspaceFs, readDir },
        }),
      ).toMatchObject({ status: "blocked" });
      expect(readDir).not.toHaveBeenCalled();
    },
  );
});

describe("bounded governed template reads", () => {
  it("refuses oversized UTF-8 bytes rather than truncating into a different payload", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "é".repeat(DRAFT_DELIVERY_TEMPLATE_MAX_BYTES));
    expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
      status: "blocked",
      reason: "template-too-large",
    });
  });

  it("accepts the complete byte cap without truncation", async () => {
    const f = await fixture();
    const template = "x".repeat(DRAFT_DELIVERY_TEMPLATE_MAX_BYTES);
    await f.write("pull_request_template.md", template);
    const result = resolveDraftDeliveryTemplate(f.input);
    expect(result).toMatchObject({
      status: "ready",
      templateBytes: DRAFT_DELIVERY_TEMPLATE_MAX_BYTES,
    });
    if (result.status !== "ready") throw new Error("bounded template unexpectedly refused");
    expect(result.body.startsWith(template)).toBe(true);
  });

  it("refuses a newly introduced competing default during the accepted read", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "first");
    const read = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
    if (read === undefined) throw new Error("descriptor port unavailable");
    const fs = {
      ...nodeWorkspaceFs,
      readFileUtf8WithinRootSameDescriptor: (
        ...args: Parameters<typeof read>
      ): ReturnType<typeof read> => {
        const result = read(...args);
        writeFileSync(join(f.workspace.root, "PULL_REQUEST_TEMPLATE.txt"), "second");
        return result;
      },
    };
    expect(resolveDraftDeliveryTemplate({ ...f.input, fs })).toEqual({
      status: "blocked",
      reason: "template-ambiguous",
    });
  });

  it("refuses template replacement across the guarded descriptor read", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "first");
    await f.write("replacement.md", "second");
    const read = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
    if (read === undefined) throw new Error("descriptor port unavailable");
    const fs = {
      ...nodeWorkspaceFs,
      readFileUtf8WithinRootSameDescriptor: (
        ...args: Parameters<typeof read>
      ): ReturnType<typeof read> => {
        const result = read(...args);
        renameSync(
          join(f.workspace.root, "replacement.md"),
          join(f.workspace.root, "pull_request_template.md"),
        );
        return result;
      },
    };
    expect(resolveDraftDeliveryTemplate({ ...f.input, fs })).toEqual({
      status: "blocked",
      reason: "template-unreadable",
    });
  });

  it("preserves the governed deny policy for a protected selected workspace", async () => {
    const f = await fixture();
    await f.write(".ssh/pull_request_template.md", "protected");
    const root = join(f.workspace.root, ".ssh");
    const read = vi.fn(nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor);
    const result = resolveDraftDeliveryTemplate({
      ...f.input,
      workspace: { ...f.workspace, root, selectedRoot: root },
      fs: { ...nodeWorkspaceFs, readFileUtf8WithinRootSameDescriptor: read },
    });
    expect(result).toEqual({ status: "blocked", reason: "template-unreadable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects incomplete discovery instead of accepting a filesystem-order subset", async () => {
    const f = await fixture();
    const readDir = vi.fn(() =>
      Array.from({ length: DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES + 1 }, (_, i) => ({
        name: `file${String(i)}`,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      })),
    );
    expect(
      resolveDraftDeliveryTemplate({ ...f.input, fs: { ...nodeWorkspaceFs, readDir } }),
    ).toEqual({ status: "blocked", reason: "template-discovery-limit" });
    expect(readDir).toHaveBeenCalledWith(
      f.workspace.root,
      DRAFT_DELIVERY_TEMPLATE_DIRECTORY_MAX_ENTRIES + 1,
    );
  });

  it.each(["PULL_REQUEST_TEMPLATE.html", "pull_request_template.pem"])(
    "refuses unsupported default %s",
    async (path) => {
      const f = await fixture();
      await f.write(path, "not an accepted default text format");
      expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
        status: "blocked",
        reason: "template-unsupported",
      });
    },
  );

  it.each([
    new Uint8Array([0xff, 0xff, 0xff]),
    "hidden\u0000payload",
    "unsafe\u202epayload",
    SECRET_SHAPED_TEXT,
  ])("refuses undecodable, hidden or secret-bearing text without rewriting it", async (text) => {
    const f = await fixture();
    await f.write("pull_request_template.md", text);
    expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
      status: "blocked",
      reason: "template-unsafe",
    });
  });

  it("requires the secure complete descriptor port", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "template");
    const { readFileUtf8WithinRootSameDescriptor: omitted, ...fs } = nodeWorkspaceFs;
    expect(omitted).toBeTypeOf("function");
    expect(resolveDraftDeliveryTemplate({ ...f.input, fs })).toEqual({
      status: "blocked",
      reason: "template-unreadable",
    });
  });

  it.each(["symbolic", "hard"])(
    "refuses %s links even to otherwise readable content",
    async (kind) => {
      const f = await fixture();
      await f.write("original.md", "template");
      const source = join(f.workspace.root, "original.md");
      const target = join(f.workspace.root, "pull_request_template.md");
      if (kind === "symbolic") await symlink(source, target);
      else await link(source, target);
      expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
        status: "blocked",
        reason: "template-unreadable",
      });
    },
  );

  it("refuses symlinked parent directories before content reads", async () => {
    const f = await fixture();
    const other = await fixture();
    await other.write("pull_request_template.md", "outside workspace");
    await symlink(other.workspace.root, join(f.workspace.root, ".github"));
    expect(resolveDraftDeliveryTemplate(f.input)).toEqual({
      status: "blocked",
      reason: "template-unreadable",
    });
  });

  it("logs reconstructable hashes/counts and correlated body-free failures", async () => {
    const f = await fixture();
    await f.write("pull_request_template.md", "private customer narrative");
    expect(resolveDraftDeliveryTemplate(f.input).status).toBe("ready");
    const readDir = (): never => {
      throw new Error("/private/customer/path token=sk-private-secret");
    };
    expect(
      resolveDraftDeliveryTemplate({ ...f.input, fs: { ...nodeWorkspaceFs, readDir } }),
    ).toEqual({ status: "blocked", reason: "template-unreadable" });
    expect(f.log).toMatchObject([
      {
        op: "git.draft-template",
        correlationId,
        extra: { state: "ready", templateBytes: 26 },
      },
      {
        op: "git.draft-template",
        correlationId,
        errorKind: "internal",
        extra: { state: "blocked", reason: "template-unreadable", errorClass: "Error" },
      },
    ]);
    const encoded = f.log.map((event) => formatServerLogLine(event)).join("\n");
    for (const forbidden of [
      f.workspace.root,
      title,
      "private customer",
      "sk-private",
      "customer/path",
    ])
      expect(encoded).not.toContain(forbidden);
    expect(encoded).toContain("3387-template-fixture");
    expect(encoded).toContain("bodyDigest");
  });
});
