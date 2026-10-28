/* Deterministic adverse OS results exercise the actual outer-owner scope decoder. */
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <stdint.h>
#include <stdarg.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static const char *mode;
static uint64_t clock_offset;
static int fixture_clock(clockid_t clock, struct timespec *value);
static long fixture_syscall(long number, ...);
static ssize_t fixture_send(int descriptor, const void *buffer, size_t size, int flags);
#define clock_gettime fixture_clock
#define syscall fixture_syscall
#define send fixture_send
#define main keiko_portable_launcher_product_main
#include "../../portable-launcher/keiko-portable-launcher.c"
#undef main
#undef send
#undef syscall
#undef clock_gettime

static int fixture_clock(clockid_t clock, struct timespec *value) {
  int result = clock_gettime(clock, value);
  if (result == 0 && clock == CLOCK_MONOTONIC) value->tv_sec += (time_t)(clock_offset / 1000u);
  return result;
}

static long fixture_syscall(long number, ...) {
  assert(number == SYS_pidfd_open);
  va_list arguments;
  va_start(arguments, number);
  pid_t pid = va_arg(arguments, pid_t);
  unsigned int flags = va_arg(arguments, unsigned int);
  va_end(arguments);
  assert(flags == 0);
  if (strcmp(mode, "denied") == 0) { errno = EPERM; return -1; }
  if (strcmp(mode, "missing-proc") == 0) { errno = ENOENT; return -1; }
  if (strcmp(mode, "unavailable") == 0) { errno = ENOSYS; return -1; }
  if (strcmp(mode, "absent") == 0) { errno = ESRCH; return -1; }
  long result = syscall(number, pid, flags);
  if (strcmp(mode, "late-probe") == 0) clock_offset += 10000u;
  return result;
}

static ssize_t fixture_send(int descriptor, const void *buffer, size_t size, int flags) {
  ssize_t result = send(descriptor, buffer, size, flags);
  if (strcmp(mode, "late-send") == 0) clock_offset += 10000u;
  return result;
}

static int descriptor_count(void) {
  DIR *directory = opendir("/proc/self/fd");
  assert(directory != NULL);
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) if (entry->d_name[0] != '.') ++count;
  assert(closedir(directory) == 0);
  return count;
}

static void request_packet(int socket, const unsigned char bytes[37]) {
  int rights[12];
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(rights))]; } ancillary = {0};
  size_t size = strncmp(mode, "conditional-", 12) == 0 ? 36u : 16u;
  if (strcmp(mode, "short") == 0 || strcmp(mode, "conditional-short") == 0) --size;
  if (strcmp(mode, "oversized") == 0 || strcmp(mode, "conditional-long") == 0) ++size;
  struct iovec payload = {(void *)bytes, size};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1};
  if (strcmp(mode, "rights") == 0 || strcmp(mode, "truncated-rights") == 0 ||
      strcmp(mode, "conditional-rights") == 0) {
    size_t count = strcmp(mode, "truncated-rights") == 0 ? 12u : 1u;
    for (size_t i = 0; i < count; ++i) rights[i] = socket;
    message.msg_control = ancillary.bytes;
    message.msg_controllen = CMSG_SPACE(sizeof(int) * count);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * count);
    memcpy(CMSG_DATA(header), rights, sizeof(int) * count);
  }
  assert(sendmsg(socket, &message, MSG_NOSIGNAL) == (ssize_t)payload.iov_len);
}

int main(int argc, char **argv) {
  assert(argc == 2);
  mode = argv[1];
  int sockets[2] = {-1, -1};
  assert(keiko_scope_socket(sockets));
  keiko_runtime_owner owner = {.scope = sockets[0], .root = getpid(),
    .root_handle = (int)syscall(SYS_pidfd_open, getpid(), 0u)};
  assert(owner.root_handle >= 0);
  int before = descriptor_count();
  unsigned char bytes[37] = {'K','P','I','1',1,0,2,0,4,0,0,0};
  write_u32(bytes + 12, (uint32_t)getpid());
  if (strncmp(mode, "conditional-", 12) == 0) {
    write_u16(bytes + 6, 6); write_u32(bytes + 8, 24);
  }
  if (strcmp(mode, "conditional-length") == 0) bytes[8] = 4;
  if (strcmp(mode, "conditional-fd") == 0) write_u32(bytes + 12, UINT32_MAX);
  if (strcmp(mode, "conditional-foreign") == 0) owner.root = getpid() + 1;
  if (strcmp(mode, "conditional-expired") == 0) clock_offset = 10000u;
  if (strcmp(mode, "magic") == 0) bytes[0] = 'X';
  if (strcmp(mode, "version") == 0) bytes[4] = 2;
  if (strcmp(mode, "kind") == 0) bytes[6] = 1;
  if (strcmp(mode, "length") == 0) bytes[8] = 8;
  if (strcmp(mode, "zero-pid") == 0) write_u32(bytes + 12, 0);
  if (strcmp(mode, "negative-pid") == 0) write_u32(bytes + 12, UINT32_MAX);
  if (strcmp(mode, "foreign") == 0) owner.root = getpid() + 1;
  if (strcmp(mode, "expired") == 0) clock_offset = 10000u;
  request_packet(sockets[1], bytes);
  uint64_t deadline = keiko_tree_now_ms() + 5000u - clock_offset;
  int result = keiko_scope_serve(&owner, deadline);
  int expected = strcmp(mode, "valid") == 0 || strcmp(mode, "denied") == 0 ||
    strcmp(mode, "missing-proc") == 0 || strcmp(mode, "unavailable") == 0 ||
    strcmp(mode, "absent") == 0;
  assert(result == expected);
  assert(descriptor_count() == before);
  if (expected) {
    unsigned char response[20];
    assert(recv(sockets[1], response, sizeof(response), MSG_DONTWAIT | MSG_TRUNC) == 20);
    assert(memcmp(response, "KPI1", 4) == 0 && read_u16(response + 4) == 1 &&
      read_u16(response + 6) == 3 && read_u32(response + 8) == 8 &&
      read_u32(response + 12) == (uint32_t)getpid());
    assert(read_u32(response + 16) == (strcmp(mode, "valid") == 0 ? 1u :
      strcmp(mode, "absent") == 0 ? 2u : 3u));
  }
  close(sockets[0]); close(sockets[1]); close(owner.root_handle);
  return 0;
}
