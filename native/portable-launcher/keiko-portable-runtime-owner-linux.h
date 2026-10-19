#ifndef KEIKO_PORTABLE_RUNTIME_OWNER_LINUX_H
#define KEIKO_PORTABLE_RUNTIME_OWNER_LINUX_H

/* A role of the existing launcher, outside the generation held by its direct supervisor. */
#include "../runtime-supervisor/macos/keiko_runtime_protocol.h"
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <linux/magic.h>

#define KEIKO_OWNER_BOUND_MS 5000u

typedef struct {
  pid_t supervisor;
  pid_t root;
  int control;
  int response;
  int identity;
  int root_handle;
} keiko_runtime_owner;

static void keiko_owner_close(int *descriptor) {
  if (*descriptor >= 0) close(*descriptor);
  *descriptor = -1;
}

static int keiko_owner_private_pipe(int descriptors[2]) {
  if (!keiko_coordinator_pipe(descriptors)) return 0;
  for (size_t i = 0; i < 2; ++i) {
    int moved = fcntl(descriptors[i], F_DUPFD_CLOEXEC, 16);
    if (moved < 0) return 0;
    close(descriptors[i]); descriptors[i] = moved;
  }
  return 1;
}

static int keiko_owner_write(int descriptor, const void *content, size_t size,
                              uint64_t deadline) {
  const unsigned char *bytes = content;
  size_t offset = 0;
  while (offset < size) {
    struct pollfd item = {descriptor, POLLOUT, 0};
    uint64_t now = keiko_tree_now_ms();
    if (now >= deadline || deadline - now > INT_MAX) return 0;
    int result = poll(&item, 1, (int)(deadline - now));
    if (result < 0 && errno == EINTR) continue;
    if (result != 1 || (item.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0 ||
        keiko_tree_now_ms() >= deadline) return 0;
    ssize_t count = write(descriptor, bytes + offset, size - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return keiko_tree_now_ms() < deadline;
}

static int keiko_owner_child(const char *helper, int executable, const int control[2],
                              const int response[2], int identity, int start_gate, int owner_handle) {
  char *const arguments[] = {(char *)helper, (char *)"--owner-report", NULL};
  char *const environment[] = {NULL};
  if (!keiko_bind_parent_death(owner_handle)) return 0;
  close(owner_handle);
  if (start_gate < 0) close(5);
  else if (fcntl(5, F_SETFD, 0) != 0) return 0;
  if (dup2(control[0], 3) < 0 || dup2(response[1], 4) < 0 || dup2(identity, 6) < 0 ||
      (executable > 7 && syscall(SYS_close_range, 7u, (unsigned int)executable - 1u, 0u) != 0) ||
      syscall(SYS_close_range, (unsigned int)executable + 1u, UINT_MAX, 0u) != 0)
    return 0;
  fexecve(executable, arguments, environment);
  return 0;
}

static int keiko_owner_spawn(keiko_runtime_owner *owner, const char *helper,
                              const char *expected, uint64_t deadline) {
  int control[2] = {-1, -1}, response[2] = {-1, -1}, identity[2] = {-1, -1};
  char canonical[PATH_MAX], digest[65];
  int executable = -1, result = 0, enabled = 1, owner_handle = -1;
  int start_gate = fcntl(5, F_GETFD) < 0 ? -1 : 5;
  if (!keiko_khp_is_lower_hex(expected, 64u) || realpath(helper, canonical) == NULL ||
      strcmp(helper, canonical) != 0 ||
      (executable = keiko_coordinator_open_hashed_file(helper, deadline, digest)) < 0 ||
      strcmp(digest, expected) != 0 || !keiko_owner_private_pipe(control) ||
      !keiko_owner_private_pipe(response) ||
      socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, identity) != 0 ||
      setsockopt(identity[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0)
    goto cleanup;
  for (size_t i = 0; i < 2; ++i) {
    int moved_identity = fcntl(identity[i], F_DUPFD_CLOEXEC, 16);
    if (moved_identity < 0) goto cleanup;
    close(identity[i]); identity[i] = moved_identity;
  }
  int moved = fcntl(executable, F_DUPFD_CLOEXEC, 16);
  if (moved < 0) goto cleanup;
  close(executable); executable = moved;
  int flags = fcntl(control[1], F_GETFL);
  if (flags < 0 || fcntl(control[1], F_SETFL, flags | O_NONBLOCK) != 0 ||
      !keiko_tree_before_deadline(deadline)) goto cleanup;
  owner_handle = (int)syscall(SYS_pidfd_open, getpid(), 0u);
  if (owner_handle < 0 || !keiko_tree_before_deadline(deadline)) goto cleanup;
  owner->supervisor = fork();
  if (owner->supervisor < 0) goto cleanup;
  if (owner->supervisor == 0)
    _exit(keiko_owner_child(helper, executable, control, response, identity[1], start_gate, owner_handle) ? 0 : 126);
  owner->control = control[1]; control[1] = -1;
  owner->response = response[0]; response[0] = -1;
  owner->identity = identity[0]; identity[0] = -1;
  result = keiko_tree_before_deadline(deadline);
cleanup:
  keiko_owner_close(&owner_handle);
  if (executable >= 0) close(executable);
  for (size_t i = 0; i < 2; ++i) {
    keiko_owner_close(&control[i]); keiko_owner_close(&response[i]); keiko_owner_close(&identity[i]);
  }
  return result;
}

static int keiko_owner_capture_handles(keiko_runtime_owner *owner, struct msghdr *message) {
  int rights = 0, credentials = 0, valid = 1;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(message); header != NULL;
       header = CMSG_NXTHDR(message, header)) {
    if (header->cmsg_level != SOL_SOCKET) { valid = 0; continue; }
    if (header->cmsg_type == SCM_RIGHTS) {
      size_t size = header->cmsg_len >= CMSG_LEN(0) ? header->cmsg_len - CMSG_LEN(0) : 0;
      for (size_t offset = 0; offset + sizeof(int) <= size; offset += sizeof(int)) {
        int descriptor;
        memcpy(&descriptor, CMSG_DATA(header) + offset, sizeof(descriptor));
        if (rights++ == 0) owner->root_handle = descriptor;
        else close(descriptor);
      }
      if (size != sizeof(int)) valid = 0;
    } else if (header->cmsg_type == SCM_CREDENTIALS &&
               header->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred peer;
      memcpy(&peer, CMSG_DATA(header), sizeof(peer));
      if (peer.pid != owner->supervisor || peer.uid != geteuid() || peer.gid != getegid()) valid = 0;
      ++credentials;
    } else valid = 0;
  }
  return valid && rights == 1 && credentials == 1;
}

static int keiko_owner_read_proc(const char *path, char *output, size_t capacity,
                                  uint64_t deadline) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  struct statfs filesystem;
  size_t offset = 0;
  int result = 0;
  if (descriptor < 0 || fstatfs(descriptor, &filesystem) != 0 ||
      filesystem.f_type != PROC_SUPER_MAGIC) goto cleanup;
  while (offset + 1u < capacity && keiko_tree_before_deadline(deadline)) {
    ssize_t count = read(descriptor, output + offset, capacity - offset - 1u);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) break;
    if (count == 0) { output[offset] = '\0'; result = 1; break; }
    offset += (size_t)count;
  }
cleanup:
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  return result && keiko_tree_before_deadline(deadline);
}

static int keiko_owner_proc_scalar(const char *content, const char *field, pid_t expected) {
  size_t length = strlen(field);
  int matches = 0;
  for (const char *line = content; line != NULL && *line != '\0'; ) {
    const char *end = strchr(line, '\n');
    if (end == NULL) return 0;
    if ((size_t)(end - line) > length && memcmp(line, field, length) == 0) {
      const char *number = line + length;
      while (number < end && (*number == '\t' || *number == ' ')) ++number;
      if (number == end || *number < '1' || *number > '9') return 0;
      char *after;
      errno = 0;
      long value = strtol(number, &after, 10);
      if (errno != 0 || value != expected) return 0;
      while (after < end && (*after == '\t' || *after == ' ')) ++after;
      if (after != end) return 0;
      ++matches;
    }
    line = end + 1;
  }
  return matches == 1;
}

static int keiko_owner_root_reference(const keiko_runtime_owner *owner, uint64_t deadline) {
  char content[16u * 1024u], path[80];
  if (!keiko_owner_read_proc("/proc/self/status", content, sizeof(content), deadline) ||
      !keiko_owner_proc_scalar(content, "NSpid:", getpid()) ||
      !keiko_owner_proc_scalar(content, "NStgid:", getpid()) ||
      snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", owner->root_handle) <= 0 ||
      !keiko_owner_read_proc(path, content, sizeof(content), deadline) ||
      !keiko_owner_proc_scalar(content, "Pid:", owner->root) ||
      syscall(SYS_pidfd_send_signal, owner->root_handle, 0, NULL, 0u) != 0)
    return 0;
  struct pollfd held = {owner->root_handle, POLLIN, 0};
  return poll(&held, 1, 0) == 0 && keiko_tree_before_deadline(deadline);
}

static int keiko_owner_capture(keiko_runtime_owner *owner, uint64_t deadline) {
  unsigned char bytes[16];
  union { struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int))]; } ancillary = {0};
  struct iovec payload = {bytes, sizeof(bytes)};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
    .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary.bytes)};
  struct pollfd item = {owner->identity, POLLIN, 0};
  uint64_t now = keiko_tree_now_ms();
  if (now >= deadline || deadline - now > INT_MAX ||
      poll(&item, 1, (int)(deadline - now)) != 1) return 0;
  ssize_t count = recvmsg(owner->identity, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (count < 0) return 0;
  if (!keiko_owner_capture_handles(owner, &message) || count != sizeof(bytes) ||
      (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0 ||
      memcmp(bytes, "KRI1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      read_u16(bytes + 6) != 1 || read_u32(bytes + 8) != 4 ||
      read_u32(bytes + 12) == 0 || read_u32(bytes + 12) > INT32_MAX ||
      read_u32(bytes + 12) == (uint32_t)owner->supervisor ||
      read_u32(bytes + 12) == (uint32_t)getpid() ||
      !keiko_tree_before_deadline(deadline)) return 0;
  owner->root = (pid_t)read_u32(bytes + 12);
  return keiko_owner_root_reference(owner, deadline);
}

static int keiko_owner_response(keiko_runtime_owner *owner, unsigned char header[12],
                                 unsigned char payload[64], uint64_t deadline) {
  if (!keiko_coordinator_read_exact_deadline(owner->response, header, 12, deadline) ||
      memcmp(header, "KRS1", 4) != 0 || read_u16(header + 4) != 1) return 0;
  uint32_t size = read_u32(header + 8);
  return size <= 64 && (size == 0 ||
    keiko_coordinator_read_exact_deadline(owner->response, payload, size, deadline));
}

static int keiko_owner_start_failure(keiko_runtime_owner *owner, uint64_t deadline) {
  unsigned char header[12], payload[64];
  if (!keiko_owner_response(owner, header, payload, deadline) ||
      read_u16(header + 6) != RESPONSE_ERROR || read_u32(header + 8) != 2) return 5;
  uint16_t code = read_u16(payload);
  return code == 1 || code == 3 || code == 5 || code == 6 ? code : 5;
}

static int keiko_owner_wait(keiko_runtime_owner *owner) {
  unsigned char header[12], payload[64];
  int stopping = 0;
  uint64_t stop_deadline = 0;
  for (;;) {
    struct pollfd items[2] = {{stopping ? -1 : 3, POLLIN | POLLHUP, 0},
                              {owner->response, POLLIN | POLLHUP, 0}};
    uint64_t now = keiko_tree_now_ms();
    if (stopping && (now >= stop_deadline || stop_deadline - now > INT_MAX)) return 0;
    int timeout = stopping ? (int)(stop_deadline - now) : -1;
    int ready = poll(items, 2, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (stopping && !keiko_tree_before_deadline(stop_deadline))) return 0;
    uint64_t deadline = stopping ? stop_deadline : keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
    if (items[0].revents != 0) {
      stop_deadline = deadline;
      ssize_t count = read(3, header, sizeof(header));
      if (count == 0) keiko_owner_close(&owner->control);
      else if (count < 0 || (count < 12 && !keiko_coordinator_read_exact_deadline(
                   3, header + count, 12u - (size_t)count, deadline)) ||
               memcmp(header, "KRC1", 4) != 0 || read_u16(header + 4) != 1 ||
               (read_u16(header + 6) != 2 && read_u16(header + 6) != 3) ||
               read_u32(header + 8) != 0 ||
               !keiko_owner_write(owner->control, header, sizeof(header), deadline)) return 0;
      stopping = 1;
    }
    if (items[1].revents == 0) continue;
    if (!keiko_owner_response(owner, header, payload, deadline) ||
        read_u16(header + 6) != RESPONSE_REAPED || read_u32(header + 8) != 8 ||
        read_u32(payload + 4) != 0) return 0;
    struct pollfd held = {owner->root_handle, POLLIN, 0};
    int status;
    if (poll(&held, 1, 0) != 1 || (held.revents & POLLIN) == 0 ||
        !keiko_coordinator_waitpid_deadline(&owner->supervisor, &status, deadline) ||
        !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 0;
    return send_response(RESPONSE_REAPED, payload, 8);
  }
}

static int keiko_runtime_owner_linux(const char *helper, const char *expected) {
  keiko_runtime_owner owner = {.supervisor = -1, .root = -1, .control = -1,
                                .response = -1, .identity = -1, .root_handle = -1};
  struct launch_request request = {0};
  unsigned char header[12] = {'K','R','P','1',1,0,1,0,0,0,0,0}, payload[64];
  uint64_t deadline = keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
  int result = 1, error = 1;
  int had_start_gate = fcntl(5, F_GETFD) >= 0;
  (void)signal(SIGPIPE, SIG_IGN);
  if (!read_launch_request(&request)) goto cleanup;
  error = 3;
  if (!keiko_owner_spawn(&owner, helper, expected, deadline)) goto cleanup;
  error = 5;
  write_u32(header + 8, (uint32_t)(request.storage_length - 1u));
  if (!keiko_owner_write(owner.control, header, sizeof(header), deadline) ||
      !keiko_owner_write(owner.control, request.storage, request.storage_length - 1u, deadline))
    goto cleanup;
  if (!keiko_owner_capture(&owner, deadline)) {
    error = keiko_owner_start_failure(&owner, deadline);
    goto cleanup;
  }
  if (!keiko_owner_response(&owner, header, payload, deadline) ||
      read_u16(header + 6) != RESPONSE_LAUNCHED || read_u32(header + 8) != 0 ||
      !send_response(RESPONSE_LAUNCHED, NULL, 0)) goto cleanup;
  keiko_owner_close(&owner.identity);
  if (had_start_gate) close(5);
  result = keiko_owner_wait(&owner) ? 0 : 1;
cleanup:
  keiko_owner_close(&owner.control); keiko_owner_close(&owner.response);
  keiko_owner_close(&owner.identity); keiko_owner_close(&owner.root_handle);
  keiko_coordinator_dispose_child(&owner.supervisor);
  clear_request(&request);
  if (result != 0) (void)send_error((uint16_t)error);
  return result;
}

#endif
