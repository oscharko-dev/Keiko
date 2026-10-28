# Pinned ripgrep runtime and supply-chain evidence

This body-free record qualifies the search executable the OpenCode coding runtime runs (Epic
[#3897](https://github.com/oscharko-dev/Keiko/issues/3897), amending
[ADR-0163](../adr/ADR-0163-self-contained-release-qualified-coding-runtime.md) D1). The executable
sources of truth are:

- `packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts` (the approval table and the verifier);
- `scripts/provision-ripgrep.mjs`;
- `scripts/stage-portable-runtime.mjs` and `scripts/portable-runtime.mjs` (the `nativeTools`
  section);
- `scripts/build-coding-runtime-npm-package.mjs` (the npm runtime package); and
- `scripts/smoke-portable-ripgrep.mjs`.

## Why it is shipped

OpenCode's `glob` and `grep` tools and its file finder run ripgrep. The runtime resolves `rg` from
`PATH`, then from its own data directory, and otherwise downloads the GitHub release archive on
first use. Keiko runs the runtime loopback-only below Full access and customers sit behind
firewalls, so search would fail silently on an unprovisioned host. Keiko ships the identical
upstream release instead, pinned and SHA-256 verified like the USearch runtime
([ADR-0164](../adr/ADR-0164-one-bounded-in-memory-usearch-hnsw-runtime.md) D3), and never downloads
at run time.

## Pinned upstream

| Field          | Value                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| Version        | 15.1.0                                                                        |
| Source commit  | `af60c2de9d85e7f3d81c78601669468cf02dabab` (`rg --version`: `af60c2de9d`)     |
| License        | `Unlicense OR MIT`; Keiko ships the MIT text (`LICENSE-MIT`)                  |
| Shipped notice | `evidence/third-party-notices.txt` and `runtime/licenses/ripgrep/LICENSE-MIT` |

The MIT text is the one that requires its notice to travel with redistributed copies; the Unlicense
needs none, so shipping `LICENSE-MIT` satisfies both options of the dual license. Windows archives
carry CRLF text, so each target pins its own license digest.

## Platform assets

| Runtime target | Upstream archive                                  | Archive SHA-256                                                    | Executable SHA-256                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| macOS arm64    | `ripgrep-15.1.0-aarch64-apple-darwin.tar.gz`      | `378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715` | `4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94` |
| macOS x64      | `ripgrep-15.1.0-x86_64-apple-darwin.tar.gz`       | `64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882` | `3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50` |
| Linux arm64    | `ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz` | `2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e` | `968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69` |
| Linux x64      | `ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz` | `1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599` | `ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2` |
| Windows x64    | `ripgrep-15.1.0-x86_64-pc-windows-msvc.zip`       | `124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a` | `decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408` |
| Windows arm64  | `ripgrep-15.1.0-aarch64-pc-windows-msvc.zip`      | `00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e` | `f7799d737b520e00b10dfa72def23904fe66fb03315636a7b78549845ee9609c` |

The archives are the exact files OpenCode 2.1.4 would download from
`https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/`. The Linux x64 build is the
statically linked musl one; the Linux arm64 build is the upstream glibc one, as OpenCode selects.
The `LICENSE-MIT` digests are `0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f`
for the four LF archives and `970813655a1bf777d2ead189cef71ab73ab92ce04dc864027d61a45de03e6728`
for the two Windows archives.

## How the digests were obtained

Each archive was downloaded once from the official release into its own empty directory and treated
as untrusted data. Its SHA-256 was computed locally and compared with three independent sources:
the digest GitHub's release API publishes for the asset, the `.sha256` file the project publishes
next to the asset, and the asset size. Only the approved members (`rg`/`rg.exe` and `LICENSE-MIT`)
were extracted, into a second fresh directory, and hashed. The upstream tag resolves to the pinned
commit, and the macOS arm64 executable reports `ripgrep 15.1.0 (rev af60c2de9d)`. Nothing else was
executed.

## Controls

- `npm run provision:ripgrep` downloads only the approved HTTPS URL for the host, verifies the
  archive, extracts only the two approved members into a private temporary directory, refuses a
  link in place of a member, verifies both files and the executable size again, installs them under
  the gitignored `.ripgrep/15.1.0/<target>/`, and accepts its own output only through the product
  verifier. A cache hit is never qualification: every run re-verifies.
- The product verifier (`resolveVerifiedRipgrep`) accepts a regular file, never a symlink, in a
  regular directory owned by the current user or root with no group/world write bit on POSIX,
  bounded in size, whose bytes hash to the pinned digest (or to the activation-bound digest after a
  platform signature rewrote the executable). It returns a closed, body-free reason otherwise.
- Portable staging copies the verified files to `runtime/native/rg` (`rg.exe` on Windows) and
  `runtime/licenses/ripgrep/LICENSE-MIT`, re-verifies the copied bytes, and adds the tool to the
  manifest's `nativeTools`, the activation manifest, `reviewedBinding`, provenance, the CycloneDX
  SBOM and the third-party notices. Platform signing rewrites only `shippedSha256`;
  `unsignedSha256` keeps the upstream identity.
- The npm runtime package (`@oscharko-dev/keiko-coding-runtime-<target>`, ADR-0140 D2a) carries the
  same unmodified upstream executable at `runtime/native/rg`, its MIT text at
  `runtime/licenses/ripgrep/LICENSE-MIT` and a CycloneDX record of the component at
  `runtime/licenses/ripgrep/sbom.cdx.json`. `scripts/build-coding-runtime-npm-package.mjs` provisions
  the TARGET's release (one Mac builds both architectures), stages it through the same
  `stageRipgrepTool` the portable build uses, and refuses to seal a candidate whose executable,
  license or component record differs from the pinned digests, whose executable lost its permission
  bit, or that lacks any of the three files. The sealed `receipt.json` binds the pinned release.
  The package ships no signature, so no activation-bound digest applies there: only the pinned
  upstream bytes verify.
- `scripts/smoke-portable-ripgrep.mjs` starts the staged executable outside `PATH` and the user's
  ripgrep configuration and makes it report the approved release, find text, list files and exit 1
  on a miss.

## Launch wiring

Every OpenCode launch resolves one verified ripgrep before the child starts
(`packages/keiko-server/src/coding-runtime/opencodeRipgrepLaunch.ts`):

- A packaged runtime verifies `runtime/native/rg` against the digest the signed activation manifest
  binds. A development checkout verifies `.ripgrep/<version>/<target>/` against the pinned upstream
  digest. An npm runtime package verifies `<package>/runtime/native/rg` against the pinned upstream
  digest at every run launch, with the package root derived from the activated runtime
  (`npmLanePackageRoot`); the lane's native-directory check admits that one file name beside the
  secure-read helper and judges nothing else about it, so a missing, tampered or linked `rg` degrades
  search with a closed reason and never takes the engine away. A package published before ripgrep
  shipped in it simply reports `missing`. `KEIKO_RIPGREP_BINARY_PATH` is honoured for non-packaged
  lanes only, and only for a file that passes the same verifier; a packaged runtime ignores it.
- Only the verified executable's directory is prepended to the child `PATH`, for the native and the
  mapped profile. The native macOS Seatbelt read allowlist is derived from that same `PATH`, so it
  admits exactly that directory and nothing wider. The mapped macOS profile cannot execute `rg` at
  all (its exec allowlist is the runtime and Git), so mapped search stays degraded there.
- An unverified ripgrep never blocks the run. The directory is not added, the runtime keeps starting
  with search degraded, and the closed reason is recorded. A degraded native launch also drops every
  inherited `PATH` entry that provides an `rg` (and every empty or relative entry), so a host
  ripgrep is never executed unverified. Every degraded launch also places a refusing `rg`
  placeholder in the run's private OpenCode `bin` directory, which OpenCode checks before it would
  download one, so no profile (Full access included) fetches ripgrep at run time; search then fails
  with a fixed message.
- `coding-runtime.ripgrep.resolved` records once per launch the outcome (`verified`/`unverified`),
  the closed `reason`, the `layout` (`portable`/`provisioned`/`npm-package`/`override`/`none`), the
  digest source, the version and the target class. It never records a path, a digest or a command
  line.

## CI

`npm run provision:ripgrep` is a setup step, immediately before the work that needs the binary, in
the portable-assets stage jobs (`stage`, `stage-linux-manual`, `stage-linux-production`), the
pull-request customer-shape job (`qualify`) and the release customer-shape job
(`qualify-customer-shape`). The stage jobs also run `scripts/smoke-portable-ripgrep.mjs` against the
staged tree. The customer-shape qualifier installs the npm package together with the runtime
packages the root manifest pins. Those pins still name the published packages that predate the
bundled ripgrep, so the qualifier verifies the provisioned copy and hands it to the runtime through
`KEIKO_RIPGREP_BINARY_PATH`; a missing or tampered copy fails before the journey starts. The
override is dropped in the change that moves the pins to the republished runtime packages, which
makes that journey the clean, override-free offline proof.
