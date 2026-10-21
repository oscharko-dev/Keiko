/* KRP1/KRC1/KRS1 macOS supervisor backed by Keiko's Endpoint Security system extension. */
#include "keiko_runtime_monitor_protocol.h"

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

#define KRP_CHILD_REAP_TIMEOUT_MS 5000u

enum error_code {
  ERROR_PROTOCOL = 1,
  ERROR_MONITOR_UNAVAILABLE = 6,
  ERROR_PROCESS_CREATE = 3,
  ERROR_TREE_OBSERVE = 5,
  // KEIKO-0433: reconcile found the handle, but a live connection already owns that session.
  // Distinct from ERROR_TREE_OBSERVE (could not observe) and from the reaped success path.
  ERROR_TREE_ALREADY_SUPERVISED = 7
};

_Static_assert(sizeof(struct keiko_monitor_request) == 44, "monitor request layout");
_Static_assert(sizeof(struct keiko_monitor_reply) == 12, "monitor reply layout");

static int monitor_connect(void) {
  struct sockaddr_un address;
  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor == -1) return -1;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(address.sun_path, sizeof(address.sun_path), "%s", KEIKO_MONITOR_SOCKET);
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(descriptor);
    return -1;
  }
  (void)fcntl(descriptor, F_SETFD, FD_CLOEXEC);
  return descriptor;
}

static int monitor_request(int descriptor, uint16_t command, const char *handle) {
  struct keiko_monitor_request request;
  memset(&request, 0, sizeof(request));
  memcpy(request.magic, "KEM1", 4);
  request.version = KEIKO_MONITOR_VERSION;
  request.command = command;
  if (handle != NULL) memcpy(request.recovery_handle, handle, KEIKO_RECOVERY_HANDLE_BYTES);
  request.supervisor_pid = (uint32_t)getpid();
  return write_exact(descriptor, &request, sizeof(request));
}

static int monitor_reply(int descriptor, struct keiko_monitor_reply *reply) {
  return read_exact(descriptor, reply, sizeof(*reply)) && memcmp(reply->magic, "KES1", 4) == 0 &&
         reply->version == KEIKO_MONITOR_VERSION;
}

static int spawn_runtime_environment(const struct launch_request *request, pid_t *pid,
                                       char **environment, short flags) {
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  char **arguments = spawn_arguments(request);
  int result = EINVAL;
  if (arguments == NULL || environment == NULL) goto cleanup;
  if (chdir(request->cwd) != 0) goto cleanup;
  if (posix_spawn_file_actions_init(&actions) != 0) goto cleanup;
  if (posix_spawnattr_init(&attributes) != 0) {
    posix_spawn_file_actions_destroy(&actions);
    goto cleanup;
  }
  if (posix_spawnattr_setflags(&attributes, flags) != 0) {
    posix_spawnattr_destroy(&attributes);
    posix_spawn_file_actions_destroy(&actions);
    goto cleanup;
  }
  (void)posix_spawn_file_actions_addclose(&actions, 3);
  (void)posix_spawn_file_actions_addclose(&actions, 4);
  if (flags != 0) {
    if (fcntl(6, F_GETFD) >= 0) (void)posix_spawn_file_actions_addclose(&actions, 6);
    if (fcntl(7, F_GETFD) >= 0) (void)posix_spawn_file_actions_addclose(&actions, 7);
  }
  result = posix_spawn(
      pid, request->executable, &actions, &attributes, arguments, environment);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
cleanup:
  free(arguments);
  return result == 0;
}

static int spawn_runtime(const struct launch_request *request, pid_t *pid) {
  char **environment = spawn_environment(request);
  int result = environment != NULL && spawn_runtime_environment(request, pid, environment, 0);
  clear_environment(environment, request->environment_count);
  return result;
}

static void consume_control(void) {
  unsigned char header[KRP_HEADER_BYTES];
  (void)read_exact(3, header, sizeof(header));
}

static int child_reap_time(uint64_t *value) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
      now.tv_nsec < 0 || now.tv_nsec >= 1000000000L ||
      (uint64_t)now.tv_sec > (UINT64_MAX - 999u) / 1000u) return 0;
  *value = (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
  return 1;
}

static int wait_owned_root(pid_t *root, int *status) {
  uint64_t started, now, deadline;
  pid_t expected = *root;
  if (expected <= 0 || !child_reap_time(&started) ||
      started > UINT64_MAX - KRP_CHILD_REAP_TIMEOUT_MS) return 0;
  deadline = started + KRP_CHILD_REAP_TIMEOUT_MS;
  for (;;) {
    pid_t observed;
    int wait_error;
    if (!child_reap_time(&now) || now < started || now >= deadline) return 0;
    observed = waitpid(expected, status, WNOHANG);
    wait_error = errno;
    /* A consumed child must never be signalled by the caller's error cleanup. */
    if ((observed == expected && (WIFEXITED(*status) || WIFSIGNALED(*status))) ||
        (observed < 0 && wait_error != EINTR) ||
        (observed > 0 && observed != expected)) *root = -1;
    if (!child_reap_time(&now) || now < started || now >= deadline) return 0;
    if (observed == expected) return WIFEXITED(*status) || WIFSIGNALED(*status);
    if (observed != 0 && !(observed == -1 && wait_error == EINTR)) return 0;
    if (poll(NULL, 0, 1) < 0 && errno != EINTR) return 0;
  }
}

static int supervise(int monitor, const char *handle, pid_t *root) {
  struct pollfd descriptors[2] = {{3, POLLIN | POLLHUP, 0}, {monitor, POLLIN | POLLHUP, 0}};
  struct keiko_monitor_reply reply;
  int stopping = 0;
  for (;;) {
    int poll_result = poll(descriptors, 2, -1);
    if (poll_result < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (poll_result == 0) continue;
    if ((descriptors[0].revents & (POLLIN | POLLHUP)) != 0 && !stopping) {
      consume_control();
      stopping = 1;
      if (!monitor_request(monitor, KEIKO_MONITOR_STOP, handle)) return 0;
    }
    if ((descriptors[1].revents & (POLLIN | POLLHUP)) != 0) {
      if (!monitor_reply(monitor, &reply)) return 0;
      if (reply.kind == KEIKO_MONITOR_ROOT_OBSERVED) {
        if (!send_response(RESPONSE_LAUNCHED, NULL, 0)) return 0;
      } else if (reply.kind == KEIKO_MONITOR_ZERO_LIVE && reply.live_processes == 0) {
        int status = 0;
        unsigned char proof[8] = {0};
        if (!wait_owned_root(root, &status)) return 0;
        write_u32(proof, WIFEXITED(status) ? (uint32_t)WEXITSTATUS(status) : 137u);
        // KEIKO-0270: proof+4 is the containment count the harness asserts is zero. It was never
        // written here, so those four bytes stayed at their initialiser and the assertion could
        // not fail — it read a constant the producer hard-coded, not an observation. Carry the
        // monitor's own live_processes so the check becomes load-bearing.
        write_u32(proof + 4, reply.live_processes);
        return send_response(RESPONSE_REAPED, proof, sizeof(proof));
      } else {
        return 0;
      }
    }
  }
}

static int reconcile(const char *handle) {
  int monitor;
  struct keiko_monitor_reply reply;
  unsigned char proof[8] = {0};
  if (!valid_recovery_handle(handle)) {
    (void)send_error(ERROR_PROTOCOL);
    return 1;
  }
  monitor = monitor_connect();
  if (monitor == -1 || !monitor_request(monitor, KEIKO_MONITOR_RECONCILE, handle) ||
      !monitor_reply(monitor, &reply)) {
    if (monitor != -1) close(monitor);
    (void)send_error(ERROR_MONITOR_UNAVAILABLE);
    return 1;
  }
  close(monitor);
  // KEIKO-0433: an already-supervised tree now answers KEIKO_MONITOR_ALREADY_ACTIVE instead of
  // borrowing ZERO_LIVE. Without this branch the new code would fall into the generic
  // ERROR_TREE_OBSERVE below and be exactly as opaque as the collapse it was added to fix.
  // "Someone else already owns this tree" is not an observation failure — it is a live monitor,
  // and the caller must not go on to report the tree reaped.
  if (reply.kind == KEIKO_MONITOR_ALREADY_ACTIVE) {
    (void)send_error(ERROR_TREE_ALREADY_SUPERVISED);
    return 1;
  }
  if (reply.kind != KEIKO_MONITOR_ZERO_LIVE || reply.live_processes != 0) {
    (void)send_error(ERROR_TREE_OBSERVE);
    return 1;
  }
  return send_response(RESPONSE_REAPED, proof, sizeof(proof)) ? 0 : 1;
}

static int probe_monitor(void) {
  int monitor = monitor_connect();
  struct keiko_monitor_reply reply;
  struct timeval timeout = {.tv_sec = 1, .tv_usec = 0};
  int available = 0;
  if (monitor != -1 &&
      setsockopt(monitor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
      setsockopt(monitor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0 &&
      monitor_request(monitor, KEIKO_MONITOR_PING, NULL) &&
      monitor_reply(monitor, &reply) && reply.kind == KEIKO_MONITOR_ACTIVE) {
    available = 1;
  }
  if (monitor != -1) close(monitor);
  return available ? 0 : ERROR_MONITOR_UNAVAILABLE;
}

#include "keiko_app_runtime.h"

int main(int argc, char **argv) {
  struct launch_request request = {0};
  struct keiko_monitor_reply reply;
  int monitor = -1;
  pid_t root = -1;
  int result = 1;
  if (argc == 2 && strcmp(argv[1], "--probe-app-runtime") == 0) return keiko_app_probe();
  if (argc == 2 && strcmp(argv[1], "--app-runtime") == 0) return keiko_app_runtime(0);
  if (argc == 2 && strcmp(argv[1], "--app-owner-report") == 0) return keiko_app_runtime(1);
  if (argc == 2 && strcmp(argv[1], "--probe-monitor") == 0) return probe_monitor();
  if (argc == 3 && strcmp(argv[1], "--reconcile") == 0) return reconcile(argv[2]);
  if (argc != 1 || !read_launch_request(&request)) {
    (void)send_error(ERROR_PROTOCOL);
    clear_request(&request);
    return 1;
  }
  monitor = monitor_connect();
  if (monitor == -1 || !monitor_request(monitor, KEIKO_MONITOR_ARM, request.recovery_handle) ||
      !monitor_reply(monitor, &reply) || reply.kind != KEIKO_MONITOR_ARMED) {
    (void)send_error(ERROR_MONITOR_UNAVAILABLE);
    goto cleanup;
  }
  if (!spawn_runtime(&request, &root)) {
    (void)monitor_request(monitor, KEIKO_MONITOR_STOP, request.recovery_handle);
    (void)send_error(ERROR_PROCESS_CREATE);
    goto cleanup;
  }
  result = supervise(monitor, request.recovery_handle, &root) ? 0 : 1;
  if (result != 0) {
    int status;
    (void)monitor_request(monitor, KEIKO_MONITOR_STOP, request.recovery_handle);
    if (root > 0) {
      (void)kill(root, SIGKILL);
      (void)wait_owned_root(&root, &status);
    }
    (void)send_error(ERROR_TREE_OBSERVE);
  }
cleanup:
  if (monitor != -1) close(monitor);
  clear_request(&request);
  return result;
}
