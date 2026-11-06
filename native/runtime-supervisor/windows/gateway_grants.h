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

struct keiko_gateway_grants {
  size_t count;
  struct keiko_gateway_grant entries[KEIKO_GATEWAY_GRANTS_MAX];
  SID_AND_ATTRIBUTES capabilities[KEIKO_GATEWAY_GRANTS_MAX];
  DWORD capability_count;
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

/* Grants every entry, or names the step that refused one; a refusal leaves nothing of this tree
 * granted and refuses the launch. */
int keiko_gateway_grants_apply(_Inout_ struct keiko_gateway_grants *grants, PSID tree);
/* Removes the tree's own grants. A worktree capability stays with its worktree. */
void keiko_gateway_grants_revoke(_Inout_ struct keiko_gateway_grants *grants, PSID tree);
void keiko_gateway_grants_clear(_Inout_ struct keiko_gateway_grants *grants);
#endif
