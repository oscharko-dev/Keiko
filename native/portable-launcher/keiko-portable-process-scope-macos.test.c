#include "../runtime-supervisor/macos/keiko_runtime_process_scope.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <sys/wait.h>
#include <time.h>

static uint64_t now_ms(void) {
  struct timespec now;
  assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
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
  keiko_macos_process_scope scope;
  unsigned int live, unknown;
  int gate[2], status;
  uint64_t deadline;
  pid_t child;
  assert(keiko_macos_scope_init(&scope));
  assert(pipe(gate) == 0);
  child = fork();
  assert(child >= 0);
  if (child == 0) {
    char value;
    close(gate[1]);
    assert(read(gate[0], &value, 1) == 1);
    for (;;) pause();
  }
  close(gate[0]);
  assert(keiko_macos_scope_admit_root(&scope, child));
  assert(keiko_macos_scope_signal(&scope, SIGKILL));
  assert(waitpid(child, &status, 0) == child && WIFSIGNALED(status));
  deadline = now_ms() + 3000u;
  do {
    assert(keiko_macos_scope_scan(&scope, 0));
    if (keiko_macos_scope_live(&scope, &live, &unknown) && live == 0 && unknown == 0) break;
    assert(poll(NULL, 0, 1) == 0);
  } while (now_ms() < deadline);
  assert(keiko_macos_scope_live(&scope, &live, &unknown) && live == 0 && unknown == 0);
  scope.incomplete = 1;
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  scope.incomplete = 0;
  scope.failed = 1;
  assert(!keiko_macos_scope_live(&scope, &live, &unknown));
  close(gate[1]);
  keiko_macos_scope_destroy(&scope);
}

static void churn_controls(void) {
  keiko_macos_process_scope scope = {0};
  uint64_t next = 10;
  unsigned int live, unknown;
  scope.members = calloc(KEIKO_MACOS_SCOPE_CAPACITY, sizeof(*scope.members));
  assert(scope.members != NULL);
  scope.root_unique_id = 1;
  keiko_macos_scope_member *root = keiko_macos_member(&scope, 1, 1);
  root->membership = KEIKO_MACOS_OWNED;
  for (unsigned int batch = 0; batch < 80; ++batch) {
    ++scope.epoch;
    if (scope.count >= KEIKO_MACOS_SCOPE_CAPACITY / 4u)
      assert(keiko_macos_scope_reclaim(&scope));
    for (unsigned int i = 0; i < 1000; ++i) {
      keiko_macos_scope_member *member = keiko_macos_member(&scope, next++, 1);
      assert(member != NULL);
      member->membership = KEIKO_MACOS_UNRELATED;
      member->seen = scope.epoch;
    }
  }
  assert(next > KEIKO_MACOS_SCOPE_CAPACITY);
  assert(keiko_macos_member(&scope, 1, 0)->membership == KEIKO_MACOS_OWNED);
  keiko_macos_scope_member *child = keiko_macos_member(&scope, next++, 1);
  child->identity.parent_unique_id = 1;
  child->seen = scope.epoch;
  keiko_macos_classify(&scope);
  assert(child->membership == KEIKO_MACOS_OWNED);
  keiko_macos_scope_member *unclassified = keiko_macos_member(&scope, next++, 1);
  unclassified->identity.parent_unique_id = 10; /* Collected unrelated ancestor. */
  unclassified->seen = scope.epoch;
  assert(keiko_macos_scope_reclaim(&scope));
  keiko_macos_classify(&scope);
  assert(keiko_macos_scope_live(&scope, &live, &unknown));
  assert(live == 1 && unknown == 1);
  keiko_macos_scope_destroy(&scope);
}

int main(void) {
  identity_controls();
  scope_controls();
  churn_controls();
  puts("macOS process identity, generation-bound signals and scope controls passed");
  return 0;
}
