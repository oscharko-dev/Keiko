#include <assert.h>
#include <errno.h>
#include <spawn.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>

static int fault, probe_child = -1, transferred_channel = -1;
static int fault_clock(clockid_t clock, struct timespec *value);
static char *fault_directory(char *path);
static int fault_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                       const posix_spawnattr_t *attributes, char *const arguments[],
                       char *const environment[]);
static ssize_t fault_read(int descriptor, void *buffer, size_t length);
static ssize_t fault_sendmsg(int descriptor, const struct msghdr *message, int flags);
#define clock_gettime fault_clock
#define mkdtemp fault_directory
#define posix_spawn fault_spawn
#define read fault_read
#define sendmsg fault_sendmsg
#define main keiko_supervisor_entry_for_test
#include "keiko_runtime_supervisor.c"
#undef main
#undef posix_spawn
#undef read
#undef sendmsg
#undef mkdtemp
#undef clock_gettime

enum { CLOCK_FAILURE = 1, DIRECTORY_FAILURE = 2, BOOTSTRAP_FAILURE = 3,
       GUI_UNAVAILABLE = 4, GUI_TIMEOUT = 5, ACK_FAILURE = 6, CLOCK_OFFSET = 7 };

static ssize_t fault_read(int descriptor, void *buffer, size_t length) {
  if (fault == ACK_FAILURE && descriptor == transferred_channel && length == 1) {
    errno = EIO;
    return -1;
  }
  return read(descriptor, buffer, length);
}

static ssize_t fault_sendmsg(int descriptor, const struct msghdr *message, int flags) {
  ssize_t result = sendmsg(descriptor, message, flags);
  if (result > 0 && fault == ACK_FAILURE) transferred_channel = descriptor;
  return result;
}

static int fault_clock(clockid_t clock, struct timespec *value) {
  if (fault == CLOCK_FAILURE) { errno = EIO; return -1; }
  if (fault == CLOCK_OFFSET) {
    value->tv_sec = clock == CLOCK_MONOTONIC_RAW ? 100 : 220;
    value->tv_nsec = 0;
    return 0;
  }
  int result = clock_gettime(clock, value);
  if (result == 0 && fault == GUI_TIMEOUT && probe_child > 0) value->tv_sec += 2;
  return result;
}

static char *fault_directory(char *path) {
  if (fault == DIRECTORY_FAILURE) { errno = EACCES; return NULL; }
  return mkdtemp(path);
}

static int fault_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                       const posix_spawnattr_t *attributes, char *const arguments[],
                       char *const environment[]) {
  if (fault == BOOTSTRAP_FAILURE) return EACCES;
  if (strcmp(path, "/bin/launchctl") == 0 && strcmp(arguments[1], "print") == 0) {
    char *const unavailable[] = {"/usr/bin/false", NULL};
    char *const timeout[] = {"/bin/sleep", "10", NULL};
    char *const *replacement = fault == GUI_UNAVAILABLE ? unavailable :
                              fault == GUI_TIMEOUT ? timeout : NULL;
    if (replacement != NULL) {
      int result = posix_spawn(pid, replacement[0], actions, attributes, replacement, environment);
      if (result == 0) probe_child = *pid;
      return result;
    }
  }
  return posix_spawn(pid, path, actions, attributes, arguments, environment);
}

static void pre_handoff_error(int failure) {
  int descriptors[2], status;
  unsigned char bytes[32];
  assert(pipe(descriptors) == 0);
  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(descriptors[0]);
    assert(dup2(descriptors[1], 4) == 4);
    if (descriptors[1] != 4) close(descriptors[1]);
    fault = failure;
    int result = keiko_job_bridge(0);
    close(4);
    _exit(result);
  }
  close(descriptors[1]);
  size_t count = 0;
  ssize_t length;
  while ((length = read(descriptors[0], bytes + count, sizeof(bytes) - count)) > 0)
    count += (size_t)length;
  close(descriptors[0]);
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 1);
  assert(count == 14 && memcmp(bytes, "KRS1", 4) == 0);
  assert(read_u16(bytes + 6) == RESPONSE_ERROR && read_u32(bytes + 8) == 2 &&
         read_u16(bytes + 12) == ERROR_TREE_OBSERVE);
}

static void raw_deadline_survives_adjusted_clock_offset(void) {
  int descriptors[2];
  assert(pipe(descriptors) == 0);
  assert(write(descriptors[1], "x", 1) == 1);
  fault = CLOCK_OFFSET;
  assert(keiko_job_ready(descriptors[0], POLLIN, 100050u));
  assert(!keiko_job_ready(descriptors[0], POLLIN, 99999u));
  fault = 0;
  close(descriptors[0]);
  close(descriptors[1]);
}

int main(int argc, char **argv) {
  if (argc > 1) return keiko_supervisor_entry_for_test(argc, argv);
  raw_deadline_survives_adjusted_clock_offset();
  pre_handoff_error(CLOCK_FAILURE);
  pre_handoff_error(DIRECTORY_FAILURE);
  pre_handoff_error(BOOTSTRAP_FAILURE);
  pre_handoff_error(ACK_FAILURE); /* The job is the only response writer after rights transfer. */
  assert(keiko_app_probe() == 0);
  fault = GUI_UNAVAILABLE;
  assert(keiko_app_probe() == ERROR_TREE_OBSERVE);
  fault = GUI_TIMEOUT; probe_child = -1;
  assert(keiko_app_probe() == ERROR_TREE_OBSERVE && probe_child > 0);
  assert(kill(probe_child, 0) == -1 && errno == ESRCH);
  puts("macOS app-job error frames and bounded GUI admission controls passed");
  return 0;
}
