#define _DARWIN_C_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int scenario, reaped, kills, unsafe_kills, waits, spawned, response_fd = -1;
static int unavailable;
static uint64_t now_ms = 100, deadline_ms, probe_interval;
static int fixture_clock_gettime(clockid_t id, struct timespec *value) {
  (void)id;
  if (unavailable) return -1;
  value->tv_sec = (time_t)(now_ms / 1000u);
  value->tv_nsec = (long)(now_ms % 1000u) * 1000000L;
  errno = 0;
  return 0;
}
static int fixture_dup2(posix_spawn_file_actions_t *actions, int source, int target) {
  if (target == 4) response_fd = source;
  return posix_spawn_file_actions_adddup2(actions, source, target);
}
static int fixture_spawn(pid_t *child, const char *path,
                          const posix_spawn_file_actions_t *actions,
                          const posix_spawnattr_t *attributes,
                          char *const arguments[], char *const environment[]) {
  unsigned char response[20] = {'K', 'R', 'S', '1', 1, 0, 2, 0, 8, 0, 0, 0};
  (void)path; (void)actions; (void)attributes; (void)arguments; (void)environment;
  spawned++;
  *child = 17;
  if (scenario == 9) response[0] = 'X';
  if (response_fd >= 0 && write(response_fd, response, sizeof(response)) != sizeof(response))
    return EIO;
  if (scenario == 10) unavailable = 1;
  return 0;
}
static pid_t fixture_waitpid(pid_t child, int *status, int options) {
  if (options != WNOHANG && scenario == 5) { errno = EINTR; return -1; }
  waits++;
  if (reaped || scenario == 4) { errno = ECHILD; return -1; }
  if (scenario == 5) { now_ms += probe_interval; return 0; }
  *status = scenario == 7 ? 256 : 0;
  reaped = 1;
  if (scenario == 1) now_ms = deadline_ms;
  if (scenario == 2) now_ms = deadline_ms + 1u;
  if (scenario == 3) unavailable = 1;
  return child;
}
static int fixture_kill(pid_t child, int signal) {
  (void)signal;
  kills++;
  if (reaped || scenario == 4 || child != 17) unsafe_kills++;
  return 0;
}
static int fixture_usleep(useconds_t duration) { now_ms += duration / 1000u; return 0; }
#define clock_gettime fixture_clock_gettime
#define posix_spawn_file_actions_adddup2 fixture_dup2
#define posix_spawn fixture_spawn
#define waitpid fixture_waitpid
#define kill fixture_kill
#define usleep fixture_usleep
#define main fixture_launcher_main
#define KEIKO_PORTABLE_TARGET "macos-arm64"
#ifndef KEIKO_OWNER_LAUNCHER
#define KEIKO_OWNER_LAUNCHER "../../native/portable-launcher/keiko-portable-launcher.c"
#endif
#include KEIKO_OWNER_LAUNCHER
#undef main
#undef clock_gettime
#undef posix_spawn_file_actions_adddup2
#undef posix_spawn
#undef waitpid
#undef kill
#undef usleep

static int reconcile_fixture(const char *directory) {
  keiko_coordinator_context context = {0};
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1], digest[65];
  int descriptor;
  if (snprintf(context.capsule, sizeof(context.capsule), "%s", directory) <= 0 ||
      !keiko_coordinator_join(path, sizeof(path), directory, "/runtime-supervisor")) return -1;
  descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (descriptor < 0 || write(descriptor, "fixture", 7) != 7 || close(descriptor) != 0 ||
      !keiko_coordinator_hash_file(path, UINT64_MAX - 1u, digest)) return -1;
  context.plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256] = digest;
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = (char *)"inert-activation";
#if defined(__APPLE__)
  if (scenario >= 11) {
    context.app_tree_reaped = 1;
    context.supervisor_pid = scenario == 12 ? 17 : -1;
    if (scenario == 13) now_ms = deadline_ms + 1u;
  }
#endif
  if (scenario == 6) now_ms = deadline_ms;
  if (scenario == 8) unavailable = 1;
  return keiko_coordinator_reconcile_stopped_runtime(&context, deadline_ms);
}
int main(int argc, char **argv) {
  int result;
  if (argc != 4) return 1;
  scenario = atoi(argv[2]);
  probe_interval = KEIKO_COORDINATOR_PROBE_MS;
  deadline_ms = now_ms + probe_interval;
  if (strcmp(argv[1], "probe") == 0) {
    if (scenario == 6) now_ms = deadline_ms;
    if (scenario == 8) unavailable = 1;
  }
  result = strcmp(argv[1], "probe") == 0
      ? keiko_coordinator_probe_monitor("inert-supervisor", deadline_ms)
      : reconcile_fixture(argv[3]);
  printf("{\"admitted\":%d,\"kills\":%d,\"unsafeKills\":%d,\"waits\":%d,\"spawned\":%d}\n",
         result, kills, unsafe_kills, waits, spawned);
  return result < 0;
}
