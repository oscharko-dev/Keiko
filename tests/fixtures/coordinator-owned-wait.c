#define _DARWIN_C_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static int scenario;
static unsigned int waits;
static uint64_t fixture_now = 100;
static int unavailable;
static int fixture_clock_gettime(clockid_t clock_id, struct timespec *value) {
  (void)clock_id;
  if (unavailable) return -1;
  value->tv_sec = (time_t)(fixture_now / 1000u);
  value->tv_nsec = (long)(fixture_now % 1000u) * 1000000L;
  errno = 0;
  return 0;
}
static pid_t fixture_waitpid(pid_t child, int *status, int options) {
  (void)options;
  waits++;
  *status = 0;
  if (scenario == 1) fixture_now = 5100;
  if (scenario == 2) fixture_now = 5101;
  if (scenario == 3) { errno = ECHILD; return -1; }
  if (scenario == 4) { fixture_now += 2500; errno = EINTR; return -1; }
  if (scenario == 5) fixture_now = 5099;
  if (scenario == 8) unavailable = 1;
  if (scenario == 9) return child + 1;
  if (scenario == 10 && waits == 1) { errno = EINTR; return -1; }
  return child;
}
static int fixture_usleep(useconds_t duration) {
  fixture_now += duration / 1000;
  return 0;
}
#define clock_gettime fixture_clock_gettime
#define waitpid fixture_waitpid
#define usleep fixture_usleep
#define main fixture_launcher_main
#define KEIKO_PORTABLE_TARGET "macos-arm64"
#include "../../native/portable-launcher/keiko-portable-launcher.c"
#undef main
#undef clock_gettime
#undef waitpid
#undef usleep
int main(int argc, char **argv) {
  int status;
  pid_t child = 17;
  if (argc != 2) return 1;
  scenario = atoi(argv[1]);
  if (scenario == 6) fixture_now = 5100;
  if (scenario == 7) unavailable = 1;
  int admitted = keiko_coordinator_waitpid_deadline(&child, &status, 5100);
  printf("{\"admitted\":%d,\"waits\":%u,\"now\":%llu,\"error\":%d}\n", admitted,
         waits, (unsigned long long)fixture_now, errno);
  return 0;
}
