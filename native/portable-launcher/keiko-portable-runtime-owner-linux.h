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
  int scope;
  int scope_bound;
  int app_control;
  const struct app_environment_packet *application_environment;
  struct keiko_app_handoff *handoff;
  unsigned char app_pending[212];
  size_t app_pending_bytes;
  uint64_t app_pending_deadline;
  int controller;
  int state;
  int receipts;
  int persistent;
  int committed;
  uint64_t started_at;
  uint64_t commit_deadline;
  const char *state_path;
  const char *launch_id;
  struct stat receipt_identity;
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
  return keiko_coordinator_write_deadline(descriptor, content, size, deadline);
}

#include "keiko-portable-process-scope-linux.h"

static int keiko_owner_packet_reader(int descriptor, void *bytes, size_t length, void *context) {
  const uint64_t *deadline = (const uint64_t *)context;
  return keiko_coordinator_read_exact_deadline(descriptor, bytes, length, *deadline);
}

static int keiko_owner_child(const char *helper, int executable, const int control[2],
                              const int response[2], int identity, int start_gate, int owner_handle,
                              int scope, int app_control, uint64_t deadline) {
  char deadline_value[64];
  if (snprintf(deadline_value, sizeof(deadline_value), "KEIKO_UI_START_DEADLINE_MS=%llu",
               (unsigned long long)deadline) <= 0) return 0;
  char *const app_environment[] = {deadline_value, NULL};
  char *const arguments[] = {(char *)helper,
    scope < 0 ? (char *)"--owner-report" : app_control < 0 ? (char *)"--app-owner-report"
                                                       : (char *)"--managed-app-owner-report", NULL};
  char *const environment[] = {NULL};
  if (!keiko_bind_parent_death(owner_handle)) return 0;
  close(owner_handle);
  if (start_gate < 0) close(5);
  else if (fcntl(5, F_SETFD, 0) != 0) return 0;
  unsigned int first_closed = app_control >= 0 ? 9u : scope < 0 ? 7u : 8u;
  if (dup2(control[0], 3) < 0 || dup2(response[1], 4) < 0 || dup2(identity, 6) < 0 ||
      (scope >= 0 && dup2(scope, 7) < 0) ||
      (app_control >= 0 && dup2(app_control, 8) < 0) ||
      ((unsigned int)executable > first_closed &&
       syscall(SYS_close_range, first_closed, (unsigned int)executable - 1u, 0u) != 0) ||
      syscall(SYS_close_range, (unsigned int)executable + 1u, UINT_MAX, 0u) != 0)
    return 0;
  fexecve(executable, arguments, scope < 0 ? environment : app_environment);
  return 0;
}

static int keiko_owner_spawn(keiko_runtime_owner *owner, const char *helper,
                              const char *expected, uint64_t deadline, int app) {
  int control[2] = {-1, -1}, response[2] = {-1, -1}, identity[2] = {-1, -1};
  int scope[2] = {-1, -1};
  int app_control[2] = {-1, -1};
  char canonical[PATH_MAX], digest[65];
  int executable = -1, result = 0, enabled = 1, owner_handle = -1;
  int start_gate = fcntl(5, F_GETFD) < 0 ? -1 : 5;
  if (!keiko_khp_is_lower_hex(expected, 64u) || realpath(helper, canonical) == NULL ||
      strcmp(helper, canonical) != 0 ||
      (executable = keiko_coordinator_open_hashed_file(helper, deadline, digest)) < 0 ||
      strcmp(digest, expected) != 0 || !keiko_owner_private_pipe(control) ||
      !keiko_owner_private_pipe(response) ||
      socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, identity) != 0 ||
      setsockopt(identity[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) != 0 ||
      (app && !keiko_scope_socket(scope)) ||
      (owner->persistent && !keiko_owner_socket(app_control, SOCK_STREAM)))
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
    _exit(keiko_owner_child(helper, executable, control, response, identity[1], start_gate,
                            owner_handle, scope[1], app_control[1], deadline) ? 0 : 126);
  owner->control = control[1]; control[1] = -1;
  owner->response = response[0]; response[0] = -1;
  owner->identity = identity[0]; identity[0] = -1;
  owner->scope = scope[0]; scope[0] = -1;
  owner->app_control = app_control[0]; app_control[0] = -1;
  result = keiko_tree_before_deadline(deadline);
cleanup:
  keiko_owner_close(&owner_handle);
  if (executable >= 0) close(executable);
  for (size_t i = 0; i < 2; ++i) {
    keiko_owner_close(&control[i]); keiko_owner_close(&response[i]); keiko_owner_close(&identity[i]);
    keiko_owner_close(&scope[i]);
    keiko_owner_close(&app_control[i]);
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

#include "keiko-portable-app-owner-linux.h"

static int keiko_app_control_hello(keiko_runtime_owner *owner, uint64_t deadline) {
  if (!owner->persistent) return 1;
  unsigned char bytes[52] = {'K','H','U','1',1,0,1,0,40,0,0,0};
  write_u32(bytes + 12, (uint32_t)owner->root);
  write_u32(bytes + 16, (uint32_t)getpid());
  memcpy(bytes + 20, owner->launch_id, 32);
  return keiko_owner_write(owner->app_control, bytes, sizeof(bytes), deadline);
}

#include "keiko-portable-app-handoff-linux.h"

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
    keiko_app_handoff *handoff = owner->handoff;
    uint64_t now = keiko_tree_now_ms();
    if (!keiko_handoff_expired(owner, now)) return 0;
    if (stopping && (now >= stop_deadline || stop_deadline - now > INT_MAX)) return 0;
    if (!stopping && owner->persistent && !owner->committed && now >= owner->commit_deadline) {
      keiko_owner_close(&owner->control);
      stopping = 1; stop_deadline = now + KEIKO_OWNER_BOUND_MS;
    }
    uint64_t bound = stopping ? stop_deadline : owner->commit_deadline;
    int bounded = stopping || (owner->persistent && !owner->committed);
    keiko_handoff_bound(owner, &bound, &bounded);
    int timeout = !bounded ? -1 : bound - now > INT_MAX ? INT_MAX : (int)(bound - now);
    struct pollfd items[6] = {{stopping || (handoff != NULL && handoff->old_reaped) ? -1 : owner->controller, POLLIN | POLLHUP, 0},
                              {owner->response, POLLIN | POLLHUP, 0},
                              {owner->scope, POLLIN | POLLHUP, 0},
                              {owner->app_control, POLLIN | POLLHUP, 0},
                              {handoff == NULL ? -1 : handoff->response, POLLIN | POLLHUP, 0},
                              {handoff == NULL ? -1 : handoff->child_handle, POLLIN, 0}};
    int ready = poll(items, 6, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready == 0 && !stopping) continue;
    if (ready <= 0 || (stopping && !keiko_tree_before_deadline(stop_deadline))) return 0;
    uint64_t deadline = stopping ? stop_deadline : keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
    if (!stopping && owner->persistent && !owner->committed && owner->commit_deadline < deadline)
      deadline = owner->commit_deadline;
    if (items[0].revents != 0) {
      ssize_t count = read(owner->controller, header, sizeof(header));
      if (count == 0 && owner->committed) {
        keiko_owner_close(&owner->controller);
        close(4);
      } else if (count == 0) {
        keiko_owner_close(&owner->control);
        stopping = 1; stop_deadline = deadline;
      }
      else if (count < 0 || (count < 12 && !keiko_coordinator_read_exact_deadline(
                   owner->controller, header + count, 12u - (size_t)count, deadline)) ||
               memcmp(header, "KRC1", 4) != 0 || read_u16(header + 4) != 1) return 0;
      else if (owner->persistent && read_u16(header + 6) == 4) {
        if (!keiko_app_owner_commit(owner, header, deadline)) return 0;
      } else {
        if ((read_u16(header + 6) != 2 && read_u16(header + 6) != 3) ||
            read_u32(header + 8) != 0 ||
            !keiko_owner_write(owner->control, header, sizeof(header), deadline)) return 0;
        stopping = 1; stop_deadline = deadline;
      }
      if (stopping) keiko_owner_close(&owner->scope);
    }
    if (owner->scope >= 0 && items[2].revents != 0 && !keiko_scope_serve(owner, deadline))
      keiko_owner_close(&owner->scope);
    if (owner->app_control >= 0 && items[3].revents != 0 && !keiko_handoff_receive(owner) &&
        !keiko_handoff_close_app(owner)) return 0;
    if (owner->handoff != NULL && owner->handoff->response >= 0 && items[4].revents != 0 &&
        !keiko_handoff_acceptance(owner)) {
      if (!keiko_handoff_stop(owner, deadline) ||
          (owner->app_control >= 0 && !keiko_handoff_reply(owner, 10, 2, deadline))) return 0;
    }
    if (owner->handoff != NULL && owner->handoff->child_handle >= 0 && items[5].revents != 0) {
      int completed = keiko_handoff_child_exited(owner, deadline);
      if (completed == 0) return 0;
      if (completed == 2)
        return keiko_app_owner_record(owner, "reaped", 0, deadline);
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
    int transferred = keiko_handoff_old_reaped(owner, deadline);
    if (transferred == 0) return 0;
    if (transferred == 2) continue;
    if (owner->persistent && !keiko_app_owner_record(owner, "reaped", 0, deadline)) return 0;
    if (!owner->committed) return send_response(RESPONSE_REAPED, payload, 8);
    if (owner->controller >= 0) (void)send_response(RESPONSE_REAPED, payload, 8);
    return 1;
  }
}

static int keiko_runtime_owner_linux(const char *helper, const char *expected, int app) {
  keiko_runtime_owner owner = {.supervisor = -1, .root = -1, .control = -1,
                                .response = -1, .identity = -1, .root_handle = -1, .scope = -1,
                                .controller = 3, .state = -1, .receipts = -1, .app_control = -1};
  struct launch_request request = {0};
  struct app_environment_packet environment = {0};
  unsigned char header[12] = {'K','R','P','1',1,0,1,0,0,0,0,0}, payload[64];
  owner.started_at = keiko_tree_now_ms();
  uint64_t deadline = owner.started_at + KEIKO_OWNER_BOUND_MS;
  int result = 1, error = 1;
  int had_start_gate = fcntl(5, F_GETFD) >= 0;
  (void)signal(SIGPIPE, SIG_IGN);
  if (owner.started_at == 0 || owner.started_at > UINT64_MAX - KEIKO_OWNER_BOUND_MS ||
      (app && !keiko_app_owner_initial_deadline(&deadline)) ||
      !read_launch_request_with_reader(&request, keiko_owner_packet_reader, &deadline)) goto cleanup;
  if (app && !keiko_app_owner_prepare(&owner, &request)) goto cleanup;
  if (owner.persistent && owner.commit_deadline < deadline) deadline = owner.commit_deadline;
  if (app && !read_app_environment(&environment, keiko_owner_packet_reader, &deadline)) goto cleanup;
  if (app) owner.application_environment = &environment;
  error = 3;
  if (!keiko_owner_spawn(&owner, helper, expected, deadline, app)) goto cleanup;
  error = 5;
  write_u32(header + 8, (uint32_t)(request.storage_length - 1u));
  if (!keiko_owner_write(owner.control, header, sizeof(header), deadline) ||
      !keiko_owner_write(owner.control, request.storage, request.storage_length - 1u, deadline))
    goto cleanup;
  if (app) {
    memcpy(header, "KAE1", 4);
    write_u32(header + 8, (uint32_t)(environment.storage_length - 1u));
    if (!keiko_owner_write(owner.control, header, sizeof(header), deadline) ||
        !keiko_owner_write(owner.control, environment.storage, environment.storage_length - 1u,
                           deadline)) goto cleanup;
  }
  if (!keiko_owner_capture(&owner, deadline)) {
    error = keiko_owner_start_failure(&owner, deadline);
    goto cleanup;
  }
  if (!keiko_owner_response(&owner, header, payload, deadline) ||
      read_u16(header + 6) != RESPONSE_LAUNCHED || read_u32(header + 8) != 0 ||
      (app && !keiko_scope_send(owner.scope, 1, (uint32_t)owner.root, (uint32_t)getpid(), deadline)) ||
      !keiko_app_control_hello(&owner, deadline) ||
      !keiko_app_owner_started(&owner, deadline)) goto cleanup;
  keiko_owner_close(&owner.identity);
  if (had_start_gate) close(5);
  result = keiko_owner_wait(&owner) ? 0 : 1;
cleanup:
  if (app && owner.supervisor < 0 && owner.root_handle < 0)
    keiko_app_owner_record_unstarted();
  int handoff_clean = keiko_handoff_cleanup(&owner);
  if (result != 0 && handoff_clean && owner.persistent && owner.root_handle >= 0 && owner.supervisor > 0)
    keiko_app_owner_cancel(&owner);
  keiko_owner_close(&owner.control); keiko_owner_close(&owner.response);
  keiko_owner_close(&owner.identity); keiko_owner_close(&owner.root_handle);
  keiko_owner_close(&owner.scope);
  keiko_owner_close(&owner.app_control);
  keiko_coordinator_dispose_child(&owner.supervisor);
  keiko_owner_close(&owner.state); keiko_owner_close(&owner.receipts);
  clear_request(&request);
  clear_app_environment(&environment);
  if (result != 0) (void)send_error((uint16_t)error);
  return result;
}

#endif
