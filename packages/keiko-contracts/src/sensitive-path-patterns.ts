// The ONE list of sensitive path-name patterns (ADR-0005 D3, ADR-0129 D3). A pattern names a path
// SEGMENT (a file or directory name, `*` matching within one segment); a denied directory denies
// everything under it. Two consumers read this module and nothing else defines the names:
//   - keiko-workspace's `isDenied` (discovery, search, grounding and the native tool policy) denies
//     every pattern here, credential or not.
//   - keiko-sandbox's native Seatbelt profile (#3897) turns the CREDENTIAL patterns into kernel
//     read/write denials, so a shell child, an interpreter and a descendant are bound by the same
//     exclusions as the native read tool.
// The split is the only judgement: a credential pattern names a file whose content is a secret by
// convention and that no build, test or toolchain needs to open; a tool-state pattern names state
// the toolchain itself reads and writes (`.git`, `node_modules`, caches), which the kernel boundary
// cannot deny without breaking the work it exists to allow.

/** Names whose content is a credential by convention. Kernel-enforced for the native runtime. */
export const CREDENTIAL_PATH_DENY_PATTERNS: readonly string[] = Object.freeze([
  // secrets
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "*.p12",
  "*.pfx",
  ".npmrc",
  // credential directories & stores — Epic #532 makes any folder on the machine connectable, so
  // the deny gate must keep well-known secret locations out of every tree listing, excerpt, and
  // grounded answer even when the user points a Files window at their home directory.
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".docker",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  "Keychains",
  "*.keychain",
  "*.keychain-db",
  "*.keystore",
  "*.jks",
  // Epic #532 security audit (H1/M1): additional well-known credential stores reachable when a
  // user connects their home directory.
  ".terraform.d",
  ".vault-token",
  ".pypirc",
  ".password-store",
  "id_ecdsa_sk",
  "id_ed25519_sk",
  // Epic #532 security audit (H1): full-machine browse makes pure-credential FILES reachable in
  // otherwise-allowed locations (not just credential dirs). These filenames hold secrets or secret
  // state by convention, so they are denied outright — never listed, previewed, or grounded. Secrets
  // that are merely content-shaped elsewhere are caught by the redaction layer instead.
  "*.tfstate",
  "*.tfstate.backup",
  "kubeconfig",
  ".rclone.conf",
  "wp-config.php",
  ".htpasswd",
  ".bash_history",
  ".zsh_history",
  ".sh_history",
  ".mysql_history",
  ".psql_history",
  ".python_history",
  ".node_repl_history",
  ".irb_history",
  "service-account*.json",
  // Epic #177 post-closure audit: additional pure-credential FILES denied outright. These filenames
  // hold secrets by convention (cloud storage keys, OAuth tokens, VCS/registry/shell credentials,
  // IaC variables); secret-shaped content in otherwise-allowed files is still scrubbed by the
  // redaction layer as defence-in-depth.
  ".s3cfg",
  ".boto",
  ".dockercfg",
  ".envrc",
  "*.tfvars",
  "*.tfvars.json",
  ".terraformrc",
]);

/**
 * Names the toolchain itself reads and writes, or product/IDE state that is not repository source.
 * Denied for discovery and the native read tool, but never by the kernel boundary.
 */
export const TOOL_STATE_PATH_DENY_PATTERNS: readonly string[] = Object.freeze([
  // `.config` is the XDG base whose subdirectories (gcloud ADC, many per-app tokens)
  // consistently hold secrets; the rest of the tree is ordinary tool configuration.
  ".config",
  ".terraform",
  ".cargo",
  ".m2",
  ".gitconfig",
  // deps
  "node_modules",
  // Keiko runtime/evidence state. These files are internal product artifacts, not repository
  // source, and must never be discoverable through connected repository grounding.
  ".keiko",
  "keiko.config.json",
  // Local tool and IDE runtime state. These directories can contain prompts, transcripts,
  // worktrees, extension caches, shelves, and machine-local metadata; they are not source context.
  ".codex",
  ".claude",
  ".playwright-mcp",
  ".idea",
  // caches
  ".cache",
  ".next",
  ".turbo",
  // vcs
  ".git",
  // os
  ".DS_Store",
]);

/** `.env.example` is the single documented exception to the `.env.*` pattern. */
export const ENV_EXAMPLE_BASENAME = ".env.example";
