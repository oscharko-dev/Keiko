import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { OwnerPrivateFileRefused } from "../ownerPrivateStateFile.js";
import {
  OPENCODE_SKILL_SOURCES_FILE,
  createRemoteSkillsPort,
  loadSkillSourceRegistry,
  parseSkillSourceRegistry,
  type SkillSourceRegistry,
} from "./opencodeRemoteSkills.js";

const SOURCE = "https://skills.example.test/team/";
const SKILL =
  "---\nname: release\ndescription: Drafts a release\nallowed-tools: bash\n---\nDraft the release notes.\n";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function discoveryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-remote-skills-"));
  roots.push(root);
  return root;
}

function serving(files: Readonly<Record<string, string | Error>>): {
  readonly fetchImpl: typeof fetch;
  readonly requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const file = files[url];
    if (file instanceof Error) return Promise.reject(file);
    return Promise.resolve(
      file === undefined
        ? new Response("missing", { status: 404 })
        : new Response(file, { status: 200 }),
    );
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const INDEX = JSON.stringify({ skills: [{ name: "release", files: ["SKILL.md", "notes.sh"] }] });

function port(
  registry: () => SkillSourceRegistry,
  files: Readonly<Record<string, string | Error>>,
  records: ServerLogEvent[],
): { readonly port: ReturnType<typeof createRemoteSkillsPort>; readonly requested: string[] } {
  const sink: ServerLogSink = { write: (event) => void records.push(event) };
  const { fetchImpl, requested } = serving(files);
  return {
    port: createRemoteSkillsPort({
      registry,
      egress: () => undefined,
      activityLog: sink,
      fetchImpl,
    }),
    requested,
  };
}

const loaded = (): SkillSourceRegistry => ({ state: "loaded", sources: [SOURCE] });

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.remote-skills.admitted.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

describe("the operator's remote skill sources (#3903 AC3)", () => {
  it("accepts https sources and normalizes them as the runtime does", () => {
    expect(
      parseSkillSourceRegistry({
        schemaVersion: 1,
        sources: [{ url: "https://skills.example.test/team" }],
      }),
    ).toEqual({ ok: true, sources: [SOURCE] });
  });

  it.each([
    [
      "http",
      { schemaVersion: 1, sources: [{ url: "http://skills.example.test/" }] },
      "source-invalid",
    ],
    ["a query", { schemaVersion: 1, sources: [{ url: `${SOURCE}?a=1` }] }, "source-invalid"],
    [
      "credentials",
      { schemaVersion: 1, sources: [{ url: "https://u:p@skills.test/" }] },
      "source-invalid",
    ],
    [
      "a duplicate",
      { schemaVersion: 1, sources: [{ url: SOURCE }, { url: SOURCE }] },
      "duplicate-source",
    ],
    [
      "five sources",
      {
        schemaVersion: 1,
        sources: Array.from({ length: 5 }, (_, i) => ({ url: `${SOURCE}${String(i)}/` })),
      },
      "too-many-sources",
    ],
    ["another key", { schemaVersion: 1, sources: [], extra: 1 }, "malformed"],
  ])("refuses a registry with %s", (_label, value, reason) => {
    expect(parseSkillSourceRegistry(value)).toEqual({ ok: false, reason });
  });

  it("reads an absent registry as no source and throws for one it cannot trust", () => {
    const stateDir = discoveryRoot();
    expect(loadSkillSourceRegistry(stateDir)).toEqual({ state: "absent", sources: [] });
    const file = join(stateDir, OPENCODE_SKILL_SOURCES_FILE);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [{ url: SOURCE }] }), {
      mode: 0o600,
    });
    expect(loadSkillSourceRegistry(stateDir)).toEqual({ state: "loaded", sources: [SOURCE] });
    chmodSync(file, 0o622);
    expect(() => loadSkillSourceRegistry(stateDir)).toThrow(OwnerPrivateFileRefused);
  });

  it("pulls a Full access run's skills, sanitized, into the private skill directory", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const { port: skills, requested } = port(
      loaded,
      { [`${SOURCE}index.json`]: INDEX, [`${SOURCE}release/SKILL.md`]: SKILL },
      records,
    );
    await skills.admitForRun({
      runId: "run-skills-1",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    const copy = readFileSync(join(root, "skill", "release", "SKILL.md"), "utf8");
    expect(copy).toContain("Draft the release notes.");
    expect(copy).not.toContain("allowed-tools");
    // Only the index and SKILL.md: a skill's sibling files are never fetched.
    expect(requested).toEqual([`${SOURCE}index.json`, `${SOURCE}release/SKILL.md`]);
    const [line] = lines(records);
    expect(line).toMatchObject({
      scope: "source",
      state: "admitted",
      admittedCount: 1,
      refusedCount: 0,
    });
    expect(JSON.stringify(records)).not.toContain("skills.example.test");
    expect(JSON.stringify(records)).not.toContain("release");
  });

  it("pulls nothing below Full access and clears what an earlier prepare pulled", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const files = { [`${SOURCE}index.json`]: INDEX, [`${SOURCE}release/SKILL.md`]: SKILL };
    await port(loaded, files, records).port.admitForRun({
      runId: "r",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    records.length = 0;
    const { port: skills, requested } = port(loaded, files, records);
    await skills.admitForRun({ runId: "r", discoveryRoot: root, mode: "supervised-coding" });
    expect(existsSync(join(root, "skill"))).toBe(false);
    expect(requested).toEqual([]);
    expect(lines(records)).toEqual([
      expect.objectContaining({ scope: "registry", state: "mode-restricted", sourceCount: 1 }),
    ]);
  });

  it("keeps a repository skill of the same name and refuses what it cannot admit", async () => {
    const root = discoveryRoot();
    mkdirSync(join(root, "skills", "release"), { recursive: true });
    const records: ServerLogEvent[] = [];
    const index = JSON.stringify({
      skills: [
        { name: "release", files: ["SKILL.md"] },
        { name: "Bad Name", files: ["SKILL.md"] },
        { name: "notes", files: ["notes.md"] },
        { name: "gone", files: ["SKILL.md"] },
      ],
    });
    await port(loaded, { [`${SOURCE}index.json`]: index }, records).port.admitForRun({
      runId: "r",
      discoveryRoot: root,
      mode: "autonomous-delivery",
    });
    expect(existsSync(join(root, "skill"))).toBe(false);
    expect(lines(records)[0]).toMatchObject({
      state: "admitted",
      admittedCount: 0,
      refusedCount: 4,
      refusalReasons: ["duplicate-name", "invalid-name", "skill-invalid", "skill-unavailable"],
    });
  });

  it("records a source that cannot be read or is not an index, without failing the run", async () => {
    const root = discoveryRoot();
    const records: ServerLogEvent[] = [];
    const other = "https://other.example.test/";
    await port(
      () => ({ state: "loaded", sources: [SOURCE, other] }),
      {
        [`${SOURCE}index.json`]: new TypeError("fetch failed"),
        [`${other}index.json`]: "not json",
      },
      records,
    ).port.admitForRun({ runId: "r", discoveryRoot: root, mode: "autonomous-delivery" });
    const [failed, invalid] = lines(records);
    expect(failed).toMatchObject({ scope: "source", state: "source-failed" });
    expect(failed?.frames).toEqual(expect.any(Array));
    expect(invalid).toMatchObject({ scope: "source", state: "index-invalid" });
    expect(records.every((record) => record.level === "warn")).toBe(true);
  });

  it("records a refused registry", async () => {
    const records: ServerLogEvent[] = [];
    await port(
      () => {
        throw new OwnerPrivateFileRefused("not-owner-private");
      },
      {},
      records,
    ).port.admitForRun({ runId: "r", discoveryRoot: discoveryRoot(), mode: "autonomous-delivery" });
    expect(lines(records)).toEqual([
      expect.objectContaining({
        scope: "registry",
        state: "registry-refused",
        registryReason: "not-owner-private",
      }),
    ]);
  });
});
