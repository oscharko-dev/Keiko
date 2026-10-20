#ifndef KEIKO_PORTABLE_PROCESS_SCOPE_LINUX_H
#define KEIKO_PORTABLE_PROCESS_SCOPE_LINUX_H

/* A private app-root port of the existing generation owner, in its outer PID coordinate. */
static int keiko_scope_socket(int descriptors[2]) {
  int enabled = 1;
  struct timeval bound = {.tv_sec = 5, .tv_usec = 0};
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, descriptors) != 0 ||
      setsockopt(descriptors[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0 ||
      setsockopt(descriptors[1], SOL_SOCKET, SO_RCVTIMEO, &bound, sizeof(bound)) != 0 ||
      setsockopt(descriptors[1], SOL_SOCKET, SO_SNDTIMEO, &bound, sizeof(bound)) != 0) return 0;
  for (size_t i = 0; i < 2; ++i) {
    int moved = fcntl(descriptors[i], F_DUPFD_CLOEXEC, 16);
    if (moved < 0) return 0;
    close(descriptors[i]); descriptors[i] = moved;
  }
  return 1;
}

static int keiko_scope_write(int descriptor, const unsigned char *bytes, size_t size,
                              uint64_t deadline) {
  for (;;) {
    if (!keiko_tree_before_deadline(deadline)) return 0;
    ssize_t count = send(descriptor, bytes, size, MSG_NOSIGNAL | MSG_DONTWAIT);
    if (count == (ssize_t)size) return keiko_tree_before_deadline(deadline);
    if (count >= 0 || errno != EINTR) return 0;
  }
}

static int keiko_scope_send(int descriptor, uint16_t kind, uint32_t pid, uint32_t value,
                             uint64_t deadline) {
  unsigned char bytes[20] = {'K','P','I','1',1,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0};
  write_u16(bytes + 6, kind);
  write_u32(bytes + 12, pid); write_u32(bytes + 16, value);
  return keiko_scope_write(descriptor, bytes, sizeof(bytes), deadline);
}

static void keiko_scope_u64(unsigned char *bytes, uint64_t value) {
  for (size_t i = 0; i < 8; ++i) bytes[i] = (unsigned char)(value >> (8u * i));
}

static uint64_t keiko_scope_read_u64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (size_t i = 0; i < 8; ++i) value |= (uint64_t)bytes[i] << (8u * i);
  return value;
}

static int keiko_scope_file_matches(const struct stat *file, const unsigned char *request) {
  return (uint64_t)file->st_dev == keiko_scope_read_u64(request + 16) &&
         (uint64_t)file->st_ino == keiko_scope_read_u64(request + 24) &&
         (uint32_t)file->st_mode == read_u32(request + 32);
}

static int keiko_scope_file_owner(keiko_runtime_owner *owner, const unsigned char *request,
                                   uint64_t deadline) {
  unsigned char bytes[44] = {'K','P','I','1',1,0,5,0,32,0,0,0};
  uint32_t descriptor = read_u32(request + 12);
  int conditional = read_u16(request + 6) == 6;
  if (conditional) write_u16(bytes + 6, 7);
  write_u32(bytes + 12, descriptor); write_u32(bytes + 16, 2);
  if (!keiko_tree_before_deadline(deadline)) return 0;
  int held = (int)syscall(SYS_pidfd_getfd, owner->root_handle, (int)descriptor, 0u);
  struct stat file;
  if (held >= 0) {
    if (fstat(held, &file) == 0) {
      if (conditional && !keiko_scope_file_matches(&file, request)) {
        write_u32(bytes + 16, 3);
      } else {
        write_u32(bytes + 16, 1); write_u32(bytes + 20, (uint32_t)file.st_uid);
        write_u32(bytes + 24, (uint32_t)file.st_mode);
        keiko_scope_u64(bytes + 28, (uint64_t)file.st_dev);
        keiko_scope_u64(bytes + 36, (uint64_t)file.st_ino);
      }
    }
    if (close(held) != 0) return 0;
  }
  return keiko_tree_before_deadline(deadline) &&
         keiko_scope_write(owner->scope, bytes, sizeof(bytes), deadline);
}

/* Only a kernel-confirmed missing/terminal reference is dead. All other errors stay unknown. */
static uint32_t keiko_scope_liveness(pid_t pid) {
  int reference = (int)syscall(SYS_pidfd_open, pid, 0u);
  if (reference < 0) return errno == ESRCH ? 2u : 3u;
  struct pollfd held = {reference, POLLIN, 0};
  int ready = poll(&held, 1, 0);
  uint32_t result = ready == 0 ? 1u : ready == 1 && (held.revents & POLLIN) != 0 &&
      (held.revents & (POLLERR | POLLNVAL)) == 0 ? 2u : 3u;
  if (close(reference) != 0) return 3u;
  return result;
}

static int keiko_scope_peer(struct msghdr *message, pid_t root) {
  int valid = 1, credentials = 0;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(message); header != NULL;
       header = CMSG_NXTHDR(message, header)) {
    if (header->cmsg_level != SOL_SOCKET) { valid = 0; continue; }
    if (header->cmsg_type == SCM_RIGHTS) {
      size_t size = header->cmsg_len >= CMSG_LEN(0) ? header->cmsg_len - CMSG_LEN(0) : 0;
      for (size_t offset = 0; offset + sizeof(int) <= size; offset += sizeof(int)) {
        int descriptor;
        memcpy(&descriptor, CMSG_DATA(header) + offset, sizeof(descriptor));
        close(descriptor);
      }
      valid = 0;
    } else if (header->cmsg_type == SCM_CREDENTIALS &&
               header->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred peer;
      memcpy(&peer, CMSG_DATA(header), sizeof(peer));
      if (peer.pid != root || peer.uid != geteuid() || peer.gid != getegid()) valid = 0;
      ++credentials;
    } else valid = 0;
  }
  return valid && credentials == 1;
}

static int keiko_scope_serve(keiko_runtime_owner *owner, uint64_t deadline) {
  unsigned char bytes[36];
  union { struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int) * 8)]; } control = {0};
  struct iovec payload = {bytes, sizeof(bytes)};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
                           .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  ssize_t count = recvmsg(owner->scope, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  int peer = count >= 0 ? keiko_scope_peer(&message, owner->root) : 0;
  if (count == 0) { keiko_owner_close(&owner->scope); return 1; }
  struct pollfd held = {owner->root_handle, POLLIN, 0};
  if (count < 16 || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0 ||
      !peer || poll(&held, 1, 0) != 0 ||
      memcmp(bytes, "KPI1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      (read_u16(bytes + 6) != 2 && read_u16(bytes + 6) != 4 && read_u16(bytes + 6) != 6) ||
      count != (read_u16(bytes + 6) == 6 ? 36 : 16) ||
      read_u32(bytes + 8) != (read_u16(bytes + 6) == 6 ? 24u : 4u) ||
      (read_u16(bytes + 6) == 2 && read_u32(bytes + 12) == 0) || read_u32(bytes + 12) > INT32_MAX ||
      !keiko_tree_before_deadline(deadline)) return 0;
  if (read_u16(bytes + 6) == 4 || read_u16(bytes + 6) == 6)
  {
    int result = keiko_scope_file_owner(owner, bytes, deadline);
    if (result) owner->scope_bound = 1;
    return result;
  }
  uint32_t pid = read_u32(bytes + 12), state = keiko_scope_liveness((pid_t)pid);
  int result = keiko_tree_before_deadline(deadline) &&
         keiko_scope_send(owner->scope, 3, pid, state, deadline);
  if (result) owner->scope_bound = 1;
  return result;
}

#endif
