#ifndef KEIKO_PORTABLE_RUNTIME_OWNER_MACOS_H
#define KEIKO_PORTABLE_RUNTIME_OWNER_MACOS_H

/* Darwin hooks for the existing persistent app-owner protocol and durable receipts. */
static int keiko_owner_root_reference(const keiko_runtime_owner *owner, uint64_t deadline) {
  keiko_macos_process_identity root, helper;
  return keiko_tree_before_deadline(deadline) && keiko_macos_identity(owner->root, &root) &&
         keiko_macos_identity(owner->supervisor, &helper) &&
         root.unique_id == owner->root_identity.unique_id &&
         root.parent_unique_id == helper.unique_id;
}

static int keiko_owner_root_exited(const keiko_runtime_owner *owner) {
  keiko_macos_process_identity root;
  errno = 0;
  if (keiko_macos_identity(owner->root, &root))
    return root.unique_id != owner->root_identity.unique_id;
  return errno == ESRCH;
}

static int keiko_macos_handoff_exited(pid_t child) {
  siginfo_t info = {0};
  if (child <= 0) return 0;
  return waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) != 0 ||
         info.si_pid == child;
}

static int keiko_owner_spawn(keiko_runtime_owner *owner, const char *helper,
                              const char *expected, uint64_t deadline, int app) {
  int control[2] = {-1, -1}, response[2] = {-1, -1}, identity[2] = {-1, -1};
  int channel[2] = {-1, -1}, executable = -1, initialized = 0, result = 0;
  char canonical[PATH_MAX], digest[65], grant[80];
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  if (!app || !owner->persistent || !keiko_khp_is_lower_hex(expected, 64u) ||
      realpath(helper, canonical) == NULL || strcmp(helper, canonical) != 0 ||
      (executable = keiko_coordinator_open_hashed_file(helper, deadline, digest)) < 0 ||
      strcmp(digest, expected) != 0 || !keiko_owner_private_pipe(control) ||
      !keiko_owner_private_pipe(response) || !keiko_owner_private_pipe(identity) ||
      socketpair(AF_UNIX, SOCK_STREAM, 0, channel) != 0) goto cleanup;
  for (size_t i = 0; i < 2; ++i) {
    int moved = fcntl(channel[i], F_DUPFD_CLOEXEC, 16);
    if (moved < 0) goto cleanup;
    close(channel[i]); channel[i] = moved;
  }
  if (posix_spawn_file_actions_init(&actions) != 0) goto cleanup;
  initialized = 1;
  if (posix_spawnattr_init(&attributes) != 0) goto cleanup;
  initialized = 2;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, control[0], 3) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, response[1], 4) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, identity[1], 6) != 0 ||
      posix_spawn_file_actions_adddup2(&actions, channel[1], 8) != 0) goto cleanup;
  for (int fd = 0; fd <= 2; ++fd) {
    int status = fcntl(fd, F_GETFD) < 0
      ? posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0)
      : posix_spawn_file_actions_adddup2(&actions, fd, fd);
    if (status != 0) goto cleanup;
  }
  if (fcntl(5, F_GETFD) >= 0 && posix_spawn_file_actions_adddup2(&actions, 5, 5) != 0) goto cleanup;
  if (snprintf(grant, sizeof(grant), "KEIKO_UI_START_DEADLINE_MS=%llu",
                 (unsigned long long)deadline) <= 0 || !keiko_tree_before_deadline(deadline)) goto cleanup;
  char *const arguments[] = {(char *)helper, (char *)"--app-owner-report", NULL};
  char *const environment[] = {grant, NULL};
  if (posix_spawn(&owner->supervisor, helper, &actions, &attributes, arguments, environment) != 0)
    goto cleanup;
  owner->control = control[1]; control[1] = -1;
  owner->response = response[0]; response[0] = -1;
  owner->identity = identity[0]; identity[0] = -1;
  owner->app_control = channel[0]; channel[0] = -1;
  result = 1;
cleanup:
  if (initialized >= 2) posix_spawnattr_destroy(&attributes);
  if (initialized >= 1) posix_spawn_file_actions_destroy(&actions);
  if (executable >= 0) close(executable);
  for (size_t i = 0; i < 2; ++i) {
    keiko_owner_close(&control[i]); keiko_owner_close(&response[i]);
    keiko_owner_close(&identity[i]); keiko_owner_close(&channel[i]);
  }
  return result;
}

static int keiko_owner_capture(keiko_runtime_owner *owner, uint64_t deadline) {
  unsigned char bytes[16];
  if (!keiko_coordinator_read_exact_deadline(owner->identity, bytes, sizeof(bytes), deadline) ||
      memcmp(bytes, "KRI1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      read_u16(bytes + 6) != 1 || read_u32(bytes + 8) != 4 ||
      read_u32(bytes + 12) <= 1 || read_u32(bytes + 12) > INT_MAX) return 0;
  owner->root = (pid_t)read_u32(bytes + 12);
  if (!keiko_macos_identity(owner->root, &owner->root_identity) ||
      !keiko_owner_root_reference(owner, deadline)) return 0;
  owner->scope_bound = 1;
  return 1;
}

#endif
