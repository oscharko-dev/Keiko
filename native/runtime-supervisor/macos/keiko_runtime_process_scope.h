#ifndef KEIKO_RUNTIME_PROCESS_SCOPE_MACOS_H
#define KEIKO_RUNTIME_PROCESS_SCOPE_MACOS_H

#include <errno.h>
#include <libproc.h>
#include <mach/message.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

/* XNU proc_info_private.h: the 56-byte API record is stable across exec and reparenting.
 * PID versions change on exec; unique IDs and original parent unique IDs do not.
 * Audit-token signalling makes the generation comparison inside the kernel, without a
 * check-then-kill PID reuse race. No entitlement or platform signing identity is involved. */
typedef struct {
  unsigned char uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t version;
  int32_t original_parent_version;
  uint64_t reserved[2];
} keiko_macos_process_identity;

_Static_assert(sizeof(keiko_macos_process_identity) == 56, "Darwin process identity ABI");

enum { KEIKO_MACOS_IDENTITY_FLAVOR = 17, KEIKO_MACOS_SCOPE_CAPACITY = 65536 };
enum { KEIKO_MACOS_UNKNOWN = 0, KEIKO_MACOS_UNRELATED = 1, KEIKO_MACOS_OWNED = 2 };

typedef struct {
  keiko_macos_process_identity identity;
  pid_t pid;
  unsigned int seen;
  unsigned char membership;
} keiko_macos_scope_member;

typedef struct {
  keiko_macos_scope_member *members;
  unsigned int epoch;
  size_t count;
  uint64_t root_unique_id;
  int failed;
  int incomplete;
} keiko_macos_process_scope;

static inline int keiko_macos_identity(pid_t pid, keiko_macos_process_identity *identity) {
  memset(identity, 0, sizeof(*identity));
  return proc_pidinfo(pid, KEIKO_MACOS_IDENTITY_FLAVOR, 0, identity, sizeof(*identity)) ==
             (int)sizeof(*identity) && identity->unique_id != 0 && identity->version > 0;
}

static inline int keiko_macos_signal(const keiko_macos_scope_member *member, int signal_number) {
  audit_token_t token = {{0}};
  token.val[5] = (unsigned int)member->pid;
  token.val[7] = (unsigned int)member->identity.version;
  return proc_signal_with_audittoken(&token, signal_number);
}

static inline keiko_macos_scope_member *keiko_macos_member(keiko_macos_process_scope *scope,
                                                    uint64_t unique_id, int create) {
  size_t start = (size_t)(unique_id % KEIKO_MACOS_SCOPE_CAPACITY), offset;
  if (unique_id == 0) return NULL;
  for (offset = 0; offset < KEIKO_MACOS_SCOPE_CAPACITY; ++offset) {
    keiko_macos_scope_member *member =
        &scope->members[(start + offset) % KEIKO_MACOS_SCOPE_CAPACITY];
    if (member->identity.unique_id == unique_id) return member;
    if (member->identity.unique_id == 0) {
      if (!create || scope->count >= KEIKO_MACOS_SCOPE_CAPACITY / 2u) return NULL;
      member->identity.unique_id = unique_id;
      ++scope->count;
      return member;
    }
  }
  return NULL;
}

static inline int keiko_macos_observe_pid(keiko_macos_process_scope *scope, pid_t pid,
                                   int baseline) {
  keiko_macos_process_identity identity;
  keiko_macos_scope_member *member;
  if (pid <= 0) return 1;
  errno = 0;
  if (!keiko_macos_identity(pid, &identity)) {
    if (errno != ESRCH) return 0;
    scope->incomplete = 1;
    return 1;
  }
  member = keiko_macos_member(scope, identity.unique_id, 1);
  if (member == NULL) return 0;
  member->identity = identity;
  member->pid = pid;
  member->seen = scope->epoch;
  if (baseline) member->membership = KEIKO_MACOS_UNRELATED;
  return 1;
}

static inline void keiko_macos_classify(keiko_macos_process_scope *scope) {
  size_t index;
  int changed;
  do {
    changed = 0;
    for (index = 0; index < KEIKO_MACOS_SCOPE_CAPACITY; ++index) {
      keiko_macos_scope_member *member = &scope->members[index], *parent;
      if (member->identity.unique_id == 0 || member->membership != KEIKO_MACOS_UNKNOWN) continue;
      parent = keiko_macos_member(scope, member->identity.parent_unique_id, 0);
      if (parent != NULL && parent->membership != KEIKO_MACOS_UNKNOWN) {
        member->membership = parent->membership;
        changed = 1;
      }
    }
  } while (changed);
}

/* Retain original-parent identities even after exit. An unseen intermediate parent never
 * becomes an assumed unrelated process: any surviving unclassified process blocks zero-live
 * proof. This deliberately refuses incomplete observations instead of losing a detached child. */
static inline int keiko_macos_scope_scan(keiko_macos_process_scope *scope, int baseline) {
  pid_t *pids;
  int bytes, index, result = 1;
  if (scope->failed || scope->epoch == UINT32_MAX) return 0;
  pids = (pid_t *)calloc(KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*pids));
  if (pids == NULL) return 0;
  ++scope->epoch;
  scope->incomplete = 0;
  bytes = proc_listpids(PROC_ALL_PIDS, 0, pids,
                         KEIKO_MACOS_SCOPE_CAPACITY * (int)sizeof(*pids));
  if (bytes <= 0 || bytes % (int)sizeof(*pids) != 0 ||
      bytes >= KEIKO_MACOS_SCOPE_CAPACITY * (int)sizeof(*pids)) result = 0;
  for (index = 0; result && index < bytes / (int)sizeof(*pids); ++index) {
    if (!keiko_macos_observe_pid(scope, pids[index], baseline)) result = 0;
  }
  free(pids);
  if (result) keiko_macos_classify(scope);
  else scope->failed = 1;
  return result;
}

static inline int keiko_macos_scope_init(keiko_macos_process_scope *scope) {
  memset(scope, 0, sizeof(*scope));
  scope->members = (keiko_macos_scope_member *)calloc(
      KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*scope->members));
  return scope->members != NULL && keiko_macos_scope_scan(scope, 1);
}

static inline int keiko_macos_scope_admit_root(keiko_macos_process_scope *scope, pid_t root) {
  keiko_macos_process_identity identity, self;
  keiko_macos_scope_member *member;
  if (!keiko_macos_identity(root, &identity) || !keiko_macos_identity(getpid(), &self) ||
      identity.parent_unique_id != self.unique_id) return 0;
  member = keiko_macos_member(scope, identity.unique_id, 1);
  if (member == NULL || member->membership != KEIKO_MACOS_UNKNOWN) return 0;
  member->identity = identity;
  member->pid = root;
  member->membership = KEIKO_MACOS_OWNED;
  scope->root_unique_id = identity.unique_id;
  return keiko_macos_scope_scan(scope, 0);
}

static inline int keiko_macos_scope_live(const keiko_macos_process_scope *scope,
                                  unsigned int *owned, unsigned int *unknown) {
  size_t index;
  *owned = *unknown = 0;
  if (scope->failed || scope->incomplete || scope->root_unique_id == 0) return 0;
  for (index = 0; index < KEIKO_MACOS_SCOPE_CAPACITY; ++index) {
    const keiko_macos_scope_member *member = &scope->members[index];
    if (member->seen != scope->epoch || member->identity.unique_id == 0) continue;
    if (member->membership == KEIKO_MACOS_OWNED) ++*owned;
    if (member->membership == KEIKO_MACOS_UNKNOWN) ++*unknown;
  }
  return 1;
}

static inline int keiko_macos_scope_signal(keiko_macos_process_scope *scope, int signal_number) {
  size_t index;
  if (!keiko_macos_scope_scan(scope, 0)) return 0;
  for (index = 0; index < KEIKO_MACOS_SCOPE_CAPACITY; ++index) {
    keiko_macos_scope_member *member = &scope->members[index];
    int result;
    if (member->seen != scope->epoch || member->membership != KEIKO_MACOS_OWNED) continue;
    result = keiko_macos_signal(member, signal_number);
    /* Exec changes the PID version, so ESRCH means retry observation, never signal by PID. */
    if (result != 0 && result != ESRCH) return 0;
  }
  return 1;
}

static inline void keiko_macos_scope_destroy(keiko_macos_process_scope *scope) {
  free(scope->members);
  memset(scope, 0, sizeof(*scope));
}

#endif
