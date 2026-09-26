import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  checkH1ProducerCheckpoint,
  H1_PRODUCER_CHECKPOINT_PATH,
  loadToolCatalogProducer,
  ownedSourceDigestAt,
  realProducerIdentityFailures,
} from "../check-tool-catalog-conformance.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const ROOT = process.cwd();
const roots = [];
const ownedPaths = ["packages/keiko-server/src/coding-runtime/codingRepositorySearchHandler.ts"];
const gitExecutable = resolveHostExecutable("git");
const deps = {
  ownedPaths,
  identityFailures: (_root, record) => realProducerIdentityFailures(ROOT, record),
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root, ...args) {
  return execFileSync(gitExecutable, args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function commit(root) {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}
function receipt(root, record, kind, overrides = {}) {
  const path = `docs/qa/evidence/h1-${kind}.v1.json`;
  const bytes = JSON.stringify({
    schemaVersion: 1,
    sourceHead: record.sourceHead,
    ownedSourceDigest: record.treeDigest,
    status: kind === "verification" ? "verified" : "accepted",
    ...overrides,
  });
  write(root, path, bytes);
  return `${path}#sha256=${sha256Hex(bytes)}`;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-h1-checkpoint-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=dev");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "H1 Fixture");
  git(root, "config", "commit.gpgsign", "false");
  write(root, ownedPaths[0], "export const boundedHandler = false;\n");
  const baseHead = commit(root);
  write(root, ownedPaths[0], "export const boundedHandler = true;\n");
  const sourceHead = commit(root);
  const producer = await loadToolCatalogProducer(ROOT);
  const catalog = producer.createKeikoToolCatalog([producer.opencodeRegistrationSet()]);
  const projection = producer.compileToolProjection(catalog, { id: "opencode", version: 1 });
  const record = {
    schemaVersion: 1,
    integrationPr: 3394,
    sourceHead,
    currentHead: sourceHead,
    treeDigest: ownedSourceDigestAt(sourceHead, root, execFileSync, ownedPaths),
    catalogRevision: projection.catalogRevision,
    profile: projection.profile,
    projectionDigest: projection.projectionDigest,
    handlerSetDigest: sha256Hex("fixture handler binding; not live evidence"),
  };
  record.verificationRef = receipt(root, record, "verification");
  record.reviewRef = receipt(root, record, "review");
  write(root, H1_PRODUCER_CHECKPOINT_PATH, JSON.stringify(record));
  commit(root);
  return { root, record, baseHead };
}
async function check(root) {
  return checkH1ProducerCheckpoint(root, {}, deps);
}
describe("consolidated H1 producer checkpoint", () => {
  it("accepts reviewed real Git contents without inventing a future dev merge", async () => {
    const { root } = await fixture();
    expect(await check(root)).toEqual([]);
  });
  it("rejects committed source drift even when both recorded commits still agree", async () => {
    const { root } = await fixture();
    write(root, ownedPaths[0], "export const boundedHandler = false;\n");
    commit(root);
    expect(await check(root)).toContain(
      "H1 handoff evidence identity mismatch: the consuming commit's owned source content does not match the reviewed treeDigest",
    );
  });
  it("rejects uncommitted source drift", async () => {
    const { root } = await fixture();
    write(root, ownedPaths[0], "export const boundedHandler = false;\n");
    expect(await check(root)).toContain(
      "H1 producer checkpoint stale: uncommitted owned-source changes",
    );
  });
  it("rejects identical source in an unrelated history", async () => {
    const { root } = await fixture();
    git(root, "checkout", "--orphan", "unrelated");
    commit(root);
    expect(await check(root)).toContain(
      "H1 producer checkpoint unreachable: producer/consumer integration history mismatch",
    );
  });
  it("revalidates original source evidence after a squash rewrites integration identities", async () => {
    const { root, record, baseHead } = await fixture();
    const reviewedHead = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "squash-integration", baseHead);
    git(root, "restore", "--source", reviewedHead, "--", ".");
    commit(root);
    expect(() => git(root, "merge-base", "--is-ancestor", record.sourceHead, "HEAD")).toThrow();
    expect(await check(root)).toEqual([]);
  });
  it.each(["verification", "review"])("rejects changed %s receipt bytes", async (kind) => {
    const { root } = await fixture();
    write(root, `docs/qa/evidence/h1-${kind}.v1.json`, "{}");
    expect(await check(root)).toContain(
      `H1 producer checkpoint stale ${kind} receipt: content digest mismatch`,
    );
  });
  it.each(["verification", "review"])(
    "rejects repinned but unaccepted %s evidence",
    async (kind) => {
      const { root, record } = await fixture();
      const key = kind === "verification" ? "verificationRef" : "reviewRef";
      record[key] = receipt(root, record, kind, { status: "pending" });
      write(root, H1_PRODUCER_CHECKPOINT_PATH, JSON.stringify(record));
      expect(await check(root)).toContain(
        `H1 producer checkpoint invalid ${kind} receipt: source or acceptance mismatch`,
      );
    },
  );
  it("rejects a nonexistent producer object", async () => {
    const { root, record } = await fixture();
    record.sourceHead = "a".repeat(40);
    write(root, H1_PRODUCER_CHECKPOINT_PATH, JSON.stringify(record));
    expect((await check(root)).some((error) => error.includes("not a resolvable Git commit"))).toBe(
      true,
    );
  });
  it("recompiles the actual producer identity rather than trusting matching receipts", async () => {
    const { root, record } = await fixture();
    record.projectionDigest = "b".repeat(64);
    write(root, H1_PRODUCER_CHECKPOINT_PATH, JSON.stringify(record));
    expect(await check(root)).toContain(
      "H1 handoff evidence identity mismatch: projectionDigest does not match the current producer",
    );
  });
});
