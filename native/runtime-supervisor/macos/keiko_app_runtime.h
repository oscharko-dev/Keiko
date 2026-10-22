#ifndef KEIKO_MACOS_APP_RUNTIME_H
#define KEIKO_MACOS_APP_RUNTIME_H

#include "keiko_runtime_process_scope.h"

/* The updater owns a trusted application generation separately from the optional Coding
 * sandbox's Endpoint Security backend. Its inherited private pipes carry lifecycle control. */
static int keiko_app_overridden(const char *entry, const struct launch_request *request) {
  for (uint16_t index = 0; index < request->environment_count; ++index) {
    size_t length = strlen(request->environment_names[index]);
    if (strncmp(entry, request->environment_names[index], length) == 0 && entry[length] == '=')
      return 1;
  }
  return 0;
}

static int keiko_app_spawn(const struct launch_request *request,
                            const struct app_environment_packet *packet, pid_t *root) {
  size_t count = 0;
  char **explicit_values = spawn_environment(request);
  char **values = calloc((size_t)packet->count + request->environment_count + 1u, sizeof(char *));
  int result = 0;
  if (values == NULL || explicit_values == NULL) goto cleanup;
  for (uint16_t index = 0; index < packet->count; ++index) {
    if (!keiko_app_overridden(packet->values[index], request)) values[count++] = packet->values[index];
  }
  for (uint16_t index = 0; index < request->environment_count; ++index)
    values[count++] = explicit_values[index];
  result = spawn_runtime_environment(request, root, values, POSIX_SPAWN_START_SUSPENDED);
cleanup:
  free(values);
  clear_environment(explicit_values, request->environment_count);
  return result;
}

static int keiko_app_root_reaped(pid_t *root, unsigned int *exit_code) {
  int status;
  pid_t result;
  if (*root < 0) return 1;
  result = waitpid(*root, &status, WNOHANG);
  if (result == 0 || (result < 0 && errno == EINTR)) return 0;
  if (result != *root || !(WIFEXITED(status) || WIFSIGNALED(status))) return -1;
  *root = -1;
  *exit_code = WIFEXITED(status) ? (unsigned int)WEXITSTATUS(status) : 137u;
  return 1;
}

static int keiko_app_stop(keiko_macos_process_scope *scope, pid_t *root,
                           unsigned int *exit_code) {
  uint64_t now, deadline;
  unsigned int owned, unknown;
  if (!child_reap_time(&now) || now > UINT64_MAX - KRP_CHILD_REAP_TIMEOUT_MS) return 0;
  deadline = now + KRP_CHILD_REAP_TIMEOUT_MS;
  while (child_reap_time(&now) && now < deadline) {
    if (!keiko_macos_scope_signal(scope, SIGSTOP) ||
        !keiko_macos_scope_signal(scope, SIGKILL) ||
        keiko_app_root_reaped(root, exit_code) < 0 || !keiko_macos_scope_scan(scope, 0)) return 0;
    if (*root < 0 && keiko_macos_scope_live(scope, &owned, &unknown) && owned == 0 && unknown == 0)
      return 1;
    if (poll(NULL, 0, 1) < 0 && errno != EINTR) return 0;
  }
  return 0;
}

static int keiko_app_control_stop(void) {
  unsigned char header[12];
  size_t offset = 0;
  uint64_t now, deadline;
  if (!child_reap_time(&now) || now > UINT64_MAX - KRP_CHILD_REAP_TIMEOUT_MS) return 0;
  deadline = now + KRP_CHILD_REAP_TIMEOUT_MS;
  while (offset < sizeof(header)) {
    struct pollfd control = {3, POLLIN | POLLHUP, 0};
    if (!child_reap_time(&now) || now >= deadline) return 0;
    int ready = poll(&control, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (control.revents & (POLLERR | POLLNVAL)) != 0) return 0;
    ssize_t count = read(3, header + offset, sizeof(header) - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) return offset == 0;
    if (count < 0) return 0;
    offset += (size_t)count;
  }
  return memcmp(header, "KRC1", 4) == 0 && read_u16(header + 4) == 1 &&
         (read_u16(header + 6) == 2 || read_u16(header + 6) == 3) &&
         read_u32(header + 8) == 0;
}

static int keiko_app_supervise(keiko_macos_process_scope *scope, pid_t *root) {
  unsigned int exit_code = 0;
  for (;;) {
    struct pollfd controls[2] = {{3, POLLIN | POLLHUP, 0}, {9, POLLIN | POLLHUP, 0}};
    int ready = poll(controls, 2, 50);
    int reaped;
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || (controls[0].revents & (POLLERR | POLLNVAL)) != 0) return 0;
    reaped = keiko_app_root_reaped(root, &exit_code);
    if (reaped < 0) return 0;
    int bridge_lost = controls[1].revents != 0;
    if (reaped || bridge_lost || (ready > 0 && (controls[0].revents & (POLLIN | POLLHUP)) != 0)) {
      unsigned char proof[8] = {0};
      if ((!reaped && !bridge_lost && !keiko_app_control_stop()) ||
          !keiko_app_stop(scope, root, &exit_code)) return 0;
      write_u32(proof, exit_code);
      /* Zero is published only after a complete scan proves no owned or unclassified process. */
      return send_response(RESPONSE_REAPED, proof, sizeof(proof));
    }
  }
}

static int keiko_app_report(pid_t root) {
  unsigned char bytes[20] = {'K','R','I','1',1,0,1,0,8,0,0,0};
  write_u32(bytes + 12, (uint32_t)root);
  write_u32(bytes + 16, (uint32_t)getpid());
  int result = write_exact(6, bytes, sizeof(bytes));
  close(6);
  return result;
}

static int keiko_app_runtime(int owner_report) {
  struct launch_request request = {0};
  struct app_environment_packet environment = {0};
  keiko_macos_process_scope scope = {0};
  pid_t root = -1;
  unsigned int exit_code = 0;
  int result = 0;
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR || !read_launch_request(&request) ||
      !read_app_environment(&environment, krp_default_reader, NULL) ||
      !keiko_macos_scope_init(&scope) || !keiko_app_spawn(&request, &environment, &root) ||
      !keiko_macos_scope_admit_root(&scope, root) ||
      !keiko_macos_scope_signal(&scope, SIGCONT) ||
      (owner_report && !keiko_app_report(root)) ||
      !send_response(RESPONSE_LAUNCHED, NULL, 0)) goto cleanup;
  if (owner_report) close(8);
  clear_app_environment(&environment);
  clear_request(&request);
  result = keiko_app_supervise(&scope, &root);
cleanup:
  if (!result) {
    if (root > 0) {
      if (scope.root_unique_id != 0) (void)keiko_app_stop(&scope, &root, &exit_code);
      else {
        /* Admission failed while our direct child was still suspended. */
        (void)kill(root, SIGKILL);
        int status;
        (void)wait_owned_root(&root, &status);
      }
    }
    (void)send_error(ERROR_TREE_OBSERVE);
  }
  clear_app_environment(&environment);
  clear_request(&request);
  keiko_macos_scope_destroy(&scope);
  return result ? 0 : 1;
}

#endif
