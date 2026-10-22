#include <libproc.h>
#include <stdint.h>
static int model_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
static int model_listpids(uint32_t type, uint32_t info, void *buffer, int size);
#define proc_pidinfo model_pidinfo
#define proc_listpids model_listpids
#include "../runtime-supervisor/macos/keiko_runtime_process_scope.h"
#undef proc_pidinfo
#undef proc_listpids
#include <assert.h>
#include <stdio.h>
#include <sys/wait.h>

static int modeling, failure_errno, identity_reuse, identity_reads;
static uint64_t foreign_generation = 202;

static int model_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  if (!modeling) return proc_pidinfo(pid, flavor, arg, buffer, size);
  if (pid == 303 && failure_errno != 0) { errno = failure_errno; return 0; }
  if (flavor == KEIKO_MACOS_COALITION_FLAVOR) {
    assert(size == (int)(sizeof(uint64_t) * 5u));
    uint64_t values[5] = {pid == 202 ? 77u : 42u, 0, 0, 0, 0};
    memcpy(buffer, values, sizeof(values));
    return sizeof(values);
  }
  assert(flavor == KEIKO_MACOS_IDENTITY_FLAVOR && size == sizeof(keiko_macos_process_identity));
  keiko_macos_process_identity value = {0};
  value.unique_id = pid == 202 ? foreign_generation : (uint64_t)pid;
  value.parent_unique_id = pid == 101 ? 100u : 999999u; /* Unobserved intermediate parents. */
  value.version = 1;
  if (pid == 303 && identity_reuse && ++identity_reads % 2 == 0) ++value.unique_id;
  memcpy(buffer, &value, sizeof(value));
  return sizeof(value);
}

static int model_listpids(uint32_t type, uint32_t info, void *buffer, int size) {
  if (!modeling) return proc_listpids(type, info, buffer, size);
  const pid_t pids[] = {101, 202, 303};
  assert(size >= (int)sizeof(pids));
  memcpy(buffer, pids, sizeof(pids));
  return sizeof(pids);
}

static void identity_controls(void) {
  keiko_macos_process_identity parent, child_identity;
  keiko_macos_scope_member member = {0};
  int ready[2], gate[2], status;
  char value;
  pid_t child;
  assert(keiko_macos_identity(getpid(), &parent));
  assert(pipe(ready) == 0 && pipe(gate) == 0);
  child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(ready[0]); close(gate[1]);
    assert(setsid() == getpid());
    assert(write(ready[1], "1", 1) == 1);
    assert(read(gate[0], &value, 1) == 1);
    _exit(0);
  }
  close(ready[1]); close(gate[0]);
  assert(read(ready[0], &value, 1) == 1);
  assert(keiko_macos_identity(child, &child_identity));
  assert(child_identity.parent_unique_id == parent.unique_id);
  member.pid = child;
  member.identity = child_identity;
  ++member.identity.version;
  assert(keiko_macos_signal(&member, SIGKILL) == ESRCH);
  member.identity = child_identity;
  assert(keiko_macos_signal(&member, SIGSTOP) == 0);
  assert(waitpid(child, &status, WUNTRACED) == child && WIFSTOPPED(status));
  assert(keiko_macos_signal(&member, SIGCONT) == 0);
  assert(write(gate[1], "1", 1) == 1);
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  close(ready[0]); close(gate[1]);
}

static void scope_controls(void) {
  keiko_macos_process_scope scope = {0};
  unsigned int live, unknown;
  /* A caller outside an authenticated, isolated launchd job cannot establish ownership. */
  assert(!keiko_macos_scope_init(&scope));
  keiko_macos_scope_destroy(&scope);
  scope.members = calloc(KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*scope.members));
  assert(scope.members != NULL);
  scope.coalition_id = 42;
  scope.supervisor_unique_id = 100;
  modeling = 1;
  assert(!keiko_macos_scope_admit_root(&scope, 303));
  assert(keiko_macos_scope_admit_root(&scope, 101));
  assert(keiko_macos_scope_live(&scope, &live, &unknown) && live == 2 && unknown == 0);
  assert(scope.members[1].pid == 303); /* Detached child is owned without observed ancestry. */
  for (uint64_t generation = 1000; generation < 81000; ++generation) {
    foreign_generation = generation;
    assert(keiko_macos_scope_scan(&scope, 0));
    assert(scope.count == 2); /* Foreign churn is neither retained nor an app lifetime limit. */
  }
  failure_errno = ESRCH;
  assert(keiko_macos_scope_scan(&scope, 0) && scope.incomplete);
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  failure_errno = 0;
  assert(keiko_macos_scope_scan(&scope, 0));
  assert(keiko_macos_scope_live(&scope, &live, &unknown));
  identity_reuse = 1;
  assert(keiko_macos_scope_scan(&scope, 0) && scope.incomplete);
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  identity_reuse = 0;
  failure_errno = EPERM;
  assert(!keiko_macos_scope_scan(&scope, 0) && scope.failed);
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  failure_errno = 0;
  scope.failed = 0;
  scope.count = KEIKO_MACOS_SCOPE_CAPACITY;
  assert(!keiko_macos_observe_pid(&scope, 303));
  scope.count = KEIKO_MACOS_SCOPE_CAPACITY + 1u;
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  modeling = 0;
  keiko_macos_scope_destroy(&scope);
}

int main(void) {
  identity_controls();
  scope_controls();
  puts("macOS identity, coalition membership, churn and incomplete-observation controls passed");
  return 0;
}
