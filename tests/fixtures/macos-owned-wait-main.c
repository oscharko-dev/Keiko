#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <poll.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include "keiko_runtime_monitor_protocol.h"
#include "owner-declarations.h"

struct launch_request { char recovery_handle[KEIKO_RECOVERY_HANDLE_BYTES + 1]; };
static int scenario, reaped, kills, unsafe_kills, replies, frames, stops, clock_unavailable;
static uint64_t now_ms = 100;

static int fixture_clock_gettime(clockid_t id, struct timespec *now) {
  (void)id;
  if (clock_unavailable) return -1;
  now->tv_sec = (time_t)(now_ms / 1000u);
  now->tv_nsec = (long)(now_ms % 1000u) * 1000000L;
  errno = 0;
  return 0;
}

static pid_t fixture_waitpid(pid_t child, int *status, int options) {
  (void)options;
  if (reaped) { errno = ECHILD; return -1; }
  if (scenario == 5 && kills == 0) { now_ms += 5000; return 0; }
  *status = 0;
  reaped = 1;
  if (scenario == 1) now_ms = 5100;
  if (scenario == 2) now_ms = 5101;
  if (scenario == 8) clock_unavailable = 1;
  return child;
}

static int fixture_poll(struct pollfd *descriptors, nfds_t count, int timeout) {
  (void)timeout;
  if (count == 0) { now_ms++; return 0; }
  descriptors[0].revents = 0;
  descriptors[1].revents = POLLIN;
  return 1;
}

static int fixture_kill(pid_t child, int signal) {
  (void)signal;
  kills++;
  if (reaped || child != 17) unsafe_kills++;
  return 0;
}

static int fixture_close(int descriptor) { (void)descriptor; return 0; }
static int monitor_connect(void) { return 42; }
static int monitor_request(int descriptor, uint16_t kind, const char *handle) {
  (void)descriptor; (void)handle;
  if (kind == KEIKO_MONITOR_STOP) stops++;
  return 1;
}

static int monitor_reply(int descriptor, struct keiko_monitor_reply *reply) {
  (void)descriptor;
  if (scenario == 6 && replies != 0) return 0;
  reply->kind = replies++ == 0 ? KEIKO_MONITOR_ARMED :
      scenario == 7 ? KEIKO_MONITOR_ROOT_OBSERVED : KEIKO_MONITOR_ZERO_LIVE;
  reply->live_processes = 0;
  return 1;
}

static int send_response(uint16_t kind, const unsigned char *bytes, uint32_t length) {
  (void)bytes; (void)length;
  if (kind == RESPONSE_REAPED) frames++;
  return !(scenario == 3 || scenario == 7);
}

static int send_error(enum error_code kind) { (void)kind; return 1; }
static void consume_control(void) {}
static int probe_monitor(void) { return 0; }
static int reconcile(const char *handle) { (void)handle; return 0; }
static int read_launch_request(struct launch_request *request) {
  memset(request->recovery_handle, 'a', KEIKO_RECOVERY_HANDLE_BYTES);
  return 1;
}
static void clear_request(struct launch_request *request) { (void)request; }
static int spawn_runtime(const struct launch_request *request, pid_t *root) {
  (void)request; *root = 17; return 1;
}

#define clock_gettime fixture_clock_gettime
#define waitpid fixture_waitpid
#define poll fixture_poll
#define kill fixture_kill
#define close fixture_close
#define main actual_supervisor_main
#include "owner-under-test.h"
#undef main

int main(int argc, char **argv) {
  if (argc != 2) return 1;
  scenario = atoi(argv[1]);
  reaped = scenario == 4;
  char *arguments[] = {"inert-supervisor", NULL};
  int code = actual_supervisor_main(1, arguments);
  printf("{\"exitCode\":%d,\"kills\":%d,\"unsafeKills\":%d,\"reapedFrames\":%d,\"stops\":%d}\n",
         code, kills, unsafe_kills, frames, stops);
  return 0;
}
