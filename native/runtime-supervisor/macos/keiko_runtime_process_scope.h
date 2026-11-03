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
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* XNU identity survives exec/reparenting; the audit token binds signals to the
 * exact exec generation. Resource-coalition membership is inherited in the kernel
 * through fork/exec/setsid and cannot be changed by an unprivileged descendant. */
typedef struct {
  unsigned char uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t version;
  int32_t original_parent_version;
  uint64_t reserved[2];
} keiko_macos_process_identity;

_Static_assert(sizeof(keiko_macos_process_identity) == 56, "Darwin process identity ABI");
enum { KEIKO_MACOS_IDENTITY_FLAVOR = 17, KEIKO_MACOS_COALITION_FLAVOR = 20,
       KEIKO_MACOS_SCOPE_CAPACITY = 65536 };

typedef struct {
  keiko_macos_process_identity identity;
  pid_t pid;
} keiko_macos_scope_member;

typedef struct {
  keiko_macos_scope_member *members;
  size_t count;
  uint64_t coalition_id;
  uint64_t supervisor_unique_id;
  uint64_t root_unique_id;
  int failed;
  int incomplete;
} keiko_macos_process_scope;

static inline int keiko_macos_identity(pid_t pid, keiko_macos_process_identity *identity) {
  memset(identity, 0, sizeof(*identity));
  return proc_pidinfo(pid, KEIKO_MACOS_IDENTITY_FLAVOR, 0, identity, sizeof(*identity)) ==
             (int)sizeof(*identity) && identity->unique_id != 0 && identity->version > 0;
}

/* proc_pidcoalitioninfo: resource, jetsam and three reserved uint64_t fields. */
static inline int keiko_macos_coalition(pid_t pid, uint64_t *coalition) {
  uint64_t info[5] = {0};
  if (proc_pidinfo(pid, KEIKO_MACOS_COALITION_FLAVOR, 0, info, sizeof(info)) !=
      (int)sizeof(info) || info[0] == 0) return 0;
  *coalition = info[0];
  return 1;
}

static inline int keiko_macos_signal(const keiko_macos_scope_member *member, int signal_number) {
  audit_token_t token = {{0}};
  token.val[5] = (unsigned int)member->pid;
  token.val[7] = (unsigned int)member->identity.version;
  return proc_signal_with_audittoken(&token, signal_number);
}

static inline int keiko_macos_observe_pid(keiko_macos_process_scope *scope, pid_t pid) {
  keiko_macos_process_identity before, after;
  uint64_t coalition;
  if (pid <= 0) return 1;
  errno = 0;
  if (!keiko_macos_identity(pid, &before) || !keiko_macos_coalition(pid, &coalition) ||
      !keiko_macos_identity(pid, &after)) {
    if (errno != ESRCH) return 0;
    scope->incomplete = 1;
    return 1;
  }
  if (before.unique_id != after.unique_id || before.version != after.version) {
    scope->incomplete = 1;
    return 1;
  }
  if (coalition != scope->coalition_id || after.unique_id == scope->supervisor_unique_id) return 1;
  if (scope->count >= KEIKO_MACOS_SCOPE_CAPACITY) return 0;
  scope->members[scope->count++] = (keiko_macos_scope_member){after, pid};
  return 1;
}

/* Read current kernel membership instead of a history of all host processes.
 * Missing intermediate parents neither lose an owned child nor make a foreign
 * orphan ambiguous. Incomplete reads still refuse a zero-live proof. */
static inline int keiko_macos_scope_scan(keiko_macos_process_scope *scope, int baseline) {
  (void)baseline;
  if (scope->failed || scope->coalition_id == 0 || scope->members == NULL) return 0;
  pid_t *pids = calloc(KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*pids));
  if (pids == NULL) return 0;
  scope->count = 0;
  scope->incomplete = 0;
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids,
                          KEIKO_MACOS_SCOPE_CAPACITY * (int)sizeof(*pids));
  int result = bytes > 0 && bytes % (int)sizeof(*pids) == 0 &&
               bytes < KEIKO_MACOS_SCOPE_CAPACITY * (int)sizeof(*pids);
  for (int index = 0; result && index < bytes / (int)sizeof(*pids); ++index)
    if (!keiko_macos_observe_pid(scope, pids[index])) result = 0;
  free(pids);
  if (!result) scope->failed = 1;
  return result;
}

static inline int keiko_macos_scope_init(keiko_macos_process_scope *scope) {
  memset(scope, 0, sizeof(*scope));
  keiko_macos_process_identity self;
  uint64_t parent_coalition, bridge_coalition;
  pid_t bridge;
  uid_t uid;
  gid_t gid;
  socklen_t size = sizeof(bridge);
  /* Only the authenticated launchd job establishes a generation scope. The
   * persistent owner/bridge and updater coordinator stay outside it. */
  if (getppid() != 1 || !keiko_macos_identity(getpid(), &self) ||
      !keiko_macos_coalition(getpid(), &scope->coalition_id) ||
      !keiko_macos_coalition(1, &parent_coalition) || scope->coalition_id == parent_coalition ||
      getpeereid(9, &uid, &gid) != 0 || uid != geteuid() ||
      getsockopt(9, SOL_LOCAL, LOCAL_PEERPID, &bridge, &size) != 0 ||
      size != sizeof(bridge) || bridge <= 1 || !keiko_macos_coalition(bridge, &bridge_coalition) ||
      scope->coalition_id == bridge_coalition) return 0;
  scope->supervisor_unique_id = self.unique_id;
  scope->members = calloc(KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*scope->members));
  return scope->members != NULL && keiko_macos_scope_scan(scope, 1);
}

static inline int keiko_macos_scope_admit_root(keiko_macos_process_scope *scope, pid_t root) {
  keiko_macos_process_identity identity;
  uint64_t coalition;
  if (!keiko_macos_identity(root, &identity) ||
      identity.parent_unique_id != scope->supervisor_unique_id ||
      !keiko_macos_coalition(root, &coalition) || coalition != scope->coalition_id) return 0;
  scope->root_unique_id = identity.unique_id;
  return keiko_macos_scope_scan(scope, 0);
}

static inline int keiko_macos_scope_live(const keiko_macos_process_scope *scope,
                                       unsigned int *owned, unsigned int *unknown) {
  *owned = *unknown = 0;
  if (scope->failed || scope->incomplete || scope->root_unique_id == 0 ||
      scope->count > KEIKO_MACOS_SCOPE_CAPACITY) return 0;
  *owned = (unsigned int)scope->count;
  return 1;
}

static inline int keiko_macos_scope_signal(keiko_macos_process_scope *scope, int signal_number) {
  if (!keiko_macos_scope_scan(scope, 0)) return 0;
  for (size_t index = 0; index < scope->count; ++index) {
    int result = keiko_macos_signal(&scope->members[index], signal_number);
    /* Exec changes the token; observe again instead of falling back to a raw PID. */
    if (result != 0 && result != ESRCH) return 0;
  }
  return 1;
}

static inline void keiko_macos_scope_destroy(keiko_macos_process_scope *scope) {
  free(scope->members);
  memset(scope, 0, sizeof(*scope));
}

#endif
