/* Actual parent-side qualification of the supervisor's optional held-root identity channel. */
#define main keiko_runtime_supervisor_product_main
#include "keiko_runtime_supervisor.c"
#undef main

static int move_private(int descriptors[2]) {
  for (size_t i = 0; i < 2; ++i) {
    int moved = fcntl(descriptors[i], F_DUPFD_CLOEXEC, 16);
    if (moved < 0) return 0;
    close(descriptors[i]);
    descriptors[i] = moved;
  }
  return 1;
}

static int launch_supervisor(const char *helper, const char *mode, int control, int response,
                              int owner, int owner_handle) {
  if (!keiko_bind_parent_death(owner_handle)) return 0;
  close(owner_handle);
  if (dup2(control, 3) < 0 || dup2(response, 4) < 0) return 0;
  if (strcmp(mode, "missing") == 0) close(6);
  else if (dup2(owner, 6) < 0) return 0;
  close(5);
  if (syscall(SYS_close_range, 7u, UINT_MAX, 0u) != 0) return 0;
  execl(helper, helper, "--owner-report", (char *)NULL);
  return 0;
}

static int held_root(int descriptor, pid_t child, int *root_handle) {
  unsigned char bytes[16];
  union { struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int))]; } ancillary;
  struct iovec payload = {bytes, sizeof(bytes)};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
    .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary.bytes)};
  uint64_t deadline = monotonic_ms() + 5000u;
  if (!wait_readable(descriptor, deadline) ||
      recvmsg(descriptor, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT) != 16 ||
      (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0 ||
      memcmp(bytes, "KRI1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      read_u16(bytes + 6) != 1 || read_u32(bytes + 8) != 4 || read_u32(bytes + 12) == 0)
    return 0;
  int credentials = 0, handles = 0;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL;
       header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level != SOL_SOCKET) return 0;
    if (header->cmsg_type == SCM_CREDENTIALS &&
        header->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred peer;
      memcpy(&peer, CMSG_DATA(header), sizeof(peer));
      if (peer.pid != child || peer.uid != getuid() || peer.gid != getgid()) return 0;
      ++credentials;
    } else if (header->cmsg_type == SCM_RIGHTS &&
               header->cmsg_len == CMSG_LEN(sizeof(int))) {
      memcpy(root_handle, CMSG_DATA(header), sizeof(*root_handle));
      ++handles;
    } else return 0;
  }
  if (credentials != 1 || handles != 1 || *root_handle < 0 ||
      (fcntl(*root_handle, F_GETFD) & FD_CLOEXEC) == 0) return 0;
  char path[80], line[160];
  if (snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", *root_handle) <= 0) return 0;
  FILE *file = fopen(path, "r");
  if (file == NULL) return 0;
  long held_pid = -1;
  while (fgets(line, sizeof(line), file) != NULL) {
    if (strncmp(line, "Pid:", 4) == 0) held_pid = strtol(line + 4, NULL, 10);
  }
  int closed = fclose(file);
  struct pollfd held = {*root_handle, POLLIN, 0};
  return closed == 0 && held_pid == (long)read_u32(bytes + 12) && poll(&held, 1, 0) == 0;
}

int main(int argc, char **argv) {
  struct launch_request request = {0};
  int control[2] = {-1, -1}, response[2] = {-1, -1}, owner[2] = {-1, -1};
  int enabled = 1, root_handle = -1, status = 0, result = 1, owner_handle = -1;
  pid_t child = -1;
  if (argc != 3 || !read_launch_request(&request) || pipe2(control, O_CLOEXEC) != 0 ||
      pipe2(response, O_CLOEXEC) != 0) goto cleanup;
  if (strcmp(argv[2], "pipe") == 0) {
    if (pipe2(owner, O_CLOEXEC) != 0) goto cleanup;
  } else if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, owner) != 0 ||
             setsockopt(owner[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0)
    goto cleanup;
  if (!move_private(control) || !move_private(response) || !move_private(owner)) goto cleanup;
  owner_handle = (int)syscall(SYS_pidfd_open, getpid(), 0u);
  if (owner_handle < 0) goto cleanup;
  child = fork();
  if (child < 0) goto cleanup;
  if (child == 0) {
    if (strcmp(argv[2], "foreign-peer") == 0) {
      close_descriptor(&owner_handle);
      owner_handle = (int)syscall(SYS_pidfd_open, getpid(), 0u);
      if (owner_handle < 0) _exit(126);
      pid_t nested = fork();
      if (nested < 0) _exit(126);
      if (nested > 0) {
        if (waitpid(nested, &status, 0) != nested || !WIFEXITED(status)) _exit(126);
        _exit(WEXITSTATUS(status));
      }
    }
    _exit(launch_supervisor(argv[1], argv[2], control[0], response[1], owner[1], owner_handle) ? 0 : 126);
  }
  close_descriptor(&owner_handle);
  close_descriptor(&control[0]); close_descriptor(&response[1]); close_descriptor(&owner[1]);
  unsigned char header[12] = {'K','R','P','1',1,0,1,0,0,0,0,0};
  write_u32(header + 8, (uint32_t)(request.storage_length - 1u));
  if (strcmp(argv[2], "valid") == 0 &&
      (!write_exact(control[1], header, sizeof(header)) ||
       !write_exact(control[1], request.storage, request.storage_length - 1u))) goto cleanup;
  if (strcmp(argv[2], "valid") != 0) {
    unsigned char error[2];
    if (!read_exact(response[0], header, sizeof(header)) || memcmp(header, "KRS1", 4) != 0 ||
        read_u16(header + 6) != RESPONSE_ERROR || read_u32(header + 8) != 2 ||
        !read_exact(response[0], error, sizeof(error)) || read_u16(error) != ERROR_PROTOCOL)
      goto cleanup;
    if (waitpid(child, &status, 0) != child) goto cleanup;
    child = -1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 1) goto cleanup;
    result = write_exact(STDOUT_FILENO, "REFUSED\n", 8) ? 0 : 1;
    goto cleanup;
  }
  if (!held_root(owner[0], child, &root_handle) ||
      !read_exact(response[0], header, sizeof(header)) || memcmp(header, "KRS1", 4) != 0 ||
      read_u16(header + 6) != RESPONSE_LAUNCHED || read_u32(header + 8) != 0 ||
      !write_exact(STDOUT_FILENO, "HELD\n", 5)) goto cleanup;
  struct pollfd released = {owner[0], POLLIN | POLLHUP, 0};
  char unexpected;
  if (poll(&released, 1, 5000) != 1 || recv(owner[0], &unexpected, 1, MSG_DONTWAIT) != 0)
    goto cleanup;
  if (!read_exact(3, header, sizeof(header)) ||
      !write_exact(control[1], header, sizeof(header))) goto cleanup;
  unsigned char proof[8];
  if (!read_exact(response[0], header, sizeof(header)) || memcmp(header, "KRS1", 4) != 0 ||
      read_u16(header + 6) != RESPONSE_REAPED || read_u32(header + 8) != sizeof(proof) ||
      !read_exact(response[0], proof, sizeof(proof)) || read_u32(proof + 4) != 0) goto cleanup;
  struct pollfd held = {root_handle, POLLIN, 0};
  if (poll(&held, 1, 0) != 1 || (held.revents & POLLIN) == 0 ||
      waitpid(child, &status, 0) != child) goto cleanup;
  child = -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) goto cleanup;
  result = write_exact(STDOUT_FILENO, "RETIRED\n", 8) ? 0 : 1;
cleanup:
  if (child > 0) { kill(child, SIGKILL); (void)waitpid(child, &status, 0); }
  for (size_t i = 0; i < 2; ++i) {
    close_descriptor(&control[i]); close_descriptor(&response[i]); close_descriptor(&owner[i]);
  }
  close_descriptor(&owner_handle); close_descriptor(&root_handle); clear_request(&request);
  return result;
}
