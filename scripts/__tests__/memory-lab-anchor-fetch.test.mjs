// Hermetic tests of the anchor fetcher (#4208): paging, resumability, limits, retries, the LongMemEval
// download and the output guards. No network: every request goes through an injected fetch.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  fetchAnchorSet,
  main,
  normalizeFetchOptions,
  pageUrl,
  renderLicenses,
} from "../testing/memory-lab/anchor/fetch.mjs";
import { ANCHOR_SETS } from "../testing/memory-lab/anchor/sets.mjs";

const { Response } = globalThis;
const ROW_TEXT_MARKER = "ROW-TEXT-MARKER-must-not-reach-a-manifest";
const FETCHED_AT = "2026-11-03T20:00:00.000Z";

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeRows(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    row_idx: index,
    row: { conversation_hash: `hash-${String(index)}`, text: ROW_TEXT_MARKER },
    truncated_cells: [],
  }));
}

// A datasets-server `filter` stand-in: serves the slice asked for, at most `cap` rows per call.
function filterServer({ total, cap = 100, partial = false }) {
  const rows = makeRows(total);
  const calls = [];
  const fetchFn = (url, init) => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("offset"));
    const length = Number(parsed.searchParams.get("length"));
    calls.push({ url, offset, length, init });
    return Promise.resolve(
      jsonResponse({
        rows: rows.slice(offset, offset + Math.min(length, cap)),
        num_rows_total: total,
        num_rows_per_page: 100,
        partial,
      }),
    );
  };
  return { fetchFn, calls };
}

// Replays a script of steps (a function returning a Response, or an Error to reject with); the last
// step repeats when the script runs out.
function scriptedFetch(script) {
  const calls = [];
  const fetchFn = (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step());
  };
  return { fetchFn, calls };
}

function sleeper() {
  const sleeps = [];
  return {
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

function okPage(total = 3) {
  return () => jsonResponse({ rows: makeRows(total), num_rows_total: total, partial: false });
}

describe("memory lab anchor fetcher", () => {
  const directories = [];
  function scratch() {
    const directory = mkdtempSync(join(tmpdir(), "anchor-fetch-"));
    directories.push(directory);
    return directory;
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function options(out) {
    return { out, sleep: sleeper().sleep, now: () => FETCHED_AT, log: () => undefined };
  }

  describe("page URLs", () => {
    it("encodes the filter the way the datasets-server expects it", () => {
      const url = new URL(pageUrl(ANCHOR_SETS["wildchat-de"], 300, 100));
      expect(url.origin + url.pathname).toBe("https://datasets-server.huggingface.co/filter");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        dataset: "allenai/WildChat-1M",
        config: "default",
        split: "train",
        where: `"language"='German'`,
        offset: "300",
        length: "100",
      });
      expect(url.href).toContain("where=%22language%22%3D%27German%27");
    });

    it.each([
      ["wildchat-en", "allenai/WildChat-1M", `"language"='English'`],
      ["oasst2-de", "OpenAssistant/oasst2", `"lang"='de'`],
      ["oasst2-en", "OpenAssistant/oasst2", `"lang"='en'`],
    ])("names the dataset and filter of %s", (name, dataset, where) => {
      const params = new URL(pageUrl(ANCHOR_SETS[name], 0, 100)).searchParams;
      expect(params.get("dataset")).toBe(dataset);
      expect(params.get("where")).toBe(where);
    });
  });

  describe("paging and resumability", () => {
    it("pages through the set, writes raw pages, a manifest and the licenses", async () => {
      const out = scratch();
      const server = filterServer({ total: 250, partial: true });
      const { sleeps, sleep } = sleeper();
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(out),
        fetchFn: server.fetchFn,
        sleep,
        delayMs: 750,
      });
      expect(server.calls.map((call) => [call.offset, call.length])).toEqual([
        [0, 100],
        [100, 100],
        [200, 100],
      ]);
      expect(readdirSync(join(out, "wildchat-de", "pages")).toSorted()).toEqual([
        "0.json",
        "100.json",
        "200.json",
      ]);
      const stored = JSON.parse(
        readFileSync(join(out, "wildchat-de", "pages", "200.json"), "utf8"),
      );
      expect(stored.rows).toHaveLength(50);
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        set: "wildchat-de",
        dataset: "allenai/WildChat-1M",
        filter: `"language"='German'`,
        license: "ODC-By-1.0",
        rowCount: 250,
        numRowsTotal: 250,
        limit: null,
        partial: true,
        pageCount: 3,
        pageSize: 100,
        fetchedAt: FETCHED_AT,
      });
      expect(manifest.apiUrlTemplate).toContain("offset={offset}&length=100");
      expect(manifest.apiUrlTemplate).toContain("where=%22language%22%3D%27German%27");
      const written = JSON.parse(
        readFileSync(join(out, "wildchat-de", "fetch-manifest.json"), "utf8"),
      );
      expect(written).toEqual(manifest);
      expect(JSON.stringify(manifest)).not.toContain(ROW_TEXT_MARKER);
      expect(readFileSync(join(out, "LICENSES.md"), "utf8")).toBe(renderLicenses());
      // The polite delay separates requests: after every network page except the last.
      expect(sleeps).toEqual([750, 750]);
    });

    it("sends an identifying user agent and a request timeout signal", async () => {
      const out = scratch();
      const server = filterServer({ total: 5 });
      await fetchAnchorSet("oasst2-de", { ...options(out), fetchFn: server.fetchFn });
      const [call] = server.calls;
      expect(call.init.headers["user-agent"]).toMatch(/^keiko-memory-lab-anchor-fetch\//u);
      expect(call.init.headers.accept).toBe("application/json");
      expect(call.init.signal).toBeInstanceOf(globalThis.AbortSignal);
    });

    it("skips pages that already exist, so a second run makes no request", async () => {
      const out = scratch();
      const first = filterServer({ total: 250 });
      await fetchAnchorSet("wildchat-de", { ...options(out), fetchFn: first.fetchFn });
      const second = filterServer({ total: 250 });
      const { sleeps, sleep } = sleeper();
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(out),
        fetchFn: second.fetchFn,
        sleep,
      });
      expect(second.calls).toHaveLength(0);
      expect(sleeps).toEqual([]);
      expect(manifest.rowCount).toBe(250);
      expect(manifest.pageCount).toBe(3);
    });

    it("fetches only the page that is missing", async () => {
      const out = scratch();
      await fetchAnchorSet("wildchat-de", {
        ...options(out),
        fetchFn: filterServer({ total: 250 }).fetchFn,
      });
      rmSync(join(out, "wildchat-de", "pages", "100.json"));
      const resumed = filterServer({ total: 250 });
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(out),
        fetchFn: resumed.fetchFn,
      });
      expect(resumed.calls.map((call) => call.offset)).toEqual([100]);
      expect(manifest.rowCount).toBe(250);
    });

    it("fetches again a page file that cannot be read back", async () => {
      const out = scratch();
      await fetchAnchorSet("oasst2-de", {
        ...options(out),
        fetchFn: filterServer({ total: 40 }).fetchFn,
      });
      writeFileSync(join(out, "oasst2-de", "pages", "0.json"), "{ truncated");
      const resumed = filterServer({ total: 40 });
      await fetchAnchorSet("oasst2-de", { ...options(out), fetchFn: resumed.fetchFn });
      expect(resumed.calls).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(out, "oasst2-de", "pages", "0.json"), "utf8")).rows,
      ).toHaveLength(40);
    });

    it("advances by the rows actually received when the API returns fewer than asked", async () => {
      const out = scratch();
      const server = filterServer({ total: 100, cap: 40 });
      const manifest = await fetchAnchorSet("oasst2-de", {
        ...options(out),
        fetchFn: server.fetchFn,
      });
      expect(server.calls.map((call) => call.offset)).toEqual([0, 40, 80]);
      expect(readdirSync(join(out, "oasst2-de", "pages")).toSorted()).toEqual([
        "0.json",
        "40.json",
        "80.json",
      ]);
      expect(manifest.rowCount).toBe(100);
    });

    it("stops on an empty page even when the API promised more", async () => {
      const out = scratch();
      const fetchFn = () => Promise.resolve(jsonResponse({ rows: [], num_rows_total: 500 }));
      const manifest = await fetchAnchorSet("oasst2-de", { ...options(out), fetchFn });
      expect(manifest.rowCount).toBe(0);
      expect(manifest.pageCount).toBe(1);
    });
  });

  describe("limits", () => {
    it("stops at the limit and asks for exactly the rows it still needs", async () => {
      const out = scratch();
      const server = filterServer({ total: 1000 });
      const manifest = await fetchAnchorSet("wildchat-en", {
        ...options(out),
        fetchFn: server.fetchFn,
        limit: 250,
      });
      expect(server.calls.map((call) => [call.offset, call.length])).toEqual([
        [0, 100],
        [100, 100],
        [200, 50],
      ]);
      expect(manifest).toMatchObject({ rowCount: 250, limit: 250, numRowsTotal: 1000 });
    });

    it("refetches the short last page when a later run raises the limit", async () => {
      const out = scratch();
      await fetchAnchorSet("wildchat-en", {
        ...options(out),
        fetchFn: filterServer({ total: 1000 }).fetchFn,
        limit: 250,
      });
      const raised = filterServer({ total: 1000 });
      const manifest = await fetchAnchorSet("wildchat-en", {
        ...options(out),
        fetchFn: raised.fetchFn,
        limit: 400,
      });
      expect(raised.calls.map((call) => [call.offset, call.length])).toEqual([
        [200, 100],
        [300, 100],
      ]);
      expect(manifest.rowCount).toBe(400);
    });

    it.each(["wildchat-en", "oasst2-en"])("never fetches %s whole by default", async (name) => {
      const out = scratch();
      const server = filterServer({ total: 10 });
      await expect(
        fetchAnchorSet(name, { ...options(out), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/needs --limit/u);
      expect(server.calls).toHaveLength(0);
    });

    it("lets the German slices run without a limit and the English ones with one", async () => {
      const out = scratch();
      const fetchFn = filterServer({ total: 30 }).fetchFn;
      await expect(
        fetchAnchorSet("oasst2-de", { ...options(out), fetchFn }),
      ).resolves.toMatchObject({
        limit: null,
      });
      await expect(
        fetchAnchorSet("oasst2-en", { ...options(out), fetchFn, limit: 10 }),
      ).resolves.toMatchObject({ limit: 10, rowCount: 10 });
    });

    it.each([0, -3, 1.5, Number.NaN])("rejects the limit %s", async (limit) => {
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(scratch()), fetchFn: okPage(), limit }),
      ).rejects.toThrow(/--limit must be a positive integer/u);
    });
  });

  describe("retries and failures", () => {
    it("retries a 500 with exponential backoff and then succeeds", async () => {
      const out = scratch();
      const server = scriptedFetch([
        () => jsonResponse({ error: "Authentication check failed" }, 500),
        () => jsonResponse({ error: "Authentication check failed" }, 500),
        okPage(),
      ]);
      const { sleeps, sleep } = sleeper();
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(out),
        fetchFn: server.fetchFn,
        sleep,
        backoffMs: 2000,
      });
      expect(server.calls).toHaveLength(3);
      expect(sleeps).toEqual([2000, 4000]);
      expect(manifest.rowCount).toBe(3);
    });

    it("caps the backoff", async () => {
      const failing = scriptedFetch([() => jsonResponse({ error: "down" }, 503)]);
      const { sleeps, sleep } = sleeper();
      await expect(
        fetchAnchorSet("wildchat-de", {
          ...options(scratch()),
          fetchFn: failing.fetchFn,
          sleep,
          backoffMs: 2000,
          maxBackoffMs: 5000,
          attempts: 5,
        }),
      ).rejects.toThrow(/failed after 5 attempt\(s\): HTTP 503: down/u);
      expect(failing.calls).toHaveLength(5);
      expect(sleeps).toEqual([2000, 4000, 5000, 5000]);
    });

    it("honors Retry-After on a 429", async () => {
      const server = scriptedFetch([
        () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "3" }),
        okPage(),
      ]);
      const { sleeps, sleep } = sleeper();
      await fetchAnchorSet("wildchat-de", {
        ...options(scratch()),
        fetchFn: server.fetchFn,
        sleep,
      });
      expect(sleeps).toEqual([3000]);
    });

    it("retries a network error and names its code", async () => {
      const reset = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      const server = scriptedFetch([reset, okPage()]);
      const failing = scriptedFetch([reset]);
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(scratch()),
        fetchFn: server.fetchFn,
      });
      expect(manifest.rowCount).toBe(3);
      await expect(
        fetchAnchorSet("wildchat-de", {
          ...options(scratch()),
          fetchFn: failing.fetchFn,
          attempts: 2,
        }),
      ).rejects.toThrow(/request failed \(ECONNRESET\)/u);
    });

    it("retries a body that is not JSON", async () => {
      const server = scriptedFetch([
        () => new Response("<html>gateway</html>", { status: 200 }),
        okPage(),
      ]);
      const manifest = await fetchAnchorSet("wildchat-de", {
        ...options(scratch()),
        fetchFn: server.fetchFn,
      });
      expect(server.calls).toHaveLength(2);
      expect(manifest.rowCount).toBe(3);
    });

    it("does not retry a client error and quotes only the API's error message", async () => {
      const server = scriptedFetch([() => jsonResponse({ error: "invalid where clause" }, 400)]);
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(scratch()), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/failed after 1 attempt\(s\): HTTP 400: invalid where clause/u);
      expect(server.calls).toHaveLength(1);
    });

    it("never echoes the HTML page of a gateway error", async () => {
      const server = scriptedFetch([
        () => new Response("<html>SECRET-GATEWAY-PAGE</html>", { status: 502 }),
      ]);
      const failure = await fetchAnchorSet("wildchat-de", {
        ...options(scratch()),
        fetchFn: server.fetchFn,
        attempts: 2,
      }).catch((error) => error);
      expect(failure.message).toMatch(/HTTP 502/u);
      expect(failure.message).not.toContain("SECRET-GATEWAY-PAGE");
    });

    it("fails closed on a response of an unexpected shape without retrying", async () => {
      const server = scriptedFetch([() => jsonResponse({ unexpected: true })]);
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(scratch()), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/unexpected shape/u);
      expect(server.calls).toHaveLength(1);
    });

    it("leaves no manifest behind when a set fails midway", async () => {
      const out = scratch();
      const server = scriptedFetch([
        () => jsonResponse({ rows: makeRows(100), num_rows_total: 250 }),
        () => jsonResponse({ error: "down" }, 400),
      ]);
      // The second page fails: the first page stays for a resume, the manifest does not exist.
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(out), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/offset=100 failed after 1 attempt\(s\): HTTP 400/u);
      expect(existsSync(join(out, "wildchat-de", "pages", "0.json"))).toBe(true);
      expect(existsSync(join(out, "wildchat-de", "fetch-manifest.json"))).toBe(false);
      // Data on disk never lacks its licenses, even when the set did not finish.
      expect(readFileSync(join(out, "LICENSES.md"), "utf8")).toBe(renderLicenses());
    });
  });

  describe("LongMemEval", () => {
    const body = JSON.stringify([{ question_id: "q1", haystack_sessions: [] }]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const treeUrl = "https://huggingface.co/api/datasets/xiaowu0162/longmemeval-cleaned/tree/main";
    const fileUrl =
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

    function tree(overrides = {}) {
      const entry = {
        type: "file",
        path: "longmemeval_s_cleaned.json",
        size: Buffer.byteLength(body),
        lfs: { oid: sha256, size: Buffer.byteLength(body) },
        ...overrides,
      };
      return [
        { type: "file", path: "README.md", size: 626 },
        { type: "file", path: "longmemeval_m_cleaned.json", size: 2737100077, lfs: { oid: "m" } },
        { type: "file", path: "longmemeval_oracle.json", size: 15388478, lfs: { oid: "o" } },
        entry,
      ];
    }

    function hubServer({ listing = tree(), content = body } = {}) {
      const calls = [];
      const fetchFn = (url) => {
        calls.push(url);
        if (url === treeUrl) return Promise.resolve(jsonResponse(listing));
        if (url === fileUrl) return Promise.resolve(new Response(content, { status: 200 }));
        return Promise.reject(new Error(`unexpected request ${url}`));
      };
      return { fetchFn, calls };
    }

    it("downloads the cleaned LongMemEval_S file only and verifies it", async () => {
      const out = scratch();
      const hub = hubServer();
      const manifest = await fetchAnchorSet("longmemeval", {
        ...options(out),
        fetchFn: hub.fetchFn,
      });
      expect(hub.calls).toEqual([treeUrl, fileUrl]);
      expect(readFileSync(join(out, "longmemeval", "longmemeval_s_cleaned.json"), "utf8")).toBe(
        body,
      );
      expect(existsSync(join(out, "longmemeval", "longmemeval_s_cleaned.json.part"))).toBe(false);
      expect(manifest).toMatchObject({
        set: "longmemeval",
        dataset: "xiaowu0162/longmemeval-cleaned",
        license: "MIT",
        file: "longmemeval_s_cleaned.json",
        rowCount: null,
        bytes: Buffer.byteLength(body),
        sha256,
        fetchedAt: FETCHED_AT,
      });
      expect(manifest.apiUrlTemplate).toBe(treeUrl);
      expect(manifest.sourceUrlTemplate).toBe(
        "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/{file}",
      );
    });

    it("does not download a verified file again", async () => {
      const out = scratch();
      await fetchAnchorSet("longmemeval", { ...options(out), fetchFn: hubServer().fetchFn });
      const again = hubServer();
      const manifest = await fetchAnchorSet("longmemeval", {
        ...options(out),
        fetchFn: again.fetchFn,
      });
      expect(again.calls).toEqual([treeUrl]);
      expect(manifest.sha256).toBe(sha256);
    });

    it("downloads again when the file on disk does not match the published digest", async () => {
      const out = scratch();
      mkdirSync(join(out, "longmemeval"), { recursive: true });
      writeFileSync(
        join(out, "longmemeval", "longmemeval_s_cleaned.json"),
        "x".repeat(body.length),
      );
      const hub = hubServer();
      await fetchAnchorSet("longmemeval", { ...options(out), fetchFn: hub.fetchFn });
      expect(hub.calls).toEqual([treeUrl, fileUrl]);
      expect(readFileSync(join(out, "longmemeval", "longmemeval_s_cleaned.json"), "utf8")).toBe(
        body,
      );
    });

    it.each([
      ["size", (content) => `${content}x`],
      ["SHA-256", (content) => content.replace("q1", "q2")],
    ])("refuses a download that does not match the published %s", async (_what, tamper) => {
      const out = scratch();
      const hub = hubServer({ content: tamper(body) });
      await expect(
        fetchAnchorSet("longmemeval", { ...options(out), fetchFn: hub.fetchFn, attempts: 2 }),
      ).rejects.toThrow(/does not match the published/u);
      expect(hub.calls.filter((url) => url === fileUrl)).toHaveLength(2);
      expect(readdirSync(join(out, "longmemeval"))).toEqual([]);
      expect(existsSync(join(out, "longmemeval", "fetch-manifest.json"))).toBe(false);
    });

    it("fails closed with the names found when the file cannot be identified", async () => {
      const none = hubServer({ listing: tree().filter((entry) => !entry.path.includes("_s_")) });
      await expect(
        fetchAnchorSet("longmemeval", { ...options(scratch()), fetchFn: none.fetchFn }),
      ).rejects.toThrow(
        /found 0 among: README.md, longmemeval_m_cleaned.json, longmemeval_oracle.json/u,
      );
      const two = hubServer({
        listing: [...tree(), { type: "file", path: "longmemeval_s_cleaned_v2.json", size: 1 }],
      });
      await expect(
        fetchAnchorSet("longmemeval", { ...options(scratch()), fetchFn: two.fetchFn }),
      ).rejects.toThrow(/found 2/u);
      expect(none.calls).toEqual([treeUrl]);
    });

    it("ignores a nested path that merely looks like the file", async () => {
      const hub = hubServer({ listing: tree({ path: "other/longmemeval_s_cleaned.json" }) });
      await expect(
        fetchAnchorSet("longmemeval", { ...options(scratch()), fetchFn: hub.fetchFn }),
      ).rejects.toThrow(/found 0/u);
    });
  });

  describe("output guards", () => {
    it("refuses an output directory inside the checkout and creates nothing", async () => {
      const out = join(REPO_ROOT, "anchor-fetch-refusal-test");
      const server = filterServer({ total: 5 });
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(out), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/--out must lie outside the checkout/u);
      expect(server.calls).toHaveLength(0);
      expect(existsSync(out)).toBe(false);
    });

    it("refuses a directory inside any other git work tree", async () => {
      const root = scratch();
      mkdirSync(join(root, ".git"));
      const out = join(root, "nested", "anchor");
      const server = filterServer({ total: 5 });
      await expect(
        fetchAnchorSet("wildchat-de", { ...options(out), fetchFn: server.fetchFn }),
      ).rejects.toThrow(/outside every git work tree/u);
      expect(existsSync(join(root, "nested"))).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "sees through a symlink into the checkout",
      async () => {
        const root = scratch();
        symlinkSync(REPO_ROOT, join(root, "link"));
        await expect(
          fetchAnchorSet("wildchat-de", {
            ...options(join(root, "link", "anchor-fetch-symlink-test")),
            fetchFn: filterServer({ total: 5 }).fetchFn,
          }),
        ).rejects.toThrow(/outside the checkout/u);
        expect(existsSync(join(REPO_ROOT, "anchor-fetch-symlink-test"))).toBe(false);
      },
    );

    it.skipIf(process.platform === "win32")(
      "keeps directories and files owner-private",
      async () => {
        const out = join(scratch(), "private");
        await fetchAnchorSet("oasst2-de", {
          ...options(out),
          fetchFn: filterServer({ total: 5 }).fetchFn,
        });
        const modes = [
          out,
          join(out, "oasst2-de", "pages"),
          join(out, "oasst2-de", "pages", "0.json"),
          join(out, "oasst2-de", "fetch-manifest.json"),
          join(out, "LICENSES.md"),
        ].map((path) => statSync(path).mode & 0o077);
        expect(modes).toEqual([0, 0, 0, 0, 0]);
      },
    );
  });

  describe("licenses", () => {
    it("states license, source and citation per set and excludes LoCoMo", () => {
      const text = renderLicenses();
      expect(text).toContain("ODC-By-1.0");
      expect(text).toContain("Apache-2.0");
      expect(text).toContain("MIT");
      expect(text).toContain("Zhao, W.");
      expect(text).toContain("ICLR 2024");
      expect(text).toContain("Köpf, A.");
      expect(text).toContain("2023");
      expect(text).toContain("Wu, D.");
      expect(text).toContain("ICLR 2025");
      expect(text).toContain("`wildchat-de`, `wildchat-en`");
      expect(text).toContain("`oasst2-de`, `oasst2-en`");
      expect(text).toContain("`longmemeval`");
      expect(text).toMatch(/LoCoMo is licensed CC BY-NC 4\.0/u);
    });
  });

  describe("command line", () => {
    it("fetches several sets in order and reports a result line", async () => {
      const out = join(scratch(), "cli");
      const lines = [];
      const server = filterServer({ total: 5 });
      const code = await main(
        ["--out", out, "--set", "wildchat-de,oasst2-de", "--set", "oasst2-de"],
        {
          fetchFn: server.fetchFn,
          sleep: sleeper().sleep,
          now: () => FETCHED_AT,
          log: (line) => lines.push(line),
        },
      );
      expect(code).toBe(0);
      expect(lines.at(-1)).toBe("PASS anchor-fetch sets=wildchat-de,oasst2-de");
      expect(existsSync(join(out, "wildchat-de", "fetch-manifest.json"))).toBe(true);
      expect(existsSync(join(out, "oasst2-de", "fetch-manifest.json"))).toBe(true);
    });

    it("prints usage for --help and refuses unknown options", async () => {
      const lines = [];
      expect(await main(["--help"], { log: (line) => lines.push(line) })).toBe(0);
      expect(lines.join("\n")).toContain("usage: node scripts/testing/memory-lab/anchor/fetch.mjs");
      await expect(main(["--nope"])).rejects.toThrow(/nope/u);
    });

    it.each([
      [{}, /--out is required/u],
      [{ out: "/tmp/x" }, /--set is required/u],
      [{ out: "/tmp/x", set: ["nothing"] }, /unknown set "nothing"/u],
      [
        { out: "/tmp/x", set: ["wildchat-de"], limit: "0" },
        /--limit must be an integer of at least 1/u,
      ],
      [{ out: "/tmp/x", set: ["wildchat-de"], "delay-ms": "-1" }, /--delay-ms/u],
    ])("rejects the options %j", (values, pattern) => {
      expect(() => normalizeFetchOptions(values)).toThrow(pattern);
    });

    it("normalizes comma-separated and repeated sets without duplicates", () => {
      const { names, options: fetchOptions } = normalizeFetchOptions({
        out: "/tmp/x",
        set: ["wildchat-de, oasst2-de", "wildchat-de"],
        limit: "50",
        attempts: "3",
      });
      expect(names).toEqual(["wildchat-de", "oasst2-de"]);
      expect(fetchOptions).toMatchObject({ limit: 50, attempts: 3 });
      expect(fetchOptions).not.toHaveProperty("delayMs");
    });
  });
});
