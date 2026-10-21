#ifndef KEIKO_PORTABLE_APP_OWNER_LINUX_H
#define KEIKO_PORTABLE_APP_OWNER_LINUX_H

/* App-only ownership transfer. Generic runtime KRP/KRS admission is unchanged. */
static int keiko_app_owner_initial_deadline(uint64_t *deadline) {
  return keiko_app_clip_deadline(deadline, 0) && keiko_tree_before_deadline(*deadline);
}

static int keiko_app_owner_move(int descriptor) {
  if (descriptor < 0) return -1;
  int moved = fcntl(descriptor, F_DUPFD_CLOEXEC, 16);
  close(descriptor);
  return moved;
}

static int keiko_app_owner_directory(int descriptor) {
  struct stat status;
  if (descriptor < 0) return 0;
  return fstat(descriptor, &status) == 0 && S_ISDIR(status.st_mode) &&
         status.st_uid == geteuid() && (status.st_mode & 0777) == 0700;
}

static int keiko_app_owner_subdirectory(int parent, const char *name) {
  if (mkdirat(parent, name, 0700) == 0) {
    if (fsync(parent) != 0) return -1;
  } else if (errno != EEXIST) return -1;
  int descriptor = keiko_app_owner_move(openat(parent, name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (keiko_app_owner_directory(descriptor)) return descriptor;
  if (descriptor >= 0) close(descriptor);
  return -1;
}

static int keiko_app_owner_sync_parent(const char *path) {
  char *storage = strdup(path);
  if (storage == NULL) return 0;
  char *separator = strrchr(storage, '/');
  int descriptor = -1, result = 0;
  if (separator != NULL) {
    if (separator == storage) separator[1] = '\0';
    else *separator = '\0';
    descriptor = separator == storage ? open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
                                     : keiko_coordinator_open_directory_path(storage);
    result = descriptor >= 0 && fsync(descriptor) == 0;
  }
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  free(storage);
  return result;
}

static int keiko_app_owner_select(keiko_runtime_owner *owner,
                                   const struct launch_request *request) {
  const char *grant = NULL;
  for (uint16_t i = 0; i < request->environment_count; ++i) {
    const char *name = request->environment_names[i], *value = request->environment_values[i];
    if (strcmp(name, "KEIKO_UI_LAUNCH_ID") == 0) {
      if (owner->launch_id != NULL) return 0;
      owner->launch_id = value;
    } else if (strcmp(name, "KEIKO_STATE_DIR") == 0) {
      if (owner->state_path != NULL) return 0;
      owner->state_path = value;
    } else if (strcmp(name, "KEIKO_START_TIMEOUT_SECS") == 0) {
      if (grant != NULL) return 0;
      grant = value;
    }
  }
  if (owner->launch_id == NULL || !valid_recovery_handle(owner->launch_id) ||
      owner->state_path == NULL) return 0;
  uint64_t seconds;
  if (!keiko_positive_u64(grant, 9007199254740ull, &seconds) ||
      owner->started_at == 0 || owner->started_at > UINT64_MAX - seconds * 1000u) return 0;
  owner->commit_deadline = owner->started_at + seconds * 1000u;
  const char *selected = getenv("KEIKO_UI_START_DEADLINE_MS");
  uint64_t absolute;
  if (selected != NULL) {
    if (!keiko_positive_u64(selected, UINT64_MAX, &absolute)) return 0;
    if (absolute < owner->commit_deadline) owner->commit_deadline = absolute;
  }
  /* The coordinator carries its original cleanup grant separately from the exec grant. */
  selected = getenv("KEIKO_UI_COMMIT_DEADLINE_MS");
  if (selected != NULL) {
    if (!keiko_positive_u64(selected, UINT64_MAX, &absolute) ||
        absolute < owner->commit_deadline ||
        absolute - owner->started_at > KEIKO_COORDINATOR_MAX_CONTROL_MS) return 0;
    owner->commit_deadline = absolute;
  }
  owner->state = keiko_app_owner_move(keiko_coordinator_open_directory_path(owner->state_path));
  if (!keiko_app_owner_directory(owner->state) ||
      !keiko_app_owner_sync_parent(owner->state_path)) return 0;
  int hidden = keiko_app_owner_subdirectory(owner->state, ".keiko");
  if (hidden < 0) return 0;
  owner->receipts = keiko_app_owner_subdirectory(hidden, "ui-runtime");
  close(hidden);
  if (owner->receipts < 0) return 0;
  char receipt[48];
  struct stat existing;
  if (snprintf(receipt, sizeof(receipt), "%s.receipt", owner->launch_id) <= 0) return 0;
  errno = 0;
  if (fstatat(owner->receipts, receipt, &existing, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)
    return 0;
  owner->persistent = 1;
  return 1;
}

static int keiko_app_owner_prepare(keiko_runtime_owner *owner,
                                   const struct launch_request *request) {
  return keiko_app_owner_select(owner, request) &&
         keiko_tree_before_deadline(owner->commit_deadline);
}

static int keiko_app_owner_state_named(const keiko_runtime_owner *owner) {
  struct stat held, named;
  int descriptor = keiko_coordinator_open_directory_path(owner->state_path);
  int hidden = -1, receipts = -1;
  int result = keiko_app_owner_directory(descriptor) && fstat(owner->state, &held) == 0 &&
    fstat(descriptor, &named) == 0 && held.st_dev == named.st_dev && held.st_ino == named.st_ino;
  if (result) {
    hidden = openat(descriptor, ".keiko", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (keiko_app_owner_directory(hidden))
      receipts = openat(hidden, "ui-runtime", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    result = keiko_app_owner_directory(receipts) && fstat(owner->receipts, &held) == 0 &&
      fstat(receipts, &named) == 0 && held.st_dev == named.st_dev && held.st_ino == named.st_ino;
  }
  if (receipts >= 0 && close(receipts) != 0) result = 0;
  if (hidden >= 0 && close(hidden) != 0) result = 0;
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  return result;
}

static int keiko_app_owner_record(keiko_runtime_owner *owner, const char *phase,
                                   int initial, uint64_t deadline) {
  char name[48], temporary[48], bytes[160];
  struct stat named;
  int descriptor = -1, result = 0;
  int count = snprintf(bytes, sizeof(bytes), "keiko-ui-runtime-v1\n%ld\n%s\n%ld\n%s\n",
                       (long)owner->root, owner->launch_id, (long)getpid(), phase);
  if (count <= 0 || (size_t)count >= sizeof(bytes) ||
      snprintf(name, sizeof(name), "%s.receipt", owner->launch_id) <= 0 ||
      snprintf(temporary, sizeof(temporary), ".%s.pending", owner->launch_id) <= 0 ||
      !keiko_app_owner_state_named(owner) || !keiko_tree_before_deadline(deadline)) return 0;
  if (!initial && (fstatat(owner->receipts, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_uid != geteuid() ||
      (named.st_mode & 0777) != 0600 ||
      !keiko_coordinator_same_file(&named, &owner->receipt_identity))) return 0;
  descriptor = openat(owner->receipts, temporary,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
  if (descriptor < 0) return 0;
  if (!keiko_owner_write(descriptor, bytes, (size_t)count, deadline) ||
      fsync(descriptor) != 0 || fstat(descriptor, &named) != 0 ||
      !S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_uid != geteuid() ||
      (named.st_mode & 0777) != 0600) goto cleanup;
  if (initial) {
    if (renameat2(owner->receipts, temporary, owner->receipts, name, RENAME_NOREPLACE) != 0)
      goto cleanup;
  } else if (renameat(owner->receipts, temporary, owner->receipts, name) != 0) goto cleanup;
  owner->receipt_identity = named;
  result = fsync(owner->receipts) == 0 && keiko_app_owner_state_named(owner) &&
    fstatat(owner->receipts, name, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    S_ISREG(named.st_mode) && named.st_nlink == 1 && named.st_uid == geteuid() &&
    (named.st_mode & 0777) == 0600 &&
    keiko_coordinator_same_file(&named, &owner->receipt_identity);
cleanup:
  if (close(descriptor) != 0) result = 0;
  if (!result) (void)unlinkat(owner->receipts, temporary, 0);
  return result && keiko_tree_before_deadline(deadline);
}

static int keiko_app_owner_started(keiko_runtime_owner *owner, uint64_t deadline) {
  if (!owner->persistent) return send_response(RESPONSE_LAUNCHED, NULL, 0);
  unsigned char bytes[36];
  write_u32(bytes, (uint32_t)owner->root);
  memcpy(bytes + 4, owner->launch_id, 32);
  return keiko_app_owner_record(owner, "provisional", 1, deadline) &&
         send_response(4, bytes, sizeof(bytes));
}

static int keiko_app_owner_pid_matches(const keiko_runtime_owner *owner, uint64_t deadline) {
  char expected[100];
  unsigned char *actual = NULL;
  size_t length = 0;
  int count = snprintf(expected, sizeof(expected), "%ld\n%s\nbrowser-open-v1\nnative-app-v1\n",
                       (long)owner->root, owner->launch_id);
  int result = count > 0 && (size_t)count < sizeof(expected) &&
    keiko_coordinator_read_file_at(owner->state, "ui.pid", 512u, deadline, &actual, &length) &&
    length == (size_t)count && memcmp(actual, expected, length) == 0;
  free(actual);
  return result && keiko_tree_before_deadline(deadline);
}

static int keiko_app_owner_sync_pid(keiko_runtime_owner *owner, uint64_t deadline) {
  struct stat file;
  int descriptor = openat(owner->state, "ui.pid",
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  int result = descriptor >= 0 && fstat(descriptor, &file) == 0 && S_ISREG(file.st_mode) &&
    file.st_nlink == 1 && file.st_uid == geteuid() && (file.st_mode & 0777) == 0600 &&
    fsync(descriptor) == 0;
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  return result && fsync(owner->state) == 0 && keiko_tree_before_deadline(deadline);
}

static int keiko_app_owner_commit(keiko_runtime_owner *owner, const unsigned char header[12],
                                   uint64_t deadline) {
  unsigned char launch_id[32];
  if (owner->committed || read_u32(header + 8) != sizeof(launch_id) ||
      !keiko_coordinator_read_exact_deadline(owner->controller, launch_id, sizeof(launch_id), deadline) ||
      memcmp(launch_id, owner->launch_id, sizeof(launch_id)) != 0 || !owner->scope_bound ||
      !keiko_app_owner_sync_pid(owner, deadline) ||
      !keiko_app_owner_pid_matches(owner, deadline) ||
      !keiko_owner_root_reference(owner, deadline) ||
      !keiko_app_owner_record(owner, "owned", 0, deadline) ||
      !keiko_app_owner_pid_matches(owner, deadline) ||
      !keiko_owner_root_reference(owner, deadline)) return 0;
  owner->committed = 1;
  /* Once durable, a lost ACK is uncertainty at the caller, never authority to undo ownership. */
  (void)send_response(5, launch_id, sizeof(launch_id));
  return 1;
}

static void keiko_app_owner_cancel(keiko_runtime_owner *owner) {
  unsigned char header[12], payload[64];
  uint64_t deadline = keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
  keiko_owner_close(&owner->control);
  keiko_owner_close(&owner->scope);
  if (!keiko_owner_response(owner, header, payload, deadline) ||
      read_u16(header + 6) != RESPONSE_REAPED || read_u32(header + 8) != 8 ||
      read_u32(payload + 4) != 0) return;
  struct pollfd held = {owner->root_handle, POLLIN, 0};
  int status;
  if (poll(&held, 1, 0) == 1 && (held.revents & POLLIN) != 0 &&
      keiko_coordinator_waitpid_deadline(&owner->supervisor, &status, deadline) &&
      WIFEXITED(status) && WEXITSTATUS(status) == 0)
    (void)keiko_app_owner_record(owner, "reaped", 0, deadline);
}

/* A closed controller before launch, or failure before fork, created no supervisor generation. */
static void keiko_app_owner_record_unstarted(void) {
  char *names[] = {"KEIKO_UI_LAUNCH_ID", "KEIKO_STATE_DIR", "KEIKO_START_TIMEOUT_SECS"};
  char *values[] = {getenv(names[0]), getenv(names[1]), getenv(names[2])};
  if (values[0] == NULL || values[1] == NULL || values[2] == NULL) return;
  struct launch_request request = {.environment_count = 3,
    .environment_names = names, .environment_values = values};
  keiko_runtime_owner unstarted = {.root = 0, .state = -1, .receipts = -1,
                                   .started_at = keiko_tree_now_ms()};
  uint64_t cleanup_deadline = keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
  if (keiko_app_owner_select(&unstarted, &request))
    (void)keiko_app_owner_record(&unstarted, "not-started", 1, cleanup_deadline);
  keiko_owner_close(&unstarted.state); keiko_owner_close(&unstarted.receipts);
}

#endif
