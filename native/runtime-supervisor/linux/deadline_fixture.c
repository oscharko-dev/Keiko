/* Deterministic scheduling controls exercise the actual native deadline owners. */
#define _GNU_SOURCE
#define main keiko_supervisor_product_main
#define clock_gettime fixture_clock_gettime
#define waitpid fixture_waitpid
#define poll fixture_poll
#define recvmsg fixture_recvmsg
#define send fixture_send
#define syscall fixture_syscall
#include "keiko_runtime_supervisor.c"
#undef main
#undef clock_gettime
#undef waitpid
#undef poll
#undef recvmsg
#undef send
#undef syscall

#include <assert.h>
#include <stdarg.h>

static uint64_t fake_now = 1000;
static uint64_t poll_advance;
static uint64_t receive_advance;
static uint64_t send_advance;
static uint64_t wait_advance;
static int send_count;
static char notice_kind = 'I';

int fixture_clock_gettime(clockid_t clock, struct timespec *value) {
  assert(clock == CLOCK_MONOTONIC);
  value->tv_sec = (time_t)(fake_now / 1000u);
  value->tv_nsec = (long)(fake_now % 1000u) * 1000000L;
  return 0;
}

pid_t fixture_waitpid(pid_t pid, int *status, int options) {
  assert(pid == 123 && options == WNOHANG);
  fake_now += wait_advance;
  *status = 0;
  return pid;
}

int fixture_poll(struct pollfd *items, nfds_t count, int timeout) {
  assert(count == 1 && timeout > 0);
  fake_now += poll_advance;
  items[0].revents = POLLIN;
  return 1;
}

ssize_t fixture_recvmsg(int descriptor, struct msghdr *message, int flags) {
  assert(descriptor == 19 && flags == MSG_DONTWAIT && message->msg_iovlen == 1);
  fake_now += receive_advance;
  *(char *)message->msg_iov[0].iov_base = notice_kind;
  message->msg_flags = 0;
  message->msg_controllen = CMSG_SPACE(sizeof(struct ucred));
  struct cmsghdr *header = CMSG_FIRSTHDR(message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_CREDENTIALS;
  header->cmsg_len = CMSG_LEN(sizeof(struct ucred));
  struct ucred peer = {notice_kind == 'R' ? 234 : 123, geteuid(), getegid()};
  memcpy(CMSG_DATA(header), &peer, sizeof(peer));
  return 1;
}

ssize_t fixture_send(int descriptor, const void *bytes, size_t length, int flags) {
  assert(descriptor == 19 && length == 1 && *(const char *)bytes == 'A' && flags == 0);
  fake_now += send_advance;
  send_count += 1;
  return 1;
}

long fixture_syscall(long number, ...) {
  assert(number == SYS_pidfd_open);
  va_list values;
  va_start(values, number);
  assert(va_arg(values, pid_t) == 234 && va_arg(values, unsigned int) == 0u);
  va_end(values);
  return 17;
}

int main(int argc, char **argv) {
  assert(argc == 2);
  struct generation generation = {.init = 123, .root = -1, .init_fd = -1, .root_fd = -1,
                                   .lease = -1, .status = 0, .reaped = 0};
  if (strcmp(argv[1], "normal-wait") == 0 || strcmp(argv[1], "late-wait") == 0) {
    int late = strcmp(argv[1], "late-wait") == 0;
    wait_advance = late ? 6000u : 0u;
    assert(wait_owned_init(&generation) == !late);
    assert(generation.init == -1 && generation.reaped);
    clear_generation(&generation);
  } else if (strcmp(argv[1], "normal-poll") == 0 || strcmp(argv[1], "late-poll") == 0) {
    int late = strcmp(argv[1], "late-poll") == 0;
    poll_advance = late ? 6000u : 0u;
    assert(wait_readable(19, 6000u) == !late);
  } else {
    int root = strstr(argv[1], "ack") != NULL;
    int late_receive = strcmp(argv[1], "late-receive") == 0 ||
                       strcmp(argv[1], "late-before-ack") == 0;
    int late_send = strcmp(argv[1], "late-ack") == 0;
    assert(root || strcmp(argv[1], "normal-receive") == 0 || late_receive);
    notice_kind = root ? 'R' : 'I';
    receive_advance = late_receive ? 6000u : 0u;
    send_advance = late_send ? 6000u : 0u;
    assert(receive_notice(19, notice_kind, &generation, 6000u) == !(late_receive || late_send));
    assert(send_count == (root && !late_receive ? 1 : 0));
  }
  return 0;
}
