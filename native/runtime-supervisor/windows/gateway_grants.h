#ifndef KEIKO_GATEWAY_GRANTS_H
#define KEIKO_GATEWAY_GRANTS_H
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <stddef.h>

/* #4068: what the per-tree AppContainer of a confined run may reach on disk. The host sends one KGG1
 * frame after the launch packet; the supervisor applies it once the broker named the tree's SID and
 * before the suspended root exists, and revokes the tree's own grants when the tree is reaped. */
#define KEIKO_GATEWAY_GRANTS_MAX 8
#define KEIKO_GATEWAY_GRANTS_MAX_BYTES 262144
#define KEIKO_GATEWAY_GRANT_PATH_MAX_BYTES 32768

enum keiko_gateway_grant_access { KEIKO_GRANT_READ = 1, KEIKO_GRANT_MODIFY = 2 };
enum keiko_gateway_grant_principal { KEIKO_GRANT_TREE = 1, KEIKO_GRANT_CAPABILITY = 2 };

struct keiko_gateway_grant {
  int access;
  int principal;
  wchar_t *path;
  wchar_t *capability;
  PSID capability_sid;
  int applied;
};

/* #4496 (ADR-0043 D21): the profile folders above a step's grants take a non-inherited list entry
 * for the tree's own SID, revoked with the tree's grants. No capability Windows grants an ordinary
 * AppContainer lists `C:\` or `C:\Users`: CreateProcessW refuses the isolatedWin32 ones (87). */
#define KEIKO_GATEWAY_ANCESTORS_MAX 32
/* List, traverse and read attributes on the folder itself; nothing below it is inherited. */
#define KEIKO_GATEWAY_ANCESTOR_MASK \
  (FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)

struct keiko_gateway_ancestor {
  wchar_t *path;
  int applied;
};

struct keiko_gateway_grants {
  size_t count;
  struct keiko_gateway_grant entries[KEIKO_GATEWAY_GRANTS_MAX];
  SID_AND_ATTRIBUTES capabilities[KEIKO_GATEWAY_GRANTS_MAX];
  DWORD capability_count;
  size_t ancestor_count;
  struct keiko_gateway_ancestor ancestors[KEIKO_GATEWAY_ANCESTORS_MAX];
};

/* Parses one complete frame; refuses any shape the host never sends. */
int keiko_gateway_grants_parse(_In_reads_bytes_opt_(length) const unsigned char *frame,
                               size_t length, _Out_ struct keiko_gateway_grants *grants);
/* Reads and parses exactly one frame from the control descriptor. */
int keiko_gateway_grants_read(int descriptor, _Out_ struct keiko_gateway_grants *grants);
enum keiko_gateway_grants_result {
  KEIKO_GRANTS_APPLIED = 0,
  KEIKO_GRANTS_REFUSED_DIRECTORY = 1,
  KEIKO_GRANTS_REFUSED_ACL = 2,
  KEIKO_GRANTS_REFUSED_CAPABILITY = 3
};

/* Plans the list entries for the folders of `profile` above each grant: the profile itself and
 * every folder between it and a granted directory, except one a grant already covers. A grant
 * outside the profile plans nothing. Refuses more than KEIKO_GATEWAY_ANCESTORS_MAX folders. Runs
 * before the sweep, which also removes stale list entries from these folders. */
int keiko_gateway_ancestors_plan(_Inout_ struct keiko_gateway_grants *grants,
                                 _In_z_ const wchar_t *profile);
/* Grants every entry, or names the step that refused one; a refusal leaves nothing of this tree
 * granted and refuses the launch. */
int keiko_gateway_grants_apply(_Inout_ struct keiko_gateway_grants *grants, PSID tree);
/* Whether every AppContainer (ALL APPLICATION PACKAGES) may already read the directory and all it
 * holds, with no deny entry for that group. Such a read grant needs no entry of its own (#4068). */
int keiko_gateway_grants_packages_read(_In_z_ const wchar_t *path);
/* Removes the tree's own grants and list entries. A worktree capability stays with its worktree. */
void keiko_gateway_grants_revoke(_Inout_ struct keiko_gateway_grants *grants, PSID tree);

/* At most this many stale entries are removed from one granted directory per sweep. */
#define KEIKO_GATEWAY_SWEEP_MAX 64u

struct keiko_gateway_sweep {
  const struct keiko_gateway_grants *grants;
  DWORD removed;
  DWORD failed;
};

/* Removes, from every directory the frame grants to the tree's own SID, the tree entries a
 * supervisor that died before its revoke left behind: explicit allow entries for an AppContainer
 * package SID with exactly a tree grant's mask and inheritance. From every planned ancestor it
 * removes explicit, non-inherited package-SID entries with exactly KEIKO_GATEWAY_ANCESTOR_MASK. Only safe while no confined tree of
 * this user lives, so it runs as the environment guard's sole-holder step (ADR-0043 D18). A failure
 * is counted and never refuses the launch: a stale entry names a SID no later process can obtain. */
void keiko_gateway_grants_sweep(_Inout_ void *sweep);
void keiko_gateway_grants_clear(_Inout_ struct keiko_gateway_grants *grants);
#endif
