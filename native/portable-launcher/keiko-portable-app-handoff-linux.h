#ifndef KEIKO_PORTABLE_APP_HANDOFF_LINUX_H
#define KEIKO_PORTABLE_APP_HANDOFF_LINUX_H

#if defined(__linux__)
#include <linux/memfd.h>
#endif

/* One selected activation, dispatched by the held main app root to its existing outer owner. */
typedef struct keiko_app_handoff {
  pid_t child;
  int child_handle;
  int control;
  int response;
  int proof;
  int authorized;
  int prepared;
  int accepted;
  int old_reaped;
  int resolved;
  int status;
  char activation[33];
  char plan[65];
  char coordinator[65];
  uint64_t deadline;
  uint64_t cleanup_deadline;
  unsigned char acceptance[78];
  size_t acceptance_bytes;
} keiko_app_handoff;

#if defined(__linux__)
static int keiko_handoff_environment(const keiko_runtime_owner *owner, uint64_t deadline) {
  const struct app_environment_packet *environment = owner->application_environment;
  unsigned char header[12] = {'K','A','E','1',1,0,1,0,0,0,0,0};
  int descriptor = (int)syscall(SYS_memfd_create, "keiko-app-data", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (descriptor < 0) return -1;
  int selected = fcntl(descriptor, F_DUPFD_CLOEXEC, 16);
  close(descriptor); descriptor = selected;
  if (descriptor < 0) return -1;
  if (fchmod(descriptor, 0600) != 0 || environment == NULL || environment->storage_length < 5u ||
      environment->storage_length - 1u > KRP_MAX_PACKET - sizeof(header)) goto refused;
  write_u32(header + 8, (uint32_t)(environment->storage_length - 1u));
  if (!keiko_owner_write(descriptor, header, sizeof(header), deadline) ||
      !keiko_owner_write(descriptor, environment->storage, environment->storage_length - 1u, deadline) ||
      fcntl(descriptor, F_ADD_SEALS, F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE) != 0 ||
      lseek(descriptor, 0, SEEK_SET) != 0) goto refused;
  return descriptor;
refused:
  close(descriptor);
  return -1;
}

#endif

static int keiko_handoff_capsule(const keiko_runtime_owner *owner, const char *activation) {
  const char *names[] = {"updates", "handoff", activation};
  int descriptor = fcntl(owner->state, F_DUPFD_CLOEXEC, 16);
  struct stat status;
  for (size_t i = 0; i < 3 && descriptor >= 0; ++i) {
    int next = openat(descriptor, names[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(descriptor); descriptor = next;
    if (descriptor >= 0 && (fstat(descriptor, &status) != 0 || !S_ISDIR(status.st_mode) ||
        status.st_uid != geteuid() || (status.st_mode & (S_IWGRP | S_IWOTH)) != 0)) {
      close(descriptor); descriptor = -1;
    }
  }
  return descriptor;
}

#if defined(__linux__)
static int keiko_handoff_executable(const keiko_runtime_owner *owner,
                                     const keiko_app_handoff *handoff, char path[PATH_MAX]) {
  char self_path[PATH_MAX], self_digest[65], copy_digest[65];
  int self = open("/proc/self/exe", O_RDONLY | O_CLOEXEC), checked = -1, executable = -1;
  int capsule = -1, named = -1, result = -1;
  struct stat loaded, source, before, after;
  ssize_t count = readlink("/proc/self/exe", self_path, sizeof(self_path) - 1u);
  if (self < 0 || count <= 0 || (size_t)count >= sizeof(self_path) - 1u) goto cleanup;
  self_path[count] = '\0';
  if (!keiko_app_owner_state_named(owner) ||
      (capsule = keiko_handoff_capsule(owner, handoff->activation)) < 0 ||
      snprintf(path, PATH_MAX, "%s/updates/handoff/%s/coordinator", owner->state_path,
               handoff->activation) <= 0 || strlen(path) >= PATH_MAX - 1u ||
      (checked = keiko_coordinator_open_hashed_file(self_path, handoff->deadline, self_digest)) < 0 ||
      fstat(self, &loaded) != 0 || fstat(checked, &source) != 0 ||
      !keiko_coordinator_same_file(&loaded, &source) ||
      (executable = keiko_coordinator_open_hashed_file(path, handoff->deadline, copy_digest)) < 0 ||
      strcmp(self_digest, copy_digest) != 0 || strcmp(copy_digest, handoff->coordinator) != 0 ||
      fstat(executable, &source) != 0 || source.st_uid != geteuid() ||
      (source.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      (named = keiko_handoff_capsule(owner, handoff->activation)) < 0 ||
      fstat(capsule, &before) != 0 || fstat(named, &after) != 0 ||
      !keiko_coordinator_same_directory(&before, &after) || !keiko_app_owner_state_named(owner) ||
      !keiko_tree_before_deadline(handoff->deadline)) goto cleanup;
  result = executable; executable = -1;
cleanup:
  if (self >= 0) close(self);
  if (checked >= 0) close(checked);
  if (executable >= 0) close(executable);
  if (capsule >= 0) close(capsule);
  if (named >= 0) close(named);
  return result;
}

static void keiko_handoff_child(const keiko_runtime_owner *owner, keiko_app_handoff *handoff,
                                 int input, int response, int proof, int parent, int app_data) {
  char path[PATH_MAX], state[PATH_MAX + 32], deadline[80];
  int executable = -1;
  if (!keiko_bind_parent_death(parent)) _exit(126);
  close(parent);
  executable = keiko_handoff_executable(owner, handoff, path);
  if (executable >= 0) {
    int reserved = fcntl(executable, F_DUPFD_CLOEXEC, 16);
    close(executable); executable = reserved;
  }
  if (executable < 0 || dup2(input, 0) < 0 || dup2(response, 3) < 0 ||
      dup2(owner->root_handle, 6) < 0 || dup2(proof, 7) < 0 ||
      fcntl(6, F_SETFD, 0) != 0 ||
      dup2(app_data, 9) < 0 || fcntl(9, F_SETFD, 0) != 0 ||
      syscall(SYS_close_range, 4u, 5u, 0u) != 0 ||
      syscall(SYS_close_range, 8u, 8u, 0u) != 0 ||
      ((unsigned int)executable > 10u &&
       syscall(SYS_close_range, 10u, (unsigned int)executable - 1u, 0u) != 0) ||
      syscall(SYS_close_range, (unsigned int)executable + 1u, UINT_MAX, 0u) != 0 ||
      snprintf(state, sizeof(state), "KEIKO_STATE_DIR=%s", owner->state_path) <= 0 ||
      snprintf(deadline, sizeof(deadline), "KEIKO_APP_HANDOFF_DEADLINE_MS=%llu",
               (unsigned long long)handoff->deadline) <= 0 ||
      !keiko_tree_before_deadline(handoff->deadline)) _exit(126);
  char *const arguments[] = {path, (char *)"--coordinate-update", handoff->activation, NULL};
  char *const environment[] = {state, deadline, NULL};
  fexecve(executable, arguments, environment);
  _exit(126);
}

#endif

static int keiko_handoff_envelope(const keiko_runtime_owner *owner, uint16_t kind,
                                   uint64_t deadline) {
  const keiko_app_handoff *handoff = owner->handoff;
  unsigned char bytes[148] = {'K','H','O','1',1,0,0,0,136,0,0,0};
  write_u16(bytes + 6, kind);
  write_u32(bytes + 12, (uint32_t)owner->root);
  write_u32(bytes + 16, (uint32_t)getpid());
  memcpy(bytes + 20, owner->launch_id, 32);
  memcpy(bytes + 52, handoff->activation, 32);
  memcpy(bytes + 84, handoff->plan, 64);
  return keiko_owner_write(handoff->proof, bytes, sizeof(bytes), deadline);
}

#if defined(__linux__)
static int keiko_handoff_spawn(keiko_runtime_owner *owner) {
  keiko_app_handoff *handoff = owner->handoff;
  int input[2] = {-1, -1}, response[2] = {-1, -1}, proof[2] = {-1, -1};
  int parent = -1, environment = -1, result = 0;
  if (!keiko_owner_private_pipe(input) || !keiko_owner_private_pipe(response) ||
      !keiko_owner_private_pipe(proof) ||
      (environment = keiko_handoff_environment(owner, handoff->deadline)) < 0 ||
      (parent = (int)syscall(SYS_pidfd_open, getpid(), 0u)) < 0 ||
      !keiko_tree_before_deadline(handoff->deadline)) goto cleanup;
  handoff->child = fork();
  if (handoff->child == 0)
    keiko_handoff_child(owner, handoff, input[0], response[1], proof[0], parent, environment);
  if (handoff->child < 0) goto cleanup;
  handoff->control = input[1]; input[1] = -1;
  handoff->response = response[0]; response[0] = -1;
  handoff->proof = proof[1]; proof[1] = -1;
  handoff->child_handle = (int)syscall(SYS_pidfd_open, handoff->child, 0u);
  result = handoff->child_handle >= 0 && keiko_handoff_envelope(owner, 1, handoff->deadline);
cleanup:
  if (parent >= 0) close(parent);
  if (environment >= 0) close(environment);
  for (size_t i = 0; i < 2; ++i) {
    keiko_owner_close(&input[i]); keiko_owner_close(&response[i]); keiko_owner_close(&proof[i]);
  }
  return result;
}

#else
#include "keiko-portable-app-handoff-macos.h"
#endif

static int keiko_handoff_reply(keiko_runtime_owner *owner, uint16_t kind,
                                uint16_t reason, uint64_t deadline) {
  const keiko_app_handoff *handoff = owner->handoff;
  unsigned char bytes[108] = {'K','H','U','1',1,0,0,0,0,0,0,0};
  uint32_t length = kind == 3 ? 36u : kind == 5 ? 96u : kind == 10 ? 34u : 32u;
  if (handoff == NULL || owner->app_control < 0) return 0;
  write_u16(bytes + 6, kind); write_u32(bytes + 8, length);
  memcpy(bytes + 12, handoff->activation, 32);
  if (kind == 3) write_u32(bytes + 44, (uint32_t)handoff->child);
  if (kind == 5) memcpy(bytes + 44, handoff->plan, 64);
  if (kind == 10) write_u16(bytes + 44, reason);
  return keiko_owner_write(owner->app_control, bytes, 12u + length, deadline);
}

static int keiko_handoff_stop(keiko_runtime_owner *owner, uint64_t deadline) {
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL) return 1;
  if (handoff->child > 0) {
    if (kill(handoff->child, SIGKILL) != 0 && errno != ESRCH) return 0;
    if (!keiko_coordinator_waitpid_deadline(&handoff->child, &handoff->status, deadline)) return 0;
  }
  keiko_owner_close(&handoff->child_handle); keiko_owner_close(&handoff->control);
  keiko_owner_close(&handoff->response); keiko_owner_close(&handoff->proof);
  handoff->authorized = 0; handoff->prepared = 0; handoff->accepted = 0;
  return 1;
}

static keiko_app_handoff *keiko_handoff_new(void) {
  keiko_app_handoff *handoff = (keiko_app_handoff *)calloc(1, sizeof(*handoff));
  if (handoff != NULL) {
    handoff->child = -1; handoff->child_handle = -1; handoff->control = -1;
    handoff->response = -1; handoff->proof = -1;
  }
  return handoff;
}

static int keiko_handoff_start(keiko_runtime_owner *owner, const unsigned char *payload) {
  if (!owner->committed || (owner->handoff != NULL && owner->handoff->child > 0)) return 0;
  keiko_app_handoff *handoff = keiko_handoff_new();
  if (handoff == NULL) return 0;
  memcpy(handoff->activation, payload, 32); memcpy(handoff->plan, payload + 32, 64);
  memcpy(handoff->coordinator, payload + 96, 64);
  handoff->deadline = keiko_scope_read_u64(payload + 192);
  uint64_t now = keiko_tree_now_ms();
  if (!keiko_khp_is_lower_hex(handoff->activation, 32) ||
      !keiko_khp_is_lower_hex(handoff->plan, 64) ||
      !keiko_khp_is_lower_hex(handoff->coordinator, 64) ||
      memcmp(payload + 160, owner->launch_id, 32) != 0 ||
      now >= handoff->deadline || handoff->deadline - now > KEIKO_COORDINATOR_MAX_CONTROL_MS ||
      (owner->handoff != NULL && strcmp(owner->handoff->activation, handoff->activation) == 0) ||
      !keiko_app_owner_state_named(owner)) { free(handoff); return 0; }
  free(owner->handoff); owner->handoff = handoff;
  if (!keiko_handoff_spawn(owner))
    return keiko_handoff_stop(owner, keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS) &&
           keiko_handoff_reply(owner, 10, 1, keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS);
  return keiko_handoff_reply(owner, 3, 0, handoff->deadline);
}

static int keiko_handoff_action(keiko_runtime_owner *owner, uint16_t kind,
                                 const unsigned char *payload, uint64_t deadline) {
  if (kind == 2) return keiko_handoff_start(owner, payload);
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL && kind == 8) {
    handoff = keiko_handoff_new();
    if (handoff == NULL) return 0;
    memcpy(handoff->activation, payload, 32);
    if (!keiko_khp_is_lower_hex(handoff->activation, 32)) { free(handoff); return 0; }
    owner->handoff = handoff;
  }
  if (handoff == NULL || memcmp(payload, handoff->activation, 32) != 0) return 0;
  if (kind == 8)
    return !handoff->old_reaped && keiko_handoff_stop(owner, deadline) &&
           keiko_handoff_reply(owner, 9, 0, deadline);
  if (handoff->child <= 0 || !keiko_tree_before_deadline(handoff->deadline)) return 0;
  if (kind == 4 && !handoff->authorized) {
    char control[65]; memcpy(control, handoff->plan, 64); control[64] = '\n';
    if (!keiko_owner_write(handoff->control, control, sizeof(control), handoff->deadline)) return 0;
#if defined(__APPLE__)
    if (!keiko_macos_handoff_environment(owner, handoff->deadline)) return 0;
#endif
    handoff->authorized = 1;
    return 1;
  }
  if (kind == 6 && handoff->prepared && !handoff->accepted) {
    handoff->accepted = 1;
    return keiko_handoff_reply(owner, 7, 0, handoff->deadline);
  }
  return 0;
}

#if defined(__linux__)
static int keiko_handoff_receive(keiko_runtime_owner *owner) {
  union { struct cmsghdr alignment;
    char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int) * 8)]; } control = {0};
  size_t frame_bytes = owner->app_pending_bytes < 12u ? 12u :
      read_u16(owner->app_pending + 6) == 2 ? 212u : 44u;
  struct iovec payload = {owner->app_pending + owner->app_pending_bytes,
                          frame_bytes - owner->app_pending_bytes};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1,
                           .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  ssize_t count = recvmsg(owner->app_control, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (count < 0 && (errno == EINTR || errno == EAGAIN)) return 1;
  int peer = count >= 0 ? keiko_scope_peer(&message, owner->root) : 0;
  if (count == 0) return 0;
  struct pollfd root = {owner->root_handle, POLLIN, 0};
  if (count < 0 || !peer || poll(&root, 1, 0) != 0 ||
      (message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) != 0) return 0;
  if (owner->app_pending_bytes == 0)
    owner->app_pending_deadline = keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
  if (!keiko_tree_before_deadline(owner->app_pending_deadline)) return 0;
  owner->app_pending_bytes += (size_t)count;
  if (owner->app_pending_bytes < 12) return 1;
  const unsigned char *bytes = owner->app_pending;
  uint16_t kind = read_u16(bytes + 6);
  uint32_t length = kind == 2 ? 200u : 32u;
  if (memcmp(bytes, "KHU1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      (kind != 2 && kind != 4 && kind != 6 && kind != 8) || read_u32(bytes + 8) != length ||
      owner->app_pending_bytes > 12u + length) return 0;
  if (owner->app_pending_bytes < 12u + length) return 1;
  int result = keiko_handoff_action(owner, kind, bytes + 12, owner->app_pending_deadline);
  owner->app_pending_bytes = 0;
  return result;
}

#else
#include "keiko-portable-app-control-macos.h"
#endif

static int keiko_handoff_acceptance(keiko_runtime_owner *owner) {
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL || !handoff->authorized || handoff->prepared ||
      !keiko_tree_before_deadline(handoff->deadline)) return 0;
  ssize_t count = read(handoff->response, handoff->acceptance + handoff->acceptance_bytes,
                       sizeof(handoff->acceptance) - handoff->acceptance_bytes);
  if (count < 0 && (errno == EINTR || errno == EAGAIN)) return 1;
  if (count < 0) return 0;
  handoff->acceptance_bytes += (size_t)count;
  if (handoff->acceptance_bytes > 77) return 0;
  if (count != 0) return 1;
  if (handoff->acceptance_bytes != 77 || memcmp(handoff->acceptance, "KHA2", 4) != 0 ||
      memcmp(handoff->acceptance + 4, handoff->plan, 64) != 0 || handoff->acceptance[76] != '\n')
    return 0;
  handoff->cleanup_deadline = keiko_scope_read_u64(handoff->acceptance + 68);
  uint64_t now = keiko_tree_now_ms();
  if (now >= handoff->cleanup_deadline ||
      handoff->cleanup_deadline - now > KEIKO_COORDINATOR_MAX_CONTROL_MS) return 0;
  handoff->prepared = 1;
  keiko_owner_close(&handoff->response);
  return keiko_handoff_reply(owner, 5, 0, handoff->deadline);
}

static int keiko_handoff_close_app(keiko_runtime_owner *owner) {
  keiko_owner_close(&owner->app_control);
  owner->app_pending_bytes = 0;
  return owner->handoff == NULL || owner->handoff->accepted ||
         keiko_handoff_stop(owner, keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS);
}

static int keiko_handoff_child_exited(keiko_runtime_owner *owner, uint64_t deadline) {
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL || handoff->child <= 0 ||
      !keiko_coordinator_waitpid_deadline(&handoff->child, &handoff->status, deadline)) return 0;
  int old_reaped = handoff->old_reaped;
  if (!keiko_handoff_stop(owner, deadline)) return 0;
  if (old_reaped) {
    handoff->resolved = WIFEXITED(handoff->status) && WEXITSTATUS(handoff->status) == 0;
    return handoff->resolved ? 2 : 0;
  }
  if (owner->app_control >= 0 && !keiko_handoff_reply(owner, 10, 2, deadline))
    return keiko_handoff_close_app(owner);
  return 1;
}

static int keiko_handoff_old_reaped(keiko_runtime_owner *owner, uint64_t deadline) {
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL || !handoff->accepted || handoff->child <= 0)
    return keiko_handoff_stop(owner, deadline);
  handoff->old_reaped = 1;
  keiko_owner_close(&owner->control); keiko_owner_close(&owner->response);
  keiko_owner_close(&owner->scope); keiko_owner_close(&owner->app_control);
  if (!keiko_handoff_envelope(owner, 2, deadline)) return 0;
  keiko_owner_close(&handoff->proof);
  return 2;
}

static int keiko_handoff_expired(keiko_runtime_owner *owner, uint64_t now) {
  if (owner->app_pending_bytes > 0 && now >= owner->app_pending_deadline &&
      !keiko_handoff_close_app(owner)) return 0;
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL || handoff->child <= 0) return 1;
  uint64_t deadline = handoff->accepted ? handoff->cleanup_deadline : handoff->deadline;
  if (now < deadline) return 1;
  int old_reaped = handoff->old_reaped;
  if (!keiko_handoff_stop(owner, now + KEIKO_OWNER_BOUND_MS) || old_reaped) return 0;
  return owner->app_control < 0 || keiko_handoff_reply(owner, 10, 2, now + KEIKO_OWNER_BOUND_MS);
}

static void keiko_handoff_bound(const keiko_runtime_owner *owner, uint64_t *bound, int *bounded) {
  uint64_t candidate = UINT64_MAX;
  if (owner->app_pending_bytes > 0) candidate = owner->app_pending_deadline;
  const keiko_app_handoff *handoff = owner->handoff;
  if (handoff != NULL && handoff->child > 0) {
    uint64_t active = handoff->accepted ? handoff->cleanup_deadline : handoff->deadline;
    if (active < candidate) candidate = active;
  }
  if (candidate != UINT64_MAX && (!*bounded || candidate < *bound)) {
    *bound = candidate; *bounded = 1;
  }
}

static int keiko_handoff_cleanup(keiko_runtime_owner *owner) {
  keiko_app_handoff *handoff = owner->handoff;
  if (handoff == NULL) return 1;
  int resolved = !handoff->old_reaped || handoff->resolved;
  int stopped = keiko_handoff_stop(owner, keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS);
  free(handoff); owner->handoff = NULL;
  return stopped && resolved;
}

#endif
