/* KRP1/KRC1/KRS1 Linux supervisor. A held PID-namespace init owns the generation. */
#define _GNU_SOURCE
#include "../macos/keiko_runtime_protocol.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>

#define GENERATION_TIMEOUT_MS 5000u

enum error_code {
  ERROR_PROTOCOL = 1, ERROR_PROCESS_CREATE = 3, ERROR_TREE_OBSERVE = 5,
  ERROR_NATIVE_UNAVAILABLE = 6
};

struct generation {
  pid_t init;
  pid_t root;
  int init_fd;
  int root_fd;
  int lease;
  int status;
  int reaped;
  int startup_error;
};

static uint64_t monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0 || value.tv_sec < 0 || value.tv_nsec < 0 ||
      value.tv_nsec >= 1000000000L ||
      (uint64_t)value.tv_sec > (UINT64_MAX - 999u) / 1000u) return 0;
  return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static int within_deadline(uint64_t started, uint64_t deadline) {
  uint64_t now = monotonic_ms();
  return started != 0 && now >= started && now < deadline;
}

static int wait_readable(int descriptor, uint64_t deadline) {
  uint64_t started = monotonic_ms();
  for (;;) {
    uint64_t now = monotonic_ms();
    struct pollfd item = {descriptor, POLLIN | POLLHUP, 0};
    int result;
    if (started == 0 || now < started || now >= deadline || deadline - now > INT_MAX) return 0;
    result = poll(&item, 1, (int)(deadline - now));
    if (result < 0 && errno == EINTR) continue;
    return within_deadline(started, deadline) && result == 1 &&
           (item.revents & (POLLIN | POLLHUP)) != 0;
  }
}

static void close_descriptor(int *descriptor) {
  if (*descriptor >= 0) close(*descriptor);
  *descriptor = -1;
}

static int retain_descriptors(int *keep, size_t count) {
  unsigned int next = 3;
  for (size_t i = 0; i < count; ++i) {
    for (size_t j = i + 1; j < count; ++j) {
      if (keep[j] < keep[i]) {
        int temporary = keep[j]; keep[j] = keep[i]; keep[i] = temporary;
      }
    }
  }
  for (size_t i = 0; i < count; ++i) {
    if (keep[i] < 3 || (unsigned int)keep[i] < next) continue;
    if ((unsigned int)keep[i] > next &&
        syscall(SYS_close_range, next, (unsigned int)keep[i] - 1u, 0u) != 0) return 0;
    next = (unsigned int)keep[i] + 1u;
  }
  return syscall(SYS_close_range, next, UINT_MAX, 0u) == 0;
}

static int drop_capabilities(void) {
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct values[2] = {{0}, {0}};
  for (int cap = 0; cap < 64; ++cap) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0) {
      if (errno != EINVAL) return 0;
      break;
    }
    if (present != 0 && prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0) return 0;
  }
  if (prctl(PR_CAPBSET_READ, 64, 0, 0, 0) != -1 || errno != EINVAL ||
      syscall(SYS_capset, &header, values) != 0 ||
      syscall(SYS_capget, &header, values) != 0) return 0;
  for (size_t i = 0; i < 2; ++i)
    if (values[i].effective || values[i].permitted || values[i].inheritable) return 0;
  return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0;
}

/* Full application values are applied only in the admitted root, after native loader startup. */
static char **app_environment(const struct launch_request *request,
                                const struct app_environment_packet *packet) {
  size_t count = packet->count, used = 0;
  if (count > SIZE_MAX / sizeof(char *) - request->environment_count - 1u) return NULL;
  char **selected = spawn_environment(request);
  char **values = calloc(count + request->environment_count + 1u, sizeof(char *));
  if (selected == NULL || values == NULL) goto failed;
  for (size_t i = 0; i < count; ++i) {
    const char *separator = strchr(packet->values[i], '=');
    int replaced = 0;
    if (separator == NULL) goto failed;
    size_t length = (size_t)(separator - packet->values[i]);
    for (uint16_t j = 0; j < request->environment_count; ++j)
      if (strlen(request->environment_names[j]) == length &&
          memcmp(packet->values[i], request->environment_names[j], length) == 0) replaced = 1;
    if (!replaced) {
      values[used] = strdup(packet->values[i]);
      if (values[used] == NULL) goto failed;
      ++used;
    }
  }
  for (uint16_t i = 0; i < request->environment_count; ++i) {
    values[used++] = selected[i]; selected[i] = NULL;
  }
  free(selected);
  return values;
failed:
  if (selected != NULL) clear_environment(selected, request->environment_count);
  clear_environment(values, (uint16_t)used);
  return NULL;
}

static void execute_root(const struct launch_request *request, int notices, int failure,
                         int start_gate, int scope, const struct app_environment_packet *app,
                         uint64_t deadline) {
  int keep[] = {notices, failure, start_gate, scope};
  char acknowledgement;
  char **arguments = spawn_arguments(request);
  char **environment = scope < 0 ? spawn_environment(request) : app_environment(request, app);
  if (arguments != NULL && environment != NULL && retain_descriptors(keep, 4) &&
      chdir(request->cwd) == 0 && send(notices, "R", 1, 0) == 1 &&
      recv(notices, &acknowledgement, 1, 0) == 1 && acknowledgement == 'A' &&
      within_deadline(1u, deadline)) {
    close(notices);
    execve(request->executable, arguments, environment);
  }
  int error = errno == 0 ? EINVAL : errno;
  free(arguments);
  clear_environment(environment, (uint16_t)(request->environment_count +
                    (app == NULL ? 0u : app->count)));
  (void)write_exact(failure, &error, sizeof(error));
  _exit(126);
}

static int root_exit_code(int status) {
  return WIFEXITED(status) ? WEXITSTATUS(status) : 137;
}

static void run_init(const struct launch_request *request, int gate, int notices, int lease,
                     int start_gate, uid_t uid, gid_t gid, int owner_handle, int scope,
                     const struct app_environment_packet *app, uint64_t deadline) {
  int keep[] = {gate, notices, lease, start_gate, owner_handle, scope};
  int execution[2];
  char accepted;
  if (!retain_descriptors(keep, 6) || !keiko_bind_parent_death(owner_handle) ||
      read(gate, &accepted, 1) != 1 || accepted != 'A' || !within_deadline(1u, deadline))
    _exit(126);
  close(gate);
  if (getpid() != 1 || getuid() != uid || geteuid() != uid || getgid() != gid ||
      getegid() != gid || !drop_capabilities() || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0 || !keiko_bind_parent_death(owner_handle) ||
      send(notices, "I", 1, 0) != 1 ||
      pipe2(execution, O_CLOEXEC | O_NONBLOCK) != 0) _exit(126);
  close(owner_handle);
  pid_t root = fork();
  if (root < 0) _exit(126);
  if (root == 0) execute_root(request, notices, execution[1], start_gate, scope, app, deadline);
  if (scope >= 0) close(scope);
  close(execution[1]);
  if (start_gate >= 0) close(start_gate);
  int launched = 0;
  for (;;) {
    struct pollfd items[2] = {{lease, POLLIN | POLLHUP, 0},
                              {launched ? -1 : execution[0], POLLIN | POLLHUP, 0}};
    int count = poll(items, 2, 10);
    if (count < 0 && errno != EINTR) _exit(126);
    if (items[0].revents != 0) _exit(137);
    if (!launched && items[1].revents != 0) {
      int error;
      ssize_t size = read(execution[0], &error, sizeof(error));
      if (size == 0) {
        if (send(notices, "L", 1, 0) != 1) _exit(126);
        launched = 1;
        close(execution[0]);
        close(notices);
      } else if (size > 0 || errno != EAGAIN) _exit(126);
    }
    int status;
    pid_t waited;
    do {
      waited = waitpid(-1, &status, WNOHANG);
      if (waited == root) _exit(root_exit_code(status));
    } while (waited > 0);
    if (waited < 0 && errno != EINTR) _exit(126);
  }
}

static int write_mapping(pid_t child, const char *name, const char *value) {
  char path[96];
  int length = snprintf(path, sizeof(path), "/proc/%ld/%s", (long)child, name);
  if (length <= 0 || (size_t)length >= sizeof(path)) return 0;
  int descriptor = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) return 0;
  int written = write_exact(descriptor, value, strlen(value));
  int closed = close(descriptor);
  return written && closed == 0;
}

static int initialize_mapping(pid_t child, uid_t uid, gid_t gid) {
  char mapping[96];
  if (!write_mapping(child, "setgroups", "deny\n")) return 0;
  int size = snprintf(mapping, sizeof(mapping), "%lu %lu 1\n",
                      (unsigned long)uid, (unsigned long)uid);
  if (size <= 0 || (size_t)size >= sizeof(mapping) ||
      !write_mapping(child, "uid_map", mapping)) return 0;
  size = snprintf(mapping, sizeof(mapping), "%lu %lu 1\n",
                  (unsigned long)gid, (unsigned long)gid);
  return size > 0 && (size_t)size < sizeof(mapping) && write_mapping(child, "gid_map", mapping);
}

static int receive_notice(int descriptor, char expected, struct generation *generation,
                           uint64_t deadline) {
  uint64_t started = monotonic_ms();
  char notice;
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(struct ucred))]; } control;
  struct iovec payload = {&notice, 1};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
                           .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  if (!wait_readable(descriptor, deadline) || recvmsg(descriptor, &message, MSG_DONTWAIT) != 1 ||
      notice != expected || (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0) return 0;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header == NULL || header->cmsg_level != SOL_SOCKET ||
      header->cmsg_type != SCM_CREDENTIALS || header->cmsg_len != CMSG_LEN(sizeof(struct ucred)) ||
      CMSG_NXTHDR(&message, header) != NULL) return 0;
  struct ucred peer;
  memcpy(&peer, CMSG_DATA(header), sizeof(peer));
  if (peer.pid <= 0 || peer.uid != geteuid() || peer.gid != getegid() ||
      !within_deadline(started, deadline)) return 0;
  if (expected != 'R') return peer.pid == generation->init;
  if (peer.pid == generation->init) return 0;
  generation->root = peer.pid;
  generation->root_fd = (int)syscall(SYS_pidfd_open, peer.pid, 0u);
  return generation->root_fd >= 0 && within_deadline(started, deadline) &&
         send(descriptor, "A", 1, 0) == 1 && within_deadline(started, deadline);
}

static int start_generation(struct generation *generation, const struct launch_request *request,
                              int scope, const struct app_environment_packet *app,
                              uint64_t startup_deadline) {
  int gate[2] = {-1, -1}, notices[2] = {-1, -1}, lease[2] = {-1, -1};
  int enabled = 1, result = 0, owner_handle = -1;
  int start_gate = fcntl(5, F_GETFD) == -1 ? -1 : 5;
  uid_t uid = getuid(); gid_t gid = getgid();
  uint64_t now = monotonic_ms(), deadline = now + GENERATION_TIMEOUT_MS;
  if (startup_deadline < deadline) deadline = startup_deadline;
  if (uid == 0 || uid != geteuid() || gid != getegid()) {
    generation->startup_error = ERROR_NATIVE_UNAVAILABLE;
    goto cleanup;
  }
  if (now == 0 || deadline <= now ||
      pipe2(gate, O_CLOEXEC) != 0 || pipe2(lease, O_CLOEXEC) != 0 ||
      socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, notices) != 0 ||
      setsockopt(notices[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0) goto cleanup;
  owner_handle = (int)syscall(SYS_pidfd_open, getpid(), 0u);
  if (owner_handle < 0 || !within_deadline(now, deadline)) goto cleanup;
  struct clone_args arguments = {.flags = CLONE_NEWUSER | CLONE_NEWPID | CLONE_PIDFD,
                                 .pidfd = (uintptr_t)&generation->init_fd,
                                 .exit_signal = SIGCHLD};
  pid_t child = (pid_t)syscall(SYS_clone3, &arguments, sizeof(arguments));
  if (child < 0) {
    if (errno == ENOSYS || errno == EPERM || errno == EACCES || errno == EINVAL)
      generation->startup_error = ERROR_NATIVE_UNAVAILABLE;
    goto cleanup;
  }
  if (child == 0) run_init(request, gate[0], notices[1], lease[0], start_gate, uid, gid,
                           owner_handle, scope, app, deadline);
  generation->init = child;
  generation->lease = lease[1]; lease[1] = -1;
  close_descriptor(&gate[0]); close_descriptor(&lease[0]); close_descriptor(&notices[1]);
  if (!initialize_mapping(child, uid, gid) || !within_deadline(now, deadline) ||
      write(gate[1], "A", 1) != 1 || !within_deadline(now, deadline)) goto cleanup;
  close_descriptor(&gate[1]);
  result = receive_notice(notices[0], 'I', generation, deadline) &&
           receive_notice(notices[0], 'R', generation, deadline) &&
           receive_notice(notices[0], 'L', generation, deadline);
cleanup:
  close_descriptor(&owner_handle);
  for (size_t i = 0; i < 2; ++i) {
    close_descriptor(&gate[i]); close_descriptor(&lease[i]); close_descriptor(&notices[i]);
  }
  return result;
}

static int wait_owned_init(struct generation *generation) {
  uint64_t started = monotonic_ms(), deadline = started + GENERATION_TIMEOUT_MS;
  pid_t expected = generation->init;
  if (generation->reaped || expected <= 0 || started == 0 || deadline <= started) return 0;
  for (;;) {
    if (!within_deadline(started, deadline)) return 0;
    pid_t waited = waitpid(expected, &generation->status, WNOHANG);
    int saved = errno;
    if (waited == expected) {
      generation->init = -1;
      generation->reaped = WIFEXITED(generation->status) || WIFSIGNALED(generation->status);
    } else if (waited < 0 && saved != EINTR) {
      generation->init = -1;
    }
    if (!within_deadline(started, deadline)) return 0;
    if (waited == expected) return generation->reaped;
    if (waited < 0 && saved != EINTR) return 0;
    struct pollfd item = {generation->init_fd, POLLIN, 0};
    if (poll(&item, 1, 1) < 0 && errno != EINTR) return 0;
  }
}

static void clear_generation(struct generation *generation) {
  close_descriptor(&generation->lease);
  if (!generation->reaped && generation->init > 0 && generation->init_fd >= 0) {
    (void)syscall(SYS_pidfd_send_signal, generation->init_fd, SIGKILL, NULL, 0u);
    (void)wait_owned_init(generation);
  }
  close_descriptor(&generation->init_fd);
  close_descriptor(&generation->root_fd);
}

static int valid_stop_request(void) {
  unsigned char header[KRP_HEADER_BYTES];
  size_t offset = 0;
  uint64_t now = monotonic_ms(), deadline = now + GENERATION_TIMEOUT_MS;
  if (now == 0 || deadline <= now) return 0;
  while (offset < sizeof(header)) {
    if (!wait_readable(3, deadline)) return 0;
    ssize_t length = read(3, header + offset, sizeof(header) - offset);
    if (!within_deadline(now, deadline)) return 0;
    if (length < 0 && errno == EINTR) continue;
    if (length == 0) return offset == 0;
    if (length < 0) return 0;
    offset += (size_t)length;
  }
  uint16_t kind = read_u16(header + 6);
  return memcmp(header, "KRC1", 4) == 0 && read_u16(header + 4) == KRP_VERSION &&
         (kind == 2u || kind == 3u) && read_u32(header + 8) == 0;
}

static int supervise(struct generation *generation) {
  for (;;) {
    struct pollfd items[2] = {{3, POLLIN | POLLHUP, 0}, {generation->init_fd, POLLIN, 0}};
    int count = poll(items, 2, -1);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return 0;
    if (items[0].revents != 0) {
      close_descriptor(&generation->lease);
      if (!valid_stop_request()) return 0;
    } else if (items[1].revents == 0) continue;
    if (!wait_owned_init(generation)) return 0;
    unsigned char proof[8];
    write_u32(proof, (uint32_t)root_exit_code(generation->status));
    /* Linux retires every member before the held namespace init's terminal wait returns. */
    write_u32(proof + 4, generation->reaped ? 0u : 1u);
    return send_response(RESPONSE_REAPED, proof, sizeof(proof));
  }
}

static int valid_owner_socket(int descriptor) {
  int type = 0;
  struct ucred peer;
  socklen_t type_size = sizeof(type), peer_size = sizeof(peer);
  return getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 &&
         type_size == sizeof(type) && type == SOCK_SEQPACKET &&
         getsockopt(descriptor, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) == 0 &&
         peer_size == sizeof(peer) && peer.pid > 0 && peer.pid == getppid() &&
         peer.uid == geteuid() && peer.gid == getegid() && keiko_parent_death_is_armed();
}

static int valid_owner_channel(void) { return valid_owner_socket(6); }

static int report_held_root(const struct generation *generation) {
  uint64_t started = monotonic_ms(), deadline = started + GENERATION_TIMEOUT_MS;
  unsigned char bytes[16] = {'K', 'R', 'I', '1', 1, 0, 1, 0, 4, 0, 0, 0, 0, 0, 0, 0};
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } ancillary = {0};
  struct iovec payload = {bytes, sizeof(bytes)};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
                           .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary.bytes)};
  struct pollfd held = {generation->root_fd, POLLIN, 0};
  if (started == 0 || deadline <= started || generation->root <= 0 || generation->root_fd < 0 ||
      !within_deadline(started, deadline) || poll(&held, 1, 0) != 0 ||
      !within_deadline(started, deadline)) return 0;
  write_u32(bytes + 12, (uint32_t)generation->root);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET;
  header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &generation->root_fd, sizeof(int));
  for (;;) {
    if (started == 0 || deadline <= started || !within_deadline(started, deadline)) return 0;
    ssize_t sent = sendmsg(6, &message, MSG_NOSIGNAL | MSG_DONTWAIT);
    if (sent == (ssize_t)sizeof(bytes)) return within_deadline(started, deadline);
    if (sent >= 0 || errno != EINTR) return 0;
  }
}

static int app_packet_reader(int descriptor, void *buffer, size_t length, void *context) {
  uint64_t deadline = *(const uint64_t *)context;
  unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    if (!wait_readable(descriptor, deadline)) return 0;
    ssize_t count = read(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || !within_deadline(1u, deadline)) return 0;
    offset += (size_t)count;
  }
  return within_deadline(1u, deadline);
}

int main(int argc, char **argv) {
  struct launch_request request = {0};
  struct app_environment_packet environment = {0};
  uint64_t now = monotonic_ms(), deadline = now + GENERATION_TIMEOUT_MS;
  struct generation generation = {.init = -1, .root = -1, .init_fd = -1, .root_fd = -1,
                                   .lease = -1, .status = 0, .reaped = 0,
                                   .startup_error = ERROR_PROCESS_CREATE};
  int error = ERROR_PROCESS_CREATE, result = 1;
  int app = argc == 2 && strcmp(argv[1], "--app-owner-report") == 0;
  int owner_report = app || (argc == 2 && strcmp(argv[1], "--owner-report") == 0);
  int owner_descriptor = owner_report ? 6 : -1;
  int scope = app ? 7 : -1;
  (void)signal(SIGPIPE, SIG_IGN);
  if ((argc != 1 && !owner_report) || (owner_report && !valid_owner_channel()) ||
      (app && (!valid_owner_socket(7) || now == 0 || deadline <= now ||
               !keiko_app_clip_deadline(&deadline, 1) || !within_deadline(now, deadline))) ||
      !(app ? read_launch_request_with_reader(&request, app_packet_reader, &deadline)
            : read_launch_request(&request)) ||
      (app && !read_app_environment(&environment, app_packet_reader, &deadline))) {
    error = ERROR_PROTOCOL;
    goto cleanup;
  }
  if (!start_generation(&generation, &request, scope, app ? &environment : NULL,
                        app ? deadline : UINT64_MAX)) {
    error = generation.startup_error;
    goto cleanup;
  }
  error = ERROR_TREE_OBSERVE;
  close_descriptor(&scope);
  if (owner_report) {
    int reported = report_held_root(&generation);
    close_descriptor(&owner_descriptor);
    if (!reported) goto cleanup;
  }
  if (!send_response(RESPONSE_LAUNCHED, NULL, 0)) goto cleanup;
  result = supervise(&generation) ? 0 : 1;
cleanup:
  close_descriptor(&owner_descriptor);
  close_descriptor(&scope);
  clear_generation(&generation);
  clear_request(&request);
  clear_app_environment(&environment);
  if (result != 0) (void)send_error((uint16_t)error);
  return result;
}
