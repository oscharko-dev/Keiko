import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeHomeDeniedReadRoots,
  nativeOpenSslNodeOptions,
  nativeOpenSslReadRoots,
  nativeToolchainReadRoots,
} from "./native-toolchain-roots.js";

describe("nativeToolchainReadRoots", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-toolchain-roots-")));
    created.push(root);
    return root;
  }

  it("maps bin directories to their install prefix and resolves symlinks", () => {
    const root = tree();
    mkdirSync(join(root, "nvm", "v24", "bin"), { recursive: true });
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    symlinkSync(join(root, "nvm", "v24", "bin"), join(root, "current-bin"));
    const path = [join(root, "current-bin"), join(root, "tools", "bin")].join(delimiter);
    expect(nativeToolchainReadRoots(path, join(root, "home"))).toEqual([
      join(root, "nvm", "v24"),
      join(root, "tools"),
    ]);
  });

  const brewPrefix = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\//u.exec(process.execPath)?.[1];

  it.skipIf(brewPrefix === undefined)(
    "uses the Homebrew prefix for a Cellar keg so sibling libraries stay readable",
    () => {
      expect(nativeToolchainReadRoots(dirname(process.execPath), "/Users/nobody")).toEqual([
        brewPrefix,
      ]);
    },
  );

  it("never returns the home directory, one of its ancestors or a system prefix", () => {
    const root = tree();
    mkdirSync(join(root, "home", "bin"), { recursive: true });
    const home = join(root, "home");
    // `~/bin` -> `~` would open the whole home; the directory itself is kept instead.
    expect(nativeToolchainReadRoots(join(home, "bin"), home)).toEqual([join(home, "bin")]);
    expect(nativeToolchainReadRoots(home, home)).toEqual([]);
    expect(
      nativeToolchainReadRoots(["/usr/bin", "/bin", "/usr/local/bin"].join(delimiter), home),
    ).toEqual([]);
    expect(nativeToolchainReadRoots(root, join(root, "home"))).toEqual([]);
  });

  // #3897 review (P1): a generic user bin directory must not open its parent, which holds the
  // user's own data (`~/.local/share/opencode/auth.json`, `~/.local/state/gh`, `~/.cargo/credentials.toml`).
  it("admits only the bin directory itself for a user-generic bin directory under the home", () => {
    const root = tree();
    const home = join(root, "home");
    const generic = [".local/bin", ".cargo/bin", "bin", "go/bin", ".bun/bin", ".volta/bin"];
    for (const entry of generic) mkdirSync(join(home, entry), { recursive: true });
    const path = generic.map((entry) => join(home, entry)).join(delimiter);
    expect(nativeToolchainReadRoots(path, home)).toEqual(
      generic.map((entry) => join(home, entry)).sort(),
    );
  });

  it("derives an install prefix from version-manager and JDK layouts below the home", () => {
    const root = tree();
    const home = join(root, "home");
    const prefixes = [
      join(home, ".nvm", "versions", "node", "v24.1.0"),
      join(home, ".sdkman", "candidates", "java", "21.0.2-tem"),
      join(home, ".local", "share", "fnm", "node-versions", "v24.1.0", "installation"),
      join(home, ".rustup", "toolchains", "stable-aarch64-apple-darwin"),
    ];
    for (const prefix of prefixes) mkdirSync(join(prefix, "bin"), { recursive: true });
    const path = prefixes.map((prefix) => join(prefix, "bin")).join(delimiter);
    expect(nativeToolchainReadRoots(path, home)).toEqual([...prefixes].sort());
  });

  it("derives the install prefix of a layout outside the home and keeps the Homebrew prefix shared", () => {
    const root = tree();
    const jdk = join(root, "Library", "Java", "jdk-21.jdk", "Contents", "Home");
    mkdirSync(join(jdk, "bin"), { recursive: true });
    mkdirSync(join(root, "opt", "tools", "bin"), { recursive: true });
    const path = [join(jdk, "bin"), join(root, "opt", "tools", "bin")].join(delimiter);
    expect(nativeToolchainReadRoots(path, join(root, "home"))).toEqual(
      [jdk, join(root, "opt", "tools")].sort(),
    );
  });

  it("never admits a credential store or the user's other agent state, as a root or inside one", () => {
    const root = tree();
    const home = join(root, "home");
    for (const entry of [
      ".docker/bin",
      ".cargo/bin",
      ".local/share/opencode/bin",
      ".config/gh/bin",
    ])
      mkdirSync(join(home, entry), { recursive: true });
    const roots = nativeToolchainReadRoots(
      [".docker/bin", ".cargo/bin", ".local/share/opencode/bin", ".config/gh/bin"]
        .map((entry) => join(home, entry))
        .join(delimiter),
      home,
    );
    // `~/.cargo/bin` is allowed beside the denied `credentials*` files in its parent; the three
    // entries that sit inside a denied store are not roots at all.
    expect(roots).toEqual([join(home, ".cargo", "bin")]);
    for (const denied of nativeHomeDeniedReadRoots(home))
      for (const entry of roots) {
        expect(entry === denied || entry.startsWith(`${denied}/`)).toBe(false);
        expect(denied.startsWith(`${entry}/`)).toBe(false);
      }
  });

  it("lists the credential stores and the user's agent state the native profile denies", () => {
    expect(nativeHomeDeniedReadRoots("/Users/synthetic")).toEqual(
      expect.arrayContaining([
        "/Users/synthetic/.ssh",
        "/Users/synthetic/.config/gh",
        "/Users/synthetic/.cargo/credentials",
        "/Users/synthetic/.cargo/credentials.toml",
        "/Users/synthetic/.local/share/opencode",
        "/Users/synthetic/.local/state/gh",
        "/Users/synthetic/Library/Keychains",
      ]),
    );
  });

  it("follows links in a generic bin directory only into the bin directory of a real install prefix", () => {
    const root = tree();
    const home = join(root, "home");
    const bin = join(home, ".local", "bin");
    const install = join(home, "tools", "python312");
    const shallow = join(home, ".opencode");
    const stateBin = join(home, ".local", "share", "opencode", "bin");
    const versions = join(home, ".local", "share", "claude", "versions");
    for (const directory of [bin, join(install, "bin"), join(shallow, "bin"), stateBin, versions])
      mkdirSync(directory, { recursive: true });
    for (const file of [
      join(install, "bin", "python"),
      join(shallow, "bin", "tool"),
      join(stateBin, "opencode"),
      join(versions, "2.1.309"),
    ])
      writeFileSync(file, "synthetic");
    symlinkSync(join(install, "bin", "python"), join(bin, "python"));
    symlinkSync(join(shallow, "bin", "tool"), join(bin, "tool"));
    symlinkSync(join(stateBin, "opencode"), join(bin, "opencode"));
    symlinkSync(join(versions, "2.1.309"), join(bin, "claude"));
    symlinkSync(join(root, "missing"), join(bin, "dangling"));
    expect(nativeToolchainReadRoots(bin, home)).toEqual([bin, install].sort());
  });

  it("bounds the roots and tolerates an unreadable generic bin directory", () => {
    const root = tree();
    const home = join(root, "home");
    const entries = Array.from({ length: 80 }, (_, index) =>
      join(home, `.tools-${String(index)}`, "versions", "v1", "bin"),
    );
    for (const entry of entries) mkdirSync(entry, { recursive: true });
    expect(nativeToolchainReadRoots(entries.join(delimiter), home)).toHaveLength(64);
    expect(nativeToolchainReadRoots(join(home, "missing", "bin"), home)).toEqual([]);
  });

  it("ignores relative, missing and empty entries and removes nested duplicates", () => {
    const root = tree();
    mkdirSync(join(root, "a", "bin"), { recursive: true });
    mkdirSync(join(root, "a", "extra", "bin"), { recursive: true });
    const path = ["", "relative/bin", join(root, "missing", "bin"), join(root, "a", "bin")]
      .concat(join(root, "a", "extra", "bin"))
      .join(delimiter);
    expect(nativeToolchainReadRoots(path, "/Users/nobody")).toEqual([join(root, "a")]);
    expect(nativeToolchainReadRoots(undefined, "/Users/nobody")).toEqual([]);
  });
});

// #3901 AC4: an operator's explicit OpenSSL configuration opens read-only, under the toolchain rule.
describe("nativeOpenSslReadRoots", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-openssl-roots-")));
    created.push(root);
    return root;
  }

  it("opens the configuration's directory, its include directory and the modules", () => {
    const root = tree();
    mkdirSync(join(root, "ssl", "conf.d"), { recursive: true });
    mkdirSync(join(root, "ossl-modules"), { recursive: true });
    writeFileSync(join(root, "ssl", "openssl.cnf"), "");
    symlinkSync(join(root, "ssl", "openssl.cnf"), join(root, "linked.cnf"));
    expect(
      nativeOpenSslReadRoots(
        {
          OPENSSL_CONF: join(root, "linked.cnf"),
          OPENSSL_CONF_INCLUDE: join(root, "ssl", "conf.d"),
          OPENSSL_MODULES: join(root, "ossl-modules"),
        },
        join(root, "home"),
      ),
    ).toEqual([join(root, "ossl-modules"), join(root, "ssl"), join(root, "ssl", "conf.d")]);
  });

  it("follows --openssl-config only in NODE_OPTIONS that is nothing but OpenSSL switches", () => {
    const root = tree();
    mkdirSync(join(root, "fips"), { recursive: true });
    writeFileSync(join(root, "fips", "node.cnf"), "");
    const config = `--openssl-config=${join(root, "fips", "node.cnf")}`;
    const home = join(root, "home");
    expect(nativeOpenSslReadRoots({ NODE_OPTIONS: `${config} --enable-fips` }, home)).toEqual([
      join(root, "fips"),
    ]);
    expect(nativeOpenSslReadRoots({ NODE_OPTIONS: `${config} --require x.js` }, home)).toEqual([]);
  });

  it("never opens the home, a system prefix, a credential store, or a relative or missing path", () => {
    const root = tree();
    const home = join(root, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "openssl.cnf"), "");
    writeFileSync(join(home, "openssl.cnf"), "");
    expect(
      nativeOpenSslReadRoots(
        {
          OPENSSL_CONF: join(home, "openssl.cnf"),
          OPENSSL_CONF_INCLUDE: join(home, ".ssh"),
          OPENSSL_MODULES: "/usr/lib",
        },
        home,
      ),
    ).toEqual([]);
    expect(
      nativeOpenSslReadRoots(
        { OPENSSL_CONF: "relative.cnf", OPENSSL_MODULES: join(root, "missing") },
        home,
      ),
    ).toEqual([]);
    expect(nativeOpenSslReadRoots({}, home)).toEqual([]);
  });

  it("recognizes NODE_OPTIONS made only of Node's OpenSSL and FIPS switches", () => {
    expect(nativeOpenSslNodeOptions("--openssl-shared-config")).toBe(true);
    expect(nativeOpenSslNodeOptions(" --enable-fips  --openssl-config=/etc/ssl/fips.cnf ")).toBe(
      true,
    );
    expect(nativeOpenSslNodeOptions("--force-fips --max-old-space-size=64")).toBe(false);
    expect(nativeOpenSslNodeOptions("--require ./hook.js")).toBe(false);
    expect(nativeOpenSslNodeOptions("")).toBe(false);
    expect(nativeOpenSslNodeOptions(undefined)).toBe(false);
  });
});
