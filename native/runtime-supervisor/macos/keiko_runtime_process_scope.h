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
  uint64_t first;
  uint64_t last;
} keiko_macos_unrelated_range;

typedef struct {
  keiko_macos_scope_member *members;
  keiko_macos_unrelated_range *unrelated_history;
  size_t unrelated_count;
  unsigned int epoch;
  size_t count;
  uint64_t root_unique_id;
  int failed;
  int incomplete;
} keiko_macos_process_scope;

static inline size_t keiko_macos_history_index(const keiko_macos_process_scope *scope,
                                               uint64_t identity) {
  size_t first = 0, last = scope->unrelated_count;
  while (first < last) {
    size_t middle = first + (last - first) / 2u;
    if (scope->unrelated_history[middle].last < identity) first = middle + 1u;
    else last = middle;
  }
  return first;
}

static inline int keiko_macos_known_unrelated(const keiko_macos_process_scope *scope,
                                              uint64_t identity) {
  size_t index = keiko_macos_history_index(scope, identity);
  return identity != 0 && index < scope->unrelated_count &&
         scope->unrelated_history[index].first <= identity;
}

/* Only identities already positively classified as unrelated enter this exact set.
 * Merge adjacent observed IDs; never cover an unobserved gap or an owned identity. */
static inline int keiko_macos_remember_unrelated(keiko_macos_process_scope *scope,
                                                 uint64_t identity) {
  if (identity == 0) return 0;
  size_t index = keiko_macos_history_index(scope, identity);
  if (keiko_macos_known_unrelated(scope, identity)) return 1;
  if (scope->unrelated_history == NULL) {
    scope->unrelated_history = calloc(KEIKO_MACOS_SCOPE_CAPACITY,
                                      sizeof(*scope->unrelated_history));
    if (scope->unrelated_history == NULL) return 0;
  }
  int left = index > 0 && scope->unrelated_history[index - 1u].last == identity - 1u;
  int right = identity < UINT64_MAX && index < scope->unrelated_count &&
              scope->unrelated_history[index].first == identity + 1u;
  if (left) {
    scope->unrelated_history[index - 1u].last = right
      ? scope->unrelated_history[index].last : identity;
    if (right) {
      memmove(scope->unrelated_history + index, scope->unrelated_history + index + 1u,
              (scope->unrelated_count - index - 1u) * sizeof(*scope->unrelated_history));
      --scope->unrelated_count;
    }
  } else if (right) scope->unrelated_history[index].first = identity;
  else {
    if (scope->unrelated_count == KEIKO_MACOS_SCOPE_CAPACITY) return 0;
    memmove(scope->unrelated_history + index + 1u, scope->unrelated_history + index,
            (scope->unrelated_count - index) * sizeof(*scope->unrelated_history));
    scope->unrelated_history[index] = (keiko_macos_unrelated_range){identity, identity};
    ++scope->unrelated_count;
  }
  return 1;
}

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
      if (keiko_macos_known_unrelated(scope, member->identity.unique_id) ||
          keiko_macos_known_unrelated(scope, member->identity.parent_unique_id)) {
        member->membership = KEIKO_MACOS_UNRELATED;
        changed = 1;
        continue;
      }
      parent = keiko_macos_member(scope, member->identity.parent_unique_id, 0);
      if (parent != NULL && parent->membership != KEIKO_MACOS_UNKNOWN) {
        member->membership = parent->membership;
        changed = 1;
      }
    }
  } while (changed);
}

/* Global unrelated process churn is not an application lifetime budget. Rehash to
 * preserve open-addressing chains; retain every owned/unknown identity, including
 * exited parents. Preserve exact positive unrelated ancestry in compact ranges;
 * never-observed ancestry remains unknown and blocks a zero-live proof. */
static inline int keiko_macos_scope_reclaim(keiko_macos_process_scope *scope) {
  keiko_macos_process_scope replacement = *scope;
  size_t index;
  replacement.members = (keiko_macos_scope_member *)calloc(
      KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*replacement.members));
  if (replacement.members == NULL) return 0;
  replacement.count = 0;
  for (index = 0; index < KEIKO_MACOS_SCOPE_CAPACITY; ++index) {
    const keiko_macos_scope_member *member = &scope->members[index];
    keiko_macos_scope_member *retained;
    if (member->identity.unique_id == 0) continue;
    if (member->membership == KEIKO_MACOS_UNRELATED && scope->epoch - member->seen > 1u) {
      if (!keiko_macos_remember_unrelated(scope, member->identity.unique_id)) {
        free(replacement.members); return 0;
      }
      continue;
    }
    retained = keiko_macos_member(&replacement, member->identity.unique_id, 1);
    if (retained == NULL) { free(replacement.members); return 0; }
    *retained = *member;
  }
  free(scope->members);
  scope->members = replacement.members;
  scope->count = replacement.count;
  return 1;
}

/* Retain original-parent identities even after exit. An unseen intermediate parent never
 * becomes an assumed unrelated process: any surviving unclassified process blocks zero-live
 * proof. This deliberately refuses incomplete observations instead of losing a detached child. */
static inline int keiko_macos_scope_scan(keiko_macos_process_scope *scope, int baseline) {
  pid_t *pids;
  int bytes, index, result = 1;
  if (scope->failed || scope->epoch == UINT32_MAX) return 0;
  if (scope->count >= KEIKO_MACOS_SCOPE_CAPACITY / 4u &&
      !keiko_macos_scope_reclaim(scope)) { scope->failed = 1; return 0; }
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
  free(scope->unrelated_history);
  memset(scope, 0, sizeof(*scope));
}

#endif
