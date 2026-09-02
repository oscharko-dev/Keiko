// Deterministic pins for the managed-worktree identity (#3347 follow-up).
//
// The filesystem-level pin in workspace-root-access.test.ts stages a real delete-and-recreate and
// asks the OS for the outcome. That makes its verdict depend on whether the filesystem happens to
// hand out a fresh inode: ext4/overlayfs reuses the number (measured 50/50 on Linux), APFS does
// not. The pin therefore PASSED on macOS while the product accepted a replaced worktree on Linux,
// and the hole stayed invisible to every local run until CI on dev went red.
//
// These pins take the filesystem out of the verdict. They drive the real production entry point,
// `inspectManagedGitdirIdentity`, through an injected port whose stat values are written by hand,
// so "the inode was reused" is an input rather than something the test hopes for.
import { describe, expect, it } from "vitest";
import type {
  WorkspaceDescriptorUtf8Read,
  WorkspaceDirEntry,
  WorkspaceFs,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  inspectManagedGitdirIdentity,
  inspectManagedGitdirIdentityOutcome,
  managedIdentityDrift,
  type ManagedGitdirIdentityInspection,
} from "./gitdir-identity.js";

const REPOSITORY_ROOT = "/repo";
const COMMON_DIRECTORY = "/repo/.git";
const ADMIN_DIRECTORY = "/repo/.git/worktrees/ws";
const WORKTREE_ROOT = "/work/ws";
const WORKTREE_POINTER = `${WORKTREE_ROOT}/.git`;
const ADMIN_BACKPOINTER = `${ADMIN_DIRECTORY}/gitdir`;

interface Node {
  readonly kind: "directory" | "file";
  identity: string;
  birthtimeNs: string | undefined;
  ctimeNs: string | undefined;
  text: string;
}

function directory(identity: string): Node {
  return { kind: "directory", identity, birthtimeNs: "500", ctimeNs: "1000", text: "" };
}

function file(identity: string, birthtimeNs: string | undefined, text: string): Node {
  return { kind: "file", identity, birthtimeNs, ctimeNs: "1000", text };
}

// One authentic linked worktree: /work/ws points at /repo/.git/worktrees/ws, which points back.
function authenticTree(): Map<string, Node> {
  return new Map<string, Node>([
    [REPOSITORY_ROOT, directory("1:10")],
    [COMMON_DIRECTORY, directory("1:11")],
    ["/repo/.git/worktrees", directory("1:12")],
    [ADMIN_DIRECTORY, directory("1:13")],
    [ADMIN_BACKPOINTER, file("1:14", "104", `${WORKTREE_ROOT}/.git\n`)],
    [WORKTREE_ROOT, directory("1:15")],
    [WORKTREE_POINTER, file("1:16", "106", `gitdir: ${ADMIN_DIRECTORY}\n`)],
  ]);
}

function statOf(node: Node): WorkspaceStat {
  return {
    size: node.text.length,
    isFile: node.kind === "file",
    isDirectory: node.kind === "directory",
    isSymbolicLink: false,
    hardLinkCount: 1,
    fileIdentity: node.identity,
    mtimeNs: node.ctimeNs,
    ...(node.ctimeNs === undefined ? {} : { ctimeNs: node.ctimeNs }),
    ...(node.birthtimeNs === undefined ? {} : { birthtimeNs: node.birthtimeNs }),
  };
}

function portFor(tree: Map<string, Node>): WorkspaceFs {
  const nodeAt = (path: string): Node => {
    const node = tree.get(path);
    if (node === undefined) throw new Error(`ENOENT: ${path}`);
    return node;
  };
  return {
    readFileUtf8: (path: string): string => nodeAt(path).text,
    stat: (path: string): WorkspaceStat => statOf(nodeAt(path)),
    readDir: (): readonly WorkspaceDirEntry[] => [],
    realPath: (path: string): string => path,
    exists: (path: string): boolean => tree.has(path),
    readFileUtf8WithinRootSameDescriptor: (
      _canonicalRoot: string,
      absolutePath: string,
    ): WorkspaceDescriptorUtf8Read => {
      const node = nodeAt(absolutePath);
      return { rawText: node.text, sizeBytes: node.text.length, stat: statOf(node) };
    },
  };
}

function inspect(tree: Map<string, Node>): ManagedGitdirIdentityInspection | undefined {
  return inspectManagedGitdirIdentity(WORKTREE_ROOT, REPOSITORY_ROOT, portFor(tree));
}

function identityOf(tree: Map<string, Node>): string | undefined {
  return inspect(tree)?.identity;
}

function mutate(tree: Map<string, Node>, path: string, change: Partial<Node>): Map<string, Node> {
  const node = tree.get(path);
  if (node === undefined) throw new Error(`fixture has no node at ${path}`);
  tree.set(path, { ...node, ...change });
  return tree;
}

describe("inspectManagedGitdirIdentity — a reused inode no longer replays an identity", () => {
  it("derives an identity for an authentic linked worktree", () => {
    expect(identityOf(authenticTree())).toEqual(expect.any(String));
  });

  it("is stable when nothing about the worktree changes", () => {
    expect(identityOf(authenticTree())).toBe(identityOf(authenticTree()));
  });

  // The defect this file exists for. The worktree root and its `.git` pointer both keep their exact
  // inode — the replacement won the slot back, which is the ordinary case on ext4/overlayfs — and
  // the pointer bytes are copied verbatim.
  it("separates a same-path replacement that reuses the inode and copies the pointer bytes", () => {
    const authentic = identityOf(authenticTree());
    const replaced = authenticTree();
    mutate(replaced, WORKTREE_ROOT, { birthtimeNs: "900" });
    mutate(replaced, WORKTREE_POINTER, { birthtimeNs: "901" });

    expect(authentic).toBeDefined();
    expect(identityOf(replaced)).not.toBe(authentic);
  });

  // The RELOCATION attack, reported by review against the pointer-only version of this guard and
  // reproduced on Linux before this pin was written. The attacker never creates a pointer: they move
  // the original `.git` out, recreate the directory until the inode is handed back, then move the
  // same file in again. `rename` preserves both the inode and the birthtime, so every pointer
  // component still matches and only the ROOT DIRECTORY's creation time betrays the new generation.
  it("separates a replacement that moves the ORIGINAL pointer back into a recreated root", () => {
    const authentic = identityOf(authenticTree());
    // Pointer untouched — same inode, same birthtime, same bytes, exactly as `rename` leaves it.
    const relocated = mutate(authenticTree(), WORKTREE_ROOT, { birthtimeNs: "900" });

    expect(relocated.get(WORKTREE_POINTER)).toEqual(authenticTree().get(WORKTREE_POINTER));
    expect(identityOf(relocated)).not.toBe(authentic);
  });

  it("separates a replaced admin directory through its recreated backpointer", () => {
    const authentic = identityOf(authenticTree());
    const replaced = mutate(authenticTree(), ADMIN_BACKPOINTER, { birthtimeNs: "900" });

    expect(identityOf(replaced)).not.toBe(authentic);
  });

  // Availability, not just integrity. Padding the pointer with whitespace leaves the target it
  // names unchanged; it is an in-place rewrite, so the inode and the creation time both survive.
  // Binding to ctime instead would let anyone able to write one byte into the pointer force every
  // workspace into recovery — a denial of service dressed as an integrity check.
  it("keeps the identity when the pointer is rewritten in place", () => {
    const authentic = identityOf(authenticTree());
    const padded = mutate(authenticTree(), WORKTREE_POINTER, {
      text: `gitdir:${" ".repeat(64)}${ADMIN_DIRECTORY}\n`,
      ctimeNs: "999999",
    });

    expect(identityOf(padded)).toBe(authentic);
  });

  // Inode binding is kept, not replaced: a replacement that does NOT win the old inode back is
  // still caught by the component it always was.
  it.each([
    { label: "the worktree root", path: WORKTREE_ROOT },
    { label: "the Git common directory", path: COMMON_DIRECTORY },
    { label: "the Git admin directory", path: ADMIN_DIRECTORY },
    { label: "the worktree .git pointer", path: WORKTREE_POINTER },
  ])("separates a replacement of $label that takes a fresh inode", ({ path }) => {
    const authentic = identityOf(authenticTree());
    const replaced = mutate(authenticTree(), path, { identity: "9:99" });

    expect(identityOf(replaced)).not.toBe(authentic);
  });

  // The false-denial guard, and the reason DIRECTORIES are not bound to a timestamp. A directory's
  // ctime and mtime move whenever an entry is created or removed inside it, so binding a long-lived
  // worktree root to either would refuse every healthy workspace the moment a user saved a file at
  // its root. The pointer FILES are safe to bind because nothing rewrites them in normal operation.
  it.each([
    { label: "the worktree root", path: WORKTREE_ROOT },
    { label: "the Git common directory", path: COMMON_DIRECTORY },
    { label: "the Git admin directory", path: ADMIN_DIRECTORY },
  ])("keeps the identity when ordinary writes move $label's ctime", ({ path }) => {
    const authentic = identityOf(authenticTree());
    const written = mutate(authenticTree(), path, { ctimeNs: "999999" });

    expect(identityOf(written)).toBe(authentic);
  });

  // A port that cannot stamp its pointer files must not be served a weaker identity silently: that
  // is exactly the inode-only comparison this change removed.
  it.each([
    { label: "worktree root", path: WORKTREE_ROOT },
    { label: "worktree .git pointer", path: WORKTREE_POINTER },
    { label: "Git admin directory", path: ADMIN_DIRECTORY },
    { label: "admin gitdir backpointer", path: ADMIN_BACKPOINTER },
    { label: "Git common directory", path: COMMON_DIRECTORY },
  ])("fails closed when the $label reports no creation time", ({ path }) => {
    const unstamped = mutate(authenticTree(), path, { birthtimeNs: undefined });

    expect(identityOf(unstamped)).toBeUndefined();
  });

  // Anti-vacuity guard. If a pointer rule and the ctime requirement could both refuse, a filesystem
  // that failed the second would make every pointer rule stop being tested while still looking
  // green. This pins that a malformed pointer is refused on its own merits, ctime available.
  it("refuses a malformed pointer on its own merits, not for a missing stamp", () => {
    const malformed = mutate(authenticTree(), WORKTREE_POINTER, {
      text: "gitdir: relative/admin-dir\n",
    });

    expect(identityOf(malformed)).toBeUndefined();
    expect([...malformed.values()].every((node) => node.birthtimeNs !== undefined)).toBe(true);
  });
});

describe("legacy identity — recognises a superseded registration without trusting it", () => {
  // An EXTERNAL anchor, not a restatement: this constant was produced by the retired v2 algorithm
  // itself (git show <pre-fix>:…/gitdir-identity.ts — the `identityFor` that hashed
  // [schema, adminDir, commonPath, commonIdentity, worktree, pointer, admin, backpointer]) run over
  // this fixture's inode values. If the legacy composition ever drifts from what v2 actually wrote,
  // the schema-retired classification silently stops firing and every upgrading operator is told
  // their worktree was replaced. Only a value derived outside this file can catch that.
  const V2_GOLDEN_IDENTITY = "43c278d63f268dea2f726cdbef803cda";

  it("reproduces the retired v2 composition exactly", () => {
    expect(inspect(authenticTree())?.legacyIdentity).toBe(V2_GOLDEN_IDENTITY);
  });

  it("is not the identity that grants access", () => {
    const inspection = inspect(authenticTree());

    expect(inspection?.legacyIdentity).toEqual(expect.any(String));
    expect(inspection?.legacyIdentity).not.toBe(inspection?.identity);
  });

  // The property that lets it recognise a pre-v3 record: it is blind to the pointer stamps, exactly
  // as the retired composition was. If it ever started tracking them it would stop matching the
  // persisted values it exists to identify, and the upgrade diagnosis would vanish.
  it("is unchanged by the pointer stamps that the current identity binds", () => {
    const replaced = mutate(authenticTree(), WORKTREE_POINTER, { birthtimeNs: "900" });

    expect(inspect(replaced)?.legacyIdentity).toBe(inspect(authenticTree())?.legacyIdentity);
    expect(inspect(replaced)?.identity).not.toBe(inspect(authenticTree())?.identity);
  });

  it("still tracks the inodes the retired composition did bind", () => {
    const replaced = mutate(authenticTree(), WORKTREE_ROOT, { identity: "9:99" });

    expect(inspect(replaced)?.legacyIdentity).not.toBe(inspect(authenticTree())?.legacyIdentity);
  });
});

// One owner for the three-way verdict. The access boundary, the provisioning resume and
// reconciliation all compare a persisted identity, and they have to agree — a site that reduces this
// to a boolean is how "registered under the old rule" gets reported as "your worktree was replaced".
describe("managedIdentityDrift", () => {
  it("matches a current identity", () => {
    const inspection = inspect(authenticTree());
    if (inspection === undefined) throw new Error("fixture produced no identity");

    expect(managedIdentityDrift(inspection, inspection.identity)).toBe("matches");
  });

  it("recognises an identity persisted under the retired rule", () => {
    const inspection = inspect(authenticTree());
    if (inspection === undefined) throw new Error("fixture produced no identity");

    expect(managedIdentityDrift(inspection, inspection.legacyIdentity)).toBe("schema-retired");
  });

  it("reports anything else as changed", () => {
    expect(managedIdentityDrift(inspect(authenticTree()), "not-an-identity")).toBe("changed");
  });

  // An unreadable or unprovable worktree is never "just an old registration": with nothing to
  // compare against, the only honest verdict is the one that refuses without excusing it.
  it("reports changed when the worktree proves no identity at all", () => {
    expect(managedIdentityDrift(undefined, "anything")).toBe("changed");
  });
});

// A refusal caused by the platform and a refusal caused by a replaced worktree need different
// operator actions, so the reason has to come out of the pass that failed. An earlier version probed
// two of the five hashed objects separately and mislabelled the rest; these hold the classification
// to every component the inspection actually consults.
describe("inspectManagedGitdirIdentityOutcome", () => {
  const outcomeOf = (tree: Map<string, Node>): string =>
    inspectManagedGitdirIdentityOutcome(WORKTREE_ROOT, REPOSITORY_ROOT, portFor(tree)).kind;

  it("identifies an authentic worktree", () => {
    expect(outcomeOf(authenticTree())).toBe("identified");
  });

  it.each([
    { label: "worktree root", path: WORKTREE_ROOT },
    { label: "worktree .git pointer", path: WORKTREE_POINTER },
    { label: "Git admin directory", path: ADMIN_DIRECTORY },
    { label: "admin gitdir backpointer", path: ADMIN_BACKPOINTER },
    { label: "Git common directory", path: COMMON_DIRECTORY },
  ])("reports a platform limit when the $label reports no creation time", ({ path }) => {
    expect(outcomeOf(mutate(authenticTree(), path, { birthtimeNs: undefined }))).toBe(
      "unsupported",
    );
  });

  // The other half: a refusal that is NOT the platform's fault must not be excused as one.
  it("reports unproven for a malformed pointer while every stamp is present", () => {
    const malformed = mutate(authenticTree(), WORKTREE_POINTER, {
      text: "gitdir: relative/admin-dir\n",
    });

    expect(outcomeOf(malformed)).toBe("unproven");
  });

  it("reports unproven when the backpointer does not point back", () => {
    const broken = mutate(authenticTree(), ADMIN_BACKPOINTER, { text: "/elsewhere/ws/.git\n" });

    expect(outcomeOf(broken)).toBe("unproven");
  });
});

// A `WorkspaceFs` may be a class instance, and its methods then live on the prototype. The outcome
// classifier wraps the port to observe one pass; a `{ ...fs }` spread would copy only own enumerable
// properties — measured on a prototype-backed port: zero methods survive — and the inspection would
// throw, be swallowed by its own catch, and report an authentic worktree as unproven. That is a
// fail-closed for a reason that has nothing to do with the worktree.
describe("port shape — a prototype-backed WorkspaceFs keeps its methods", () => {
  class PrototypeBackedPort implements WorkspaceFs {
    public constructor(private readonly tree: Map<string, Node>) {}
    private nodeAt(path: string): Node {
      const node = this.tree.get(path);
      if (node === undefined) throw new Error(`ENOENT: ${path}`);
      return node;
    }
    public readFileUtf8(path: string): string {
      return this.nodeAt(path).text;
    }
    public stat(path: string): WorkspaceStat {
      return statOf(this.nodeAt(path));
    }
    public readDir(): readonly WorkspaceDirEntry[] {
      return [];
    }
    public realPath(path: string): string {
      return path;
    }
    public exists(path: string): boolean {
      return this.tree.has(path);
    }
    public readFileUtf8WithinRootSameDescriptor(
      _canonicalRoot: string,
      absolutePath: string,
    ): WorkspaceDescriptorUtf8Read {
      const node = this.nodeAt(absolutePath);
      return { rawText: node.text, sizeBytes: node.text.length, stat: statOf(node) };
    }
  }

  it("identifies an authentic worktree through a class-based port", () => {
    const port = new PrototypeBackedPort(authenticTree());

    expect(inspectManagedGitdirIdentityOutcome(WORKTREE_ROOT, REPOSITORY_ROOT, port).kind).toBe(
      "identified",
    );
  });

  it("still separates a replacement seen through a class-based port", () => {
    const authentic = new PrototypeBackedPort(authenticTree());
    const replaced = new PrototypeBackedPort(
      mutate(authenticTree(), WORKTREE_ROOT, { birthtimeNs: "900" }),
    );
    const identityOfPort = (port: WorkspaceFs): string | undefined =>
      inspectManagedGitdirIdentity(WORKTREE_ROOT, REPOSITORY_ROOT, port)?.identity;

    expect(identityOfPort(authentic)).toBeDefined();
    expect(identityOfPort(replaced)).not.toBe(identityOfPort(authentic));
  });
});
