import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DATA_VOLUME,
  FootprintRefusal,
  accountAreas,
  classifyDiagnostics,
  classifyEntry,
  findArguments,
  findChanged,
  inSystemArea,
  onDataVolume,
  parseFootprintArgs,
  summarize,
  writableBy,
} from "../testing/standard-account-footprint.mjs";

// #4520: what a standard account created or changed outside its own folders. The pins keep the
// attribution honest: whatever the account owns outside its areas counts against the promise; what
// it owns in a folder the system keeps for it, and a file of another account it may also write, are
// listed apart; a change it could not have made is counted apart.
const GUID = "8963DEA9-06A2-4378-BF4A-B72B408B0BF4";
const ACCOUNT = { uid: 501, gids: [20, 12], guid: GUID };

function stats({ uid = 0, gid = 0, mode = 0o644, kind = "file" }) {
  return { uid, gid, mode, isFile: () => kind === "file", isDirectory: () => kind === "directory" };
}

describe("parseFootprintArgs", () => {
  it("takes the account, the marker and an optional evidence file", () => {
    expect(parseFootprintArgs(["--account", "keikoqa", "--marker", "m"])).toEqual({
      account: "keikoqa",
      marker: "m",
    });
    expect(
      parseFootprintArgs(["--account", "keikoqa", "--marker", "m", "--evidence", "e"]).evidence,
    ).toBe("e");
  });

  it("refuses a missing marker, a malformed account and unknown flags", () => {
    for (const argv of [
      ["--account", "keikoqa"],
      ["--account", "Kei Ko", "--marker", "m"],
      ["--marker", "m"],
      ["--account", "keikoqa", "--marker", "m", "--x", "y"],
    ]) {
      expect(() => parseFootprintArgs(argv)).toThrow(FootprintRefusal);
    }
  });
});

describe("writableBy", () => {
  it("reads the owner, group and other write bits", () => {
    expect(writableBy(stats({ uid: 501, mode: 0o644 }), ACCOUNT)).toBe(true);
    expect(writableBy(stats({ uid: 501, mode: 0o444 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 20, mode: 0o664 }), ACCOUNT)).toBe(true);
    expect(writableBy(stats({ gid: 20, mode: 0o644 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 80, mode: 0o664 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 80, mode: 0o666 }), ACCOUNT)).toBe(true);
  });
});

describe("inSystemArea", () => {
  it("names a folder below /private/var named after the account's GeneratedUID or uid", () => {
    for (const path of [
      `${DATA_VOLUME}/private/var/protected/trustd/private/${GUID}`,
      `${DATA_VOLUME}/private/var/protected/sfanalytics/${GUID.toLowerCase()}/trust_analytics.db`,
      `${DATA_VOLUME}/private/var/db/mds/messages/501/se_SecurityMessages`,
    ]) {
      expect(inSystemArea(path, ACCOUNT)).toBe(true);
    }
  });

  it("names no folder outside /private/var, of another account, or by a partial match", () => {
    for (const path of [
      `${DATA_VOLUME}/Users/Shared/${GUID}/x`,
      `${DATA_VOLUME}/Library/501/x`,
      `${DATA_VOLUME}/private/var/db/mds/messages/502/se_SecurityMessages`,
      `${DATA_VOLUME}/private/var/db/x5015/y`,
      `${DATA_VOLUME}/private/var/protected/trustd/private/${GUID}x/y`,
      `${DATA_VOLUME}/private/var/tmp/x`,
    ]) {
      expect(inSystemArea(path, ACCOUNT)).toBe(false);
    }
  });
});

describe("classifyEntry", () => {
  const classify = (entry) => classifyEntry("/x", ACCOUNT, () => entry);

  it("attributes what the account owns outside its areas, file or folder", () => {
    expect(classify(stats({ uid: 501 }))).toBe("owned");
    expect(classify(stats({ uid: 501, kind: "directory", mode: 0o755 }))).toBe("owned");
    const elsewhere = `${DATA_VOLUME}/private/var/db/keiko/x`;
    expect(classifyEntry(elsewhere, ACCOUNT, () => stats({ uid: 501 }))).toBe("owned");
  });

  it("lists what the account owns in a folder the system keeps for it apart", () => {
    const area = `${DATA_VOLUME}/private/var/protected/trustd/private/${GUID}/ocspcache.sqlite3`;
    expect(classifyEntry(area, ACCOUNT, () => stats({ uid: 501 }))).toBe("systemArea");
    // The same file of another account in that folder is no entry of the account.
    expect(classifyEntry(area, ACCOUNT, () => stats({ uid: 0, mode: 0o644 }))).toBe("others");
  });

  it("lists a regular file of another account that the account may also write apart", () => {
    expect(classify(stats({ mode: 0o666 }))).toBe("shared");
    expect(classify(stats({ uid: 502, gid: 20, mode: 0o664 }))).toBe("shared");
  });

  it("counts a folder, a socket or a protected file of another account apart", () => {
    expect(classify(stats({ kind: "directory", mode: 0o1777 }))).toBe("others");
    expect(classify(stats({ kind: "socket", mode: 0o777 }))).toBe("others");
    expect(classify(stats({ mode: 0o644 }))).toBe("others");
  });

  it("names an entry removed since the walk as gone", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(classifyEntry("/x", ACCOUNT, missing)).toBe("gone");
  });

  it("refuses an entry it could not inspect instead of calling it gone", () => {
    for (const code of ["EACCES", "EIO", "EPERM"]) {
      const failing = () => {
        throw Object.assign(new Error(code), { code });
      };
      expect(() => classifyEntry("/x", ACCOUNT, failing)).toThrow(FootprintRefusal);
    }
  });
});

describe("summarize", () => {
  it("counts every class and lists owned, system-area and shared paths, at most 200 each", () => {
    const kinds = { "/s": "systemArea", "/w": "shared", "/r": "others", "/g": "gone" };
    const owned = Array.from({ length: 250 }, (_, index) => `/o${String(index)}`);
    const paths = ["/s", "/w", "/r", "/g", ...owned];
    const summary = summarize(paths, (path) => kinds[path] ?? "owned");
    expect(summary.counts).toEqual({ owned: 250, systemArea: 1, shared: 1, others: 1, gone: 1 });
    expect(summary.violationCount).toBe(250);
    expect(summary.listed.owned).toHaveLength(200);
    expect(summary.listed.owned[0]).toBe("/o0");
    expect(summary.listed.systemArea).toEqual(["/s"]);
    expect(summary.listed.shared).toEqual(["/w"]);
  });

  it("fails only on what the account owns outside its areas", () => {
    expect(summarize(["/a", "/b"], () => "others").violationCount).toBe(0);
    expect(summarize(["/s", "/w"], (path) => (path === "/s" ? "systemArea" : "shared"))).toEqual(
      expect.objectContaining({ violationCount: 0 }),
    );
    expect(summarize(["/o"], () => "owned").violationCount).toBe(1);
  });
});

describe("findArguments", () => {
  it("walks one volume, prunes every own area and selects changes after the marker", () => {
    expect(findArguments("/V", ["/V/Users/q", "/V/private/var/folders/ab/cd"], "/m")).toEqual([
      "/V",
      "-xdev",
      "(",
      "-path",
      "/V/Users/q",
      "-o",
      "-path",
      "/V/private/var/folders/ab/cd",
      ")",
      "-prune",
      "-o",
      "(",
      "-newer",
      "/m",
      "-o",
      "-cnewer",
      "/m",
      ")",
      "-print0",
    ]);
  });
});

describe("findChanged", () => {
  // The real find: what the pruned area holds is never listed, and only changes after the marker are.
  function tree() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "footprint-walk-")));
    const volume = join(root, "volume");
    mkdirSync(join(volume, "own", "deep"), { recursive: true });
    mkdirSync(join(volume, "other"), { recursive: true });
    writeFileSync(join(volume, "own", "deep", "a.txt"), "a");
    writeFileSync(join(volume, "other", "b.txt"), "b");
    const marker = join(root, "marker");
    writeFileSync(marker, "");
    return { root, volume, marker };
  }

  function at(marker, secondsFromNow) {
    const time = Date.now() / 1000 + secondsFromNow;
    utimesSync(marker, time, time);
  }

  it("lists what changed after the marker outside the pruned area", () => {
    const { root, volume, marker } = tree();
    try {
      at(marker, -3600);
      const { paths, unreadable, vanished } = findChanged(volume, [join(volume, "own")], marker);
      expect(paths.sort()).toEqual([volume, join(volume, "other"), join(volume, "other", "b.txt")]);
      expect(unreadable + vanished).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists nothing that changed before the marker", () => {
    const { root, volume, marker } = tree();
    try {
      at(marker, 3600);
      expect(findChanged(volume, [join(volume, "own")], marker).paths).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("counts a folder it cannot read instead of failing", () => {
    const { root, volume, marker } = tree();
    const closed = join(volume, "other", "closed");
    mkdirSync(closed);
    writeFileSync(join(closed, "c.txt"), "c");
    chmodSync(closed, 0o000);
    try {
      at(marker, -3600);
      const { paths, unreadable } = findChanged(volume, [join(volume, "own")], marker);
      expect(unreadable).toBe(1);
      expect(paths).toContain(closed);
      expect(paths).not.toContain(join(closed, "c.txt"));
    } finally {
      chmodSync(closed, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("find's diagnostics", () => {
  it("counts unreadable folders and entries that vanished during the walk", () => {
    const stderr = [
      "find: /V/Users/runner/Library/Mail: Operation not permitted",
      "find: ‘/V/private/var/db/x’: Permission denied",
      "find: /V/private/var/tmp/gone: No such file or directory",
      "",
    ].join("\n");
    expect(classifyDiagnostics(stderr)).toEqual({ unreadable: 2, vanished: 1 });
    expect(classifyDiagnostics("")).toEqual({ unreadable: 0, vanished: 0 });
  });

  it("refuses any other diagnostic: the walk would be incomplete", () => {
    expect(() => classifyDiagnostics("find: /V/x: Input/output error\n")).toThrow(FootprintRefusal);
  });

  it("fails a walk that exited with an unknown error and listed nothing", () => {
    const run = () => ({ status: 1, stderr: "find: /V: Input/output error\n", stdout: "" });
    expect(() => findChanged("/V", [], "/m", run)).toThrow(FootprintRefusal);
    const silent = () => ({ status: 2, stderr: "", stdout: "" });
    expect(() => findChanged("/V", [], "/m", silent)).toThrow(FootprintRefusal);
  });

  it("keeps a walk whose only diagnostics are tolerated ones", () => {
    const run = () => ({
      status: 1,
      stderr: "find: /V/a: Operation not permitted\n",
      stdout: "/V/b\0/V/c\0",
    });
    expect(findChanged("/V", [], "/m", run)).toEqual({
      paths: ["/V/b", "/V/c"],
      unreadable: 1,
      vanished: 0,
    });
  });
});

describe("onDataVolume", () => {
  it("prefixes the data volume to a resolved path once", () => {
    const folder = mkdtempSync(join(tmpdir(), "footprint-"));
    try {
      const real = realpathSync(folder);
      expect(onDataVolume(folder, "/V")).toBe(join("/V", real));
      expect(onDataVolume(folder, real.split("/").slice(0, 2).join("/"))).toBe(real);
      expect(DATA_VOLUME).toBe("/System/Volumes/Data");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("accountAreas", () => {
  const answers = {
    "id -u keikoqa": "502",
    "id -G keikoqa": "20 12 61",
    "dscl . -read /Users/keikoqa NFSHomeDirectory": "NFSHomeDirectory: /Users/keikoqa",
    "dscl . -read /Users/keikoqa GeneratedUID": `GeneratedUID: ${GUID}`,
    "sudo -u keikoqa getconf DARWIN_USER_DIR": "/var/folders/ab/cdef/0/",
  };

  it("names the account's ids, its home and its per-user folder", () => {
    const run = (command, args) => answers[`${command} ${args.join(" ")}`] ?? "";
    expect(accountAreas("keikoqa", run)).toEqual({
      uid: 502,
      gids: [20, 12, 61],
      guid: GUID,
      roots: ["/Users/keikoqa", "/var/folders/ab/cdef"],
    });
  });

  it("refuses an account it cannot resolve", () => {
    const run = (command, args) =>
      command === "dscl" ? "" : (answers[`${command} ${args.join(" ")}`] ?? "");
    expect(() => accountAreas("keikoqa", run)).toThrow(FootprintRefusal);
  });

  it("refuses an account without a well-formed GeneratedUID", () => {
    const run = (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      return key.endsWith("GeneratedUID") ? "GeneratedUID: 501" : (answers[key] ?? "");
    };
    expect(() => accountAreas("keikoqa", run)).toThrow(FootprintRefusal);
  });
});
