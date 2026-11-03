#ifndef KEIKO_PORTABLE_NATIVE_SUCCESSOR_LINUX_H
#define KEIKO_PORTABLE_NATIVE_SUCCESSOR_LINUX_H

/* A successor uses the same persistent owner and receipt as an ordinary managed app start. */
static int keiko_successor_environment(const keiko_coordinator_context *context, uint64_t deadline) {
  const struct app_environment_packet *environment = &context->native_environment;
  unsigned char header[12] = {'K','A','E','1',1,0,1,0,0,0,0,0};
  if (environment->storage == NULL || environment->storage_length < 5u ||
      environment->storage_length - 1u > KRP_MAX_PACKET - sizeof(header)) return 0;
  write_u32(header + 8, (uint32_t)(environment->storage_length - 1u));
  return keiko_coordinator_write_deadline(context->supervisor_control, header, sizeof(header), deadline) &&
      keiko_coordinator_write_deadline(context->supervisor_control, environment->storage,
                                         environment->storage_length - 1u, deadline);
}

static const char *keiko_successor_launch_id(const keiko_coordinator_context *context,
                                             int restoring) {
  return context->plan.field[restoring ? KEIKO_KHP_RESTORE_LAUNCH_ID : KEIKO_KHP_NEW_LAUNCH_ID];
}

static int keiko_successor_existing_pid(const keiko_coordinator_context *context,
                                         int state, uint64_t deadline) {
  struct stat status;
  unsigned char *content = NULL;
  size_t length = 0;
  char expected[128];
  int count, result = 0;
  if (fstatat(state, "ui.pid", &status, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT;
  if (!S_ISREG(status.st_mode) || status.st_nlink != 1 || status.st_uid != geteuid() ||
      (status.st_mode & 0777) != 0600 ||
      !keiko_coordinator_read_file_at(state, "ui.pid", 512u, deadline, &content, &length)) return 0;
  count = snprintf(expected, sizeof(expected), "%s\n%s\nbrowser-open-v1\nnative-app-v1\n",
      context->plan.field[KEIKO_KHP_OLD_PID], context->plan.field[KEIKO_KHP_OLD_LAUNCH_ID]);
  result = count > 0 && (size_t)count < sizeof(expected) &&
           length == (size_t)count && memcmp(content, expected, length) == 0;
  free(content);
  return result && keiko_tree_before_deadline(deadline);
}

static int keiko_successor_publish_pid(keiko_coordinator_context *context, pid_t root,
                                        int restoring, uint64_t deadline) {
  char temporary[80], content[128];
  int descriptor = -1, result = 0;
  int state = keiko_coordinator_open_directory_path(context->state_dir);
  int count = snprintf(content, sizeof(content), "%ld\n%s\nbrowser-open-v1\nnative-app-v1\n",
                         (long)root, keiko_successor_launch_id(context, restoring));
  if (state < 0 || count <= 0 || (size_t)count >= sizeof(content) ||
      snprintf(temporary, sizeof(temporary), ".ui.pid.%s.native",
                 context->plan.field[KEIKO_KHP_ACTIVATION_ID]) <= 0 ||
      !keiko_successor_existing_pid(context, state, deadline)) goto cleanup;
  descriptor = openat(state, temporary,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
  if (descriptor < 0 || !keiko_coordinator_write_exact(descriptor, content, (size_t)count) ||
      fsync(descriptor) != 0 || !keiko_tree_before_deadline(deadline) ||
      !keiko_successor_existing_pid(context, state, deadline) ||
      renameat(state, temporary, state, "ui.pid") != 0 || fsync(state) != 0) goto cleanup;
  context->native_root = root;
  context->native_owner = context->supervisor_pid;
  context->native_restoring = restoring;
  result = keiko_tree_before_deadline(deadline);
cleanup:
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  if (state >= 0) {
    if (!result && descriptor >= 0) (void)unlinkat(state, temporary, 0);
    if (close(state) != 0) result = 0;
  }
  return result;
}

static int keiko_successor_launched(keiko_coordinator_context *context,
                                      const unsigned char header[12],
                                      int restoring, uint64_t deadline) {
  unsigned char payload[36];
  if (keiko_khp_read_u16(header + 6) != 4 || keiko_khp_read_u32(header + 8) != sizeof(payload) ||
      !keiko_coordinator_read_exact_deadline(context->supervisor_response, payload,
                                               sizeof(payload), deadline) ||
      memcmp(payload + 4, keiko_successor_launch_id(context, restoring), 32) != 0) return 0;
  uint32_t pid = keiko_khp_read_u32(payload);
  if (pid <= 1 || pid > INT_MAX || (pid_t)pid == context->supervisor_pid) return 0;
  context->native_root = (pid_t)pid;
  context->native_restoring = restoring;
  return keiko_tree_before_deadline(deadline);
}

static int keiko_successor_commit(keiko_coordinator_context *context) {
  unsigned char control[44] = {'K','R','C','1',1,0,4,0,32,0,0,0}, response[44];
  uint64_t deadline = context->native_cleanup_deadline;
  if (!context->native_release_allowed || context->supervisor_pid <= 0 ||
      !keiko_tree_before_deadline(deadline) ||
      !keiko_successor_publish_pid(context, context->native_root, context->native_restoring,
                                    deadline)) return 0;
  memcpy(control + 12, keiko_successor_launch_id(context, context->native_restoring), 32);
  if (!keiko_coordinator_write_deadline(context->supervisor_control, control, sizeof(control), deadline) ||
      !keiko_coordinator_read_exact_deadline(context->supervisor_response, response,
                                               sizeof(response), deadline) ||
      memcmp(response, "KRS1", 4) != 0 || keiko_khp_read_u16(response + 4) != 1 ||
      keiko_khp_read_u16(response + 6) != 5 || keiko_khp_read_u32(response + 8) != 32 ||
      memcmp(response + 12, control + 12, 32) != 0) return 0;
  context->native_release_completed = 1;
  return 1;
}

static int keiko_successor_reaped(const keiko_coordinator_context *context, uint64_t deadline) {
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1], name[48], expected[160];
  unsigned char *content = NULL;
  size_t length = 0, offset = 20u;
  uint64_t root = 0;
  int count, result = 0;
  struct stat status;
  int state = -1;
  if (keiko_coordinator_join(path, sizeof(path), context->state_dir, "/.keiko/ui-runtime"))
    state = keiko_coordinator_open_directory_path(path);
  if (state < 0 || context->native_owner <= 0 ||
      fstat(state, &status) != 0 || status.st_uid != geteuid() ||
      (status.st_mode & 0777) != 0700 ||
      snprintf(name, sizeof(name), "%s.receipt",
          keiko_successor_launch_id(context, context->native_attempt_restoring)) <= 0 ||
      fstatat(state, name, &status, AT_SYMLINK_NOFOLLOW) != 0 ||
      status.st_uid != geteuid() || (status.st_mode & 0777) != 0600 ||
      !keiko_coordinator_read_file_at(state, name, 160u, deadline, &content, &length) ||
      length < offset + 1u || memcmp(content, "keiko-ui-runtime-v1\n", 20u) != 0) goto cleanup;
  size_t begin = offset;
  while (offset < length && content[offset] >= '0' && content[offset] <= '9') {
    root = root * 10u + (uint64_t)(content[offset++] - '0');
    if (root > INT_MAX) goto cleanup;
  }
  if (offset == begin || offset >= length || content[offset] != '\n' ||
      (offset - begin > 1u && content[begin] == '0')) goto cleanup;
  count = snprintf(expected, sizeof(expected), "keiko-ui-runtime-v1\n%llu\n%s\n%ld\n%s\n",
      (unsigned long long)root,
      keiko_successor_launch_id(context, context->native_attempt_restoring),
      (long)context->native_owner, root == 0 ? "not-started" : "reaped");
  result = count > 0 && (size_t)count == length && memcmp(content, expected, length) == 0 &&
           keiko_tree_before_deadline(deadline);
cleanup:
  free(content);
  if (state >= 0 && close(state) != 0) result = 0;
  return result;
}

#endif
