import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearWorkProject } from "../testing/jira-chat-lab/requirements/work-project-reset.mjs";

const directories = [];
/** A synthetic session whose admin credential is a private fixture file. */
function session() {
  const directory = mkdtempSync(join(tmpdir(), "work-reset-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic", { mode: 0o600 });
  return { directory, origin: "http://127.0.0.1:18080" };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const created of directories.splice(0)) rmSync(created, { recursive: true, force: true });
});

/** A fake Jira holding `keys`; a parent delete also removes the sub-tasks listed under it. */
function jira(keys, { subtasks = {}, deleteStatus = 204 } = {}) {
  const issues = new Set(keys);
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      const { pathname, searchParams } = new globalThis.URL(url);
      calls.push(`${init.method} ${pathname}`);
      if (init.method === "GET") {
        const page = [...issues].slice(0, Number(searchParams.get("maxResults")));
        const body = { issues: page.map((key) => ({ key })), total: issues.size };
        return Promise.resolve(new globalThis.Response(JSON.stringify(body), { status: 200 }));
      }
      const key = decodeURIComponent(pathname.split("/").at(-1));
      if (!issues.has(key)) return Promise.resolve(new globalThis.Response(null, { status: 404 }));
      if (deleteStatus === 204) {
        issues.delete(key);
        for (const child of subtasks[key] ?? []) issues.delete(child);
      }
      return Promise.resolve(new globalThis.Response(null, { status: deleteStatus }));
    }),
  );
  return { issues, calls };
}

describe("clearWorkProject", () => {
  it("deletes every issue of the work project, sub-tasks with their parent", async () => {
    const fake = jira(["REQ-1", "REQ-2", "REQ-3"], { subtasks: { "REQ-1": ["REQ-3"] } });
    const lines = [];
    await expect(
      clearWorkProject(session(), "REQ", { log: (line) => lines.push(line) }),
    ).resolves.toBe(3);
    expect(fake.issues.size).toBe(0);
    expect(fake.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      "DELETE /rest/api/2/issue/REQ-1",
      "DELETE /rest/api/2/issue/REQ-2",
      "DELETE /rest/api/2/issue/REQ-3",
    ]);
    expect(lines).toEqual([
      { operation: "requirements-work-project", project: "REQ", state: "cleared", removed: 3 },
    ]);
  });

  it("reads page after page until the project is empty", async () => {
    const keys = Array.from({ length: 150 }, (_, index) => `REQ-${String(index + 1)}`);
    const fake = jira(keys);
    await expect(clearWorkProject(session(), "REQ")).resolves.toBe(150);
    expect(fake.calls.filter((call) => call.startsWith("GET"))).toHaveLength(3);
  });

  it("leaves an empty project alone", async () => {
    const fake = jira([]);
    await expect(clearWorkProject(session(), "REQ")).resolves.toBe(0);
    expect(fake.calls).toEqual(["GET /rest/api/2/search"]);
  });

  it("fails the journey when Jira refuses a delete", async () => {
    jira(["REQ-1"], { deleteStatus: 403 });
    await expect(clearWorkProject(session(), "REQ")).rejects.toThrow(
      "Work-project delete failed (403)",
    );
  });

  it("refuses a project key it would have to quote into JQL", async () => {
    const fake = jira(["REQ-1"]);
    await expect(clearWorkProject(session(), "REQ OR project = RPT")).rejects.toThrow(
      "Unexpected work-project key",
    );
    expect(fake.calls).toEqual([]);
  });
});
