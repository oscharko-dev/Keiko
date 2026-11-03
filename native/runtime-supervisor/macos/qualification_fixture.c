#include <errno.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static pid_t detached_orphan(void) {
  int notice[2], status;
  pid_t middle, orphan = -1;
  if (pipe(notice) != 0 || (middle = fork()) < 0) return -1;
  if (middle == 0) {
    close(notice[0]);
    orphan = fork();
    if (orphan == 0) {
      close(notice[1]);
      if (setsid() != getpid()) _exit(5);
      char value;
      while (read(STDIN_FILENO, &value, 1) < 0 && errno == EINTR) {}
      _exit(0);
    }
    if (orphan < 0 || write(notice[1], &orphan, sizeof(orphan)) != sizeof(orphan)) _exit(6);
    _exit(0);
  }
  close(notice[1]);
  int ready = read(notice[0], &orphan, sizeof(orphan)) == sizeof(orphan) &&
    waitpid(middle, &status, 0) == middle && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  close(notice[0]);
  return ready ? orphan : -1;
}

extern int posix_spawnattr_setcoalition_np(posix_spawnattr_t *, uint64_t, int, int);

static int coalition_escape_refused(void) {
  uint64_t init[5] = {0};
  posix_spawnattr_t attributes;
  pid_t child = -1;
  int status;
  char *const arguments[] = {"/usr/bin/true", NULL};
  char *const environment[] = {NULL};
  if (proc_pidinfo(1, 20, 0, init, sizeof(init)) != sizeof(init) ||
      posix_spawnattr_init(&attributes) != 0) return 0;
  int result = posix_spawnattr_setcoalition_np(&attributes, init[0], 0, 0);
  if (result == 0)
    result = posix_spawn(&child, arguments[0], NULL, &attributes, arguments, environment);
  posix_spawnattr_destroy(&attributes);
  if (child > 0) (void)waitpid(child, &status, 0);
  return result == EPERM;
}

static int nested_sandbox_available(void) {
  pid_t child;
  int status;
  char *const arguments[] = {"/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)",
                            "/usr/bin/true", NULL};
  char *const environment[] = {NULL};
  return posix_spawn(&child, arguments[0], NULL, NULL, arguments, environment) == 0 &&
    waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static int orphan_fixture(int pause_supervisor) {
  pid_t supervisor = getppid();
  if (pause_supervisor) {
    if (!coalition_escape_refused() || !nested_sandbox_available()) return 13;
    if (kill(supervisor, SIGSTOP) != 0) return 7;
    unsigned int attempts = 0;
    struct proc_bsdinfo info;
    do {
      if (proc_pidinfo(supervisor, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 8;
      if (info.pbi_status == 4) break; /* SSTOP: the observer cannot see either middle parent. */
      if (poll(NULL, 0, 1) != 0) return 9;
    } while (++attempts < 1000u);
    if (info.pbi_status != 4) return 10;
  }
  pid_t orphan = detached_orphan();
  if (orphan < 0) return 11;
  unsigned char observation[16] = {'K','R','Q','1'};
  write_u32(observation + 4, (uint32_t)getpid());
  write_u32(observation + 8, (uint32_t)orphan);
  write_u32(observation + 12, (uint32_t)supervisor);
  if (write(STDOUT_FILENO, observation, sizeof(observation)) != sizeof(observation)) return 12;
  for (;;) pause();
}

int main(int argc, char **argv) {
  unsigned char observation[12] = {'K', 'R', 'Q', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  pid_t child;
  if (argc == 2 && strcmp(argv[1], "--foreign-orphan") == 0) return orphan_fixture(0);
  if (argc != 3) return 2;
  if (strcmp(argv[1], "--unobserved-orphan") == 0) return orphan_fixture(1);
  child = fork();
  if (child == -1) return 3;
  if (child == 0) {
    for (;;) pause();
  }
  write_u32(observation + 4, (uint32_t)getpid());
  write_u32(observation + 8, (uint32_t)child);
  if (write(STDOUT_FILENO, observation, sizeof(observation)) != (ssize_t)sizeof(observation)) {
    (void)kill(child, SIGKILL);
    return 4;
  }
  for (;;) pause();
}
