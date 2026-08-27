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
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define KRP_VERSION 1u
#define KRP_HEADER_BYTES 12u
#define KRP_MAX_PACKET (128u * 1024u)
#define KRP_MAX_ARGUMENTS 64u
#define KRP_MAX_ENVIRONMENT 64u

enum response_kind { RESPONSE_LAUNCHED = 1, RESPONSE_REAPED = 2, RESPONSE_ERROR = 3 };
enum error_code {
  ERROR_PROTOCOL = 1,
  ERROR_MONITOR_UNAVAILABLE = 6,
  ERROR_PROCESS_CREATE = 3,
  ERROR_TREE_OBSERVE = 5,
  // KEIKO-0433: reconcile found the handle, but a live connection already owns that session.
  // Distinct from ERROR_TREE_OBSERVE (could not observe) and from the reaped success path.
  ERROR_TREE_ALREADY_SUPERVISED = 7
};

struct launch_request {
  char *storage;
  size_t storage_length;
  char *recovery_handle;
  char *executable;
  char *cwd;
  uint16_t argument_count;
  uint16_t environment_count;
  char **arguments;
  char **environment_names;
  char **environment_values;
};

_Static_assert(sizeof(struct keiko_monitor_request) == 44, "monitor request layout");
_Static_assert(sizeof(struct keiko_monitor_reply) == 12, "monitor reply layout");

static uint16_t read_u16(const unsigned char *value) {
  return (uint16_t)value[0] | ((uint16_t)value[1] << 8);
}

static uint32_t read_u32(const unsigned char *value) {
  return (uint32_t)value[0] | ((uint32_t)value[1] << 8) |
         ((uint32_t)value[2] << 16) | ((uint32_t)value[3] << 24);
}

static void write_u16(unsigned char *value, uint16_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
}

static void write_u32(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static int send_response(uint16_t kind, const unsigned char *payload, uint32_t length) {
  unsigned char header[KRP_HEADER_BYTES] = {'K', 'R', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0};
  write_u16(header + 4, KRP_VERSION);
  write_u16(header + 6, kind);
  write_u32(header + 8, length);
  return write_exact(4, header, sizeof(header)) &&
         (length == 0 || write_exact(4, payload, length));
}

static int send_error(enum error_code code) {
  unsigned char payload[2];
  write_u16(payload, (uint16_t)code);
  return send_response(RESPONSE_ERROR, payload, sizeof(payload));
}

static int valid_recovery_handle(const char *value) {
  size_t index;
  if (strlen(value) != KEIKO_RECOVERY_HANDLE_BYTES) return 0;
  for (index = 0; index < KEIKO_RECOVERY_HANDLE_BYTES; ++index) {
    char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return 0;
  }
  return 1;
}

static char *take_string(unsigned char **cursor, size_t *remaining) {
  uint32_t length;
  char *value;
  if (*remaining < 4) return NULL;
  length = read_u32(*cursor);
  *cursor += 4;
  *remaining -= 4;
  if (length >= *remaining || memchr(*cursor, 0, length) != NULL || (*cursor)[length] != 0)
    return NULL;
  value = (char *)*cursor;
  *cursor += (size_t)length + 1;
  *remaining -= (size_t)length + 1;
  return value;
}

static int read_launch_request(struct launch_request *request) {
  unsigned char header[KRP_HEADER_BYTES], *cursor;
  uint32_t payload_length;
  size_t remaining, index;
  memset(request, 0, sizeof(*request));
  if (!read_exact(3, header, sizeof(header)) || memcmp(header, "KRP1", 4) != 0 ||
      read_u16(header + 4) != KRP_VERSION || read_u16(header + 6) != 1)
    return 0;
  payload_length = read_u32(header + 8);
  if (payload_length < 16 || payload_length > KRP_MAX_PACKET - KRP_HEADER_BYTES) return 0;
  request->storage = calloc((size_t)payload_length + 1, 1);
  if (request->storage == NULL || !read_exact(3, request->storage, payload_length)) return 0;
  request->storage_length = (size_t)payload_length + 1;
  cursor = (unsigned char *)request->storage;
  remaining = payload_length;
  request->argument_count = read_u16(cursor);
  request->environment_count = read_u16(cursor + 2);
  cursor += 4;
  remaining -= 4;
  if (request->argument_count > KRP_MAX_ARGUMENTS ||
      request->environment_count > KRP_MAX_ENVIRONMENT)
    return 0;
  request->arguments = calloc((size_t)request->argument_count + 1, sizeof(char *));
  request->environment_names = calloc((size_t)request->environment_count + 1, sizeof(char *));
  request->environment_values = calloc((size_t)request->environment_count + 1, sizeof(char *));
  if (request->arguments == NULL || request->environment_names == NULL ||
      request->environment_values == NULL)
    return 0;
  request->recovery_handle = take_string(&cursor, &remaining);
  request->executable = take_string(&cursor, &remaining);
  request->cwd = take_string(&cursor, &remaining);
  for (index = 0; index < request->argument_count; ++index)
    request->arguments[index] = take_string(&cursor, &remaining);
  for (index = 0; index < request->environment_count; ++index) {
    request->environment_names[index] = take_string(&cursor, &remaining);
    request->environment_values[index] = take_string(&cursor, &remaining);
  }
  if (remaining != 0 || request->recovery_handle == NULL || request->executable == NULL ||
      request->cwd == NULL || !valid_recovery_handle(request->recovery_handle))
    return 0;
  for (index = 0; index < request->argument_count; ++index)
    if (request->arguments[index] == NULL) return 0;
  for (index = 0; index < request->environment_count; ++index)
    if (request->environment_names[index] == NULL || request->environment_values[index] == NULL ||
        strchr(request->environment_names[index], '=') != NULL)
      return 0;
  return 1;
}

static void clear_request(struct launch_request *request) {
  if (request->storage != NULL) {
    memset(request->storage, 0, request->storage_length);
    free(request->storage);
  }
  free(request->arguments);
  free(request->environment_names);
  free(request->environment_values);
  memset(request, 0, sizeof(*request));
}

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

static char **spawn_arguments(const struct launch_request *request) {
  size_t index;
  char **values = calloc((size_t)request->argument_count + 2, sizeof(char *));
  if (values == NULL) return NULL;
  values[0] = request->executable;
  for (index = 0; index < request->argument_count; ++index) values[index + 1] = request->arguments[index];
  return values;
}

static void clear_environment(char **values, uint16_t count);

static char **spawn_environment(const struct launch_request *request) {
  size_t index;
  char **values = calloc((size_t)request->environment_count + 1, sizeof(char *));
  if (values == NULL) return NULL;
  for (index = 0; index < request->environment_count; ++index) {
    size_t name = strlen(request->environment_names[index]);
    size_t value = strlen(request->environment_values[index]);
    values[index] = calloc(name + value + 2, 1);
    if (values[index] == NULL) {
      clear_environment(values, (uint16_t)index);
      return NULL;
    }
    memcpy(values[index], request->environment_names[index], name);
    values[index][name] = '=';
    memcpy(values[index] + name + 1, request->environment_values[index], value);
  }
  return values;
}

static void clear_environment(char **values, uint16_t count) {
  size_t index;
  if (values == NULL) return;
  for (index = 0; index < count; ++index) {
    if (values[index] != NULL) {
      memset(values[index], 0, strlen(values[index]));
      free(values[index]);
    }
  }
  free(values);
}

static int spawn_runtime(const struct launch_request *request, pid_t *pid) {
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  char **arguments = spawn_arguments(request);
  char **environment = spawn_environment(request);
  int result = EINVAL;
  if (arguments == NULL || environment == NULL) goto cleanup;
  if (chdir(request->cwd) != 0) goto cleanup;
  if (posix_spawn_file_actions_init(&actions) != 0) goto cleanup;
  if (posix_spawnattr_init(&attributes) != 0) {
    posix_spawn_file_actions_destroy(&actions);
    goto cleanup;
  }
  (void)posix_spawn_file_actions_addclose(&actions, 3);
  (void)posix_spawn_file_actions_addclose(&actions, 4);
  result = posix_spawn(
      pid, request->executable, &actions, &attributes, arguments, environment);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
cleanup:
  free(arguments);
  clear_environment(environment, request->environment_count);
  return result == 0;
}

static void consume_control(void) {
  unsigned char header[KRP_HEADER_BYTES];
  (void)read_exact(3, header, sizeof(header));
}

static int supervise(int monitor, const char *handle, pid_t root) {
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
        (void)waitpid(root, &status, 0);
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

int main(int argc, char **argv) {
  struct launch_request request = {0};
  struct keiko_monitor_reply reply;
  int monitor = -1;
  pid_t root = -1;
  int result = 1;
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
  result = supervise(monitor, request.recovery_handle, root) ? 0 : 1;
  if (result != 0) {
    (void)monitor_request(monitor, KEIKO_MONITOR_STOP, request.recovery_handle);
    (void)kill(root, SIGKILL);
    (void)waitpid(root, NULL, 0);
    (void)send_error(ERROR_TREE_OBSERVE);
  }
cleanup:
  if (monitor != -1) close(monitor);
  clear_request(&request);
  return result;
}
