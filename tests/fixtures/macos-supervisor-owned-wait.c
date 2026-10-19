#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int scenario;
static unsigned int waits;
static unsigned int frames;
static unsigned int response_kind;
static unsigned int exit_status;
static uint64_t now_ms = 100;

int fixture_clock_gettime(clockid_t clock_id, struct timespec *value) {
  if (scenario >= 20) return clock_gettime(clock_id, value);
  if (scenario == 8) return -1;
  value->tv_sec = (time_t)(now_ms / 1000u);
  value->tv_nsec = (long)(now_ms % 1000u) * 1000000L;
  return 0;
}

pid_t fixture_waitpid(pid_t child, int *status, int options) {
  waits++;
  if (scenario >= 20) return waitpid(child, status, options);
  if (scenario == 1) { errno = ECHILD; return -1; }
  if (scenario == 2) { *status = 7 << 8; return child + 1; }
  if (scenario == 3 && waits == 1) { errno = EINTR; return -1; }
  if (scenario == 4) { now_ms += 2500; errno = EINTR; return -1; }
  if (scenario == 5 && waits == 1 && (options & WNOHANG) != 0) return 0;
  if (scenario == 6) now_ms += 5000;
  if (scenario == 7) now_ms += 5001;
  if (scenario == 9) now_ms += 4999;
  *status = scenario == 10 ? SIGKILL : scenario == 11 ? (SIGSTOP << 8) | 0x7f : 7 << 8;
  return child;
}

int fixture_poll(struct pollfd *descriptors, nfds_t count, int timeout) {
  if (count == 0 && scenario >= 20) return poll(descriptors, count, timeout);
  if (count == 0) { if (timeout > 0) now_ms += (uint64_t)timeout; return 0; }
  descriptors[0].revents = 0;
  descriptors[1].revents = POLLIN;
  return 1;
}

ssize_t fixture_read(int descriptor, void *buffer, size_t length) {
  const unsigned char reply[12] = {'K', 'E', 'S', '1', 1, 0, 4, 0, 0, 0, 0, 0};
  (void)descriptor;
  if (length != sizeof(reply)) { errno = EIO; return -1; }
  memcpy(buffer, reply, length);
  return (ssize_t)length;
}

ssize_t fixture_write(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = buffer;
  (void)descriptor;
  if (length == 12 && memcmp(bytes, "KRS1", 4) == 0) {
    frames++;
    response_kind = bytes[6] | ((unsigned int)bytes[7] << 8);
  } else if (length == 8) {
    exit_status = bytes[0] | ((unsigned int)bytes[1] << 8);
  }
  return (ssize_t)length;
}

#define main supervisor_main
#define clock_gettime fixture_clock_gettime
#define waitpid fixture_waitpid
#define poll fixture_poll
#define read fixture_read
#define write fixture_write
#include "keiko_runtime_supervisor.c"
#undef main
#undef clock_gettime
#undef waitpid
#undef poll
#undef read
#undef write

int main(int argc, char **argv) {
  pid_t root = 17;
  if (argc != 2) return 1;
  scenario = atoi(argv[1]);
  if (scenario >= 20) {
    root = fork();
    if (root < 0) return 1;
    if (root == 0) {
      if (scenario == 21) (void)kill(getpid(), SIGKILL);
      _exit(7);
    }
    if (scenario == 22) {
      int status;
      pid_t observed;
      do { observed = waitpid(root, &status, 0); } while (observed < 0 && errno == EINTR);
      if (observed != root) return 1;
    }
  }
  int accepted = supervise(42, "0123456789abcdef0123456789abcdef", &root);
  printf("{\"accepted\":%d,\"frames\":%u,\"kind\":%u,\"exitStatus\":%u,"
         "\"waits\":%u,\"nowMs\":%llu}\n", accepted, frames, response_kind,
         exit_status, waits, (unsigned long long)now_ms);
  return 0;
}
