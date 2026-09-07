#ifndef KEIKO_PORTABLE_RECOVERY_CONTROL_H
#define KEIKO_PORTABLE_RECOVERY_CONTROL_H

#define KEIKO_RECOVERY_CONTROL_MAX_BYTES 2048u
#define KEIKO_RECOVERY_MAX_RECEIPTS 20u

typedef struct {
  char *activation_id;
  char *plan_sha256;
  char *coordinator_sha256;
  unsigned int intent_revision;
  unsigned int receipt_sequence;
  char *receipt_sha256;
  char *runtime_state_sha256;
  char *lock_identity;
} keiko_recovery_control;

#if !defined(_WIN32)

static int keiko_recovery_read_control(char content[KEIKO_RECOVERY_CONTROL_MAX_BYTES + 1u],
                                       uint64_t deadline_ms) {
  size_t offset = 0;
  while (offset < KEIKO_RECOVERY_CONTROL_MAX_BYTES) {
    struct pollfd descriptor = {STDIN_FILENO, POLLIN | POLLHUP, 0};
    uint64_t now = keiko_tree_now_ms();
    int timeout, ready;
    ssize_t count;
    if (now > deadline_ms) return 0;
    timeout = deadline_ms - now > (uint64_t)INT_MAX ? INT_MAX : (int)(deadline_ms - now);
    ready = poll(&descriptor, 1, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (descriptor.revents & (POLLERR | POLLNVAL)) != 0) return 0;
    count = read(STDIN_FILENO, content + offset, KEIKO_RECOVERY_CONTROL_MAX_BYTES - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return 0;
    if (count == 0) {
      content[offset] = '\0';
      return offset > 0;
    }
    offset += (size_t)count;
  }
  return 0;
}

#endif

static int keiko_recovery_parse_control(char *content, keiko_recovery_control *control) {
  char *field[9], *cursor = content;
  uint64_t number;
  size_t index;
  for (index = 0; index < 9u; ++index) {
    char *newline;
    field[index] = cursor;
    newline = strchr(cursor, '\n');
    if (newline == NULL) return 0;
    *newline = '\0';
    cursor = newline + 1;
  }
  if (*cursor != '\0' || strcmp(field[0], "KUR1") != 0 ||
      !keiko_khp_is_lower_hex(field[1], 32u) || !keiko_khp_is_lower_hex(field[2], 64u) ||
      !keiko_khp_is_lower_hex(field[3], 64u) ||
      !keiko_khp_decimal_value(field[4], UINT32_MAX, &number)) return 0;
  control->intent_revision = (unsigned int)number;
  if (!keiko_khp_decimal_value(field[5], KEIKO_RECOVERY_MAX_RECEIPTS, &number)) return 0;
  control->receipt_sequence = (unsigned int)number;
  if (!((control->receipt_sequence == 0u && strcmp(field[6], "-") == 0) ||
        (control->receipt_sequence > 0u && keiko_khp_is_lower_hex(field[6], 64u))) ||
      !keiko_khp_is_lower_hex(field[7], 64u) ||
      !keiko_khp_is_lower_hex(field[8], 64u)) return 0;
  control->activation_id = field[1];
  control->plan_sha256 = field[2];
  control->coordinator_sha256 = field[3];
  control->receipt_sha256 = field[6];
  control->runtime_state_sha256 = field[7];
  control->lock_identity = field[8];
  return 1;
}

static int keiko_recovery_copy_json_value(const char **cursor, const char *prefix,
                                          char *output, size_t capacity) {
  const char *start, *end;
  size_t length;
  if (strncmp(*cursor, prefix, strlen(prefix)) != 0) return 0;
  start = *cursor + strlen(prefix);
  end = strchr(start, '"');
  if (end == NULL) return 0;
  length = (size_t)(end - start);
  if (length == 0u || length >= capacity || memchr(start, '\\', length) != NULL) return 0;
  memcpy(output, start, length);
  output[length] = '\0';
  *cursor = end + 1;
  return 1;
}

#if !defined(_WIN32)

static int keiko_recovery_validate_runtime(const keiko_coordinator_context *context,
                                           const keiko_recovery_control *control,
                                           uint64_t deadline_ms) {
  unsigned char *content = NULL;
  size_t length = 0;
  char actual_sha256[65];
  int state = -1, updates = -1, result = 0;
  state = open(context->state_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (state != -1)
    updates = openat(state, "updates", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (updates == -1 ||
      !keiko_coordinator_read_file_at(updates, "runtime-state.json", 1024u * 1024u,
                                      deadline_ms, &content, &length) ||
      !keiko_coordinator_hash_bytes(content, length, actual_sha256) ||
      strcmp(actual_sha256, control->runtime_state_sha256) != 0)
    goto cleanup;
  result = 1;
cleanup:
  if (content != NULL) {
    memset(content, 0, length);
    free(content);
  }
  if (updates != -1) close(updates);
  if (state != -1) close(state);
  return result;
}

static int keiko_recovery_validate_lock(const keiko_coordinator_context *context,
                                        const keiko_recovery_control *control,
                                        uint64_t deadline_ms) {
  unsigned char *content = NULL, *child = NULL;
  size_t length = 0, child_length = 0;
  char session[257], target[65], started[65], pid[32], process_identity[257];
  char identity_json[1024], actual_identity[65], session_digest[65], child_name[128];
  char expected_child[1024];
  const char *cursor, *number_end;
  int state = -1, updates = -1, result = 0, written;
  state = open(context->state_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (state != -1)
    updates = openat(state, "updates", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (updates == -1 ||
      !keiko_coordinator_read_file_at(updates, "update-session.lock", 4096u, deadline_ms,
                                      &content, &length))
    goto cleanup;
  cursor = (const char *)content;
  if (!keiko_recovery_copy_json_value(&cursor, "{\"sessionId\":\"", session,
                                      sizeof(session)) ||
      strcmp(session, context->plan.field[KEIKO_KHP_SESSION_ID]) != 0 ||
      !keiko_recovery_copy_json_value(&cursor, ",\"targetVersion\":\"", target,
                                      sizeof(target)) ||
      strcmp(target, context->plan.field[KEIKO_KHP_TARGET_VERSION]) != 0 ||
      !keiko_recovery_copy_json_value(&cursor, ",\"startedAt\":\"", started,
                                      sizeof(started)) ||
      strncmp(cursor, ",\"pid\":", 7u) != 0)
    goto cleanup;
  cursor += 7u;
  number_end = cursor;
  while (*number_end >= '0' && *number_end <= '9') ++number_end;
  if (number_end == cursor || (size_t)(number_end - cursor) >= sizeof(pid)) goto cleanup;
  memcpy(pid, cursor, (size_t)(number_end - cursor));
  pid[number_end - cursor] = '\0';
  cursor = number_end;
  if (strncmp(cursor, ",\"childPid\":", 12u) == 0) {
    cursor += 12u;
    while (*cursor >= '0' && *cursor <= '9') ++cursor;
  }
  if (!keiko_recovery_copy_json_value(&cursor, ",\"processIdentity\":\"", process_identity,
                                      sizeof(process_identity)) ||
      strcmp(cursor, "}\n") != 0)
    goto cleanup;
  written = snprintf(identity_json, sizeof(identity_json),
                     "{\"sessionId\":\"%s\",\"targetVersion\":\"%s\","
                     "\"startedAt\":\"%s\",\"pid\":%s,\"processIdentity\":\"%s\"}",
                     session, target, started, pid, process_identity);
  if (written <= 0 || (size_t)written >= sizeof(identity_json) ||
      !keiko_coordinator_hash_bytes(identity_json, (size_t)written, actual_identity) ||
      strcmp(actual_identity, control->lock_identity) != 0 ||
      !keiko_coordinator_hash_bytes(session, strlen(session), session_digest) ||
      snprintf(child_name, sizeof(child_name), "update-session.lock.%s.child", session_digest) <= 0 ||
      !keiko_coordinator_read_file_at(updates, child_name, 1024u, deadline_ms,
                                      &child, &child_length))
    goto cleanup;
  written = snprintf(expected_child, sizeof(expected_child),
                     "{\"sessionId\":\"%s\",\"lockIdentity\":\"%s\",\"childPid\":%ld}\n",
                     session, control->lock_identity, (long)getpid());
  if (written <= 0 || (size_t)written != child_length ||
      memcmp(child, expected_child, child_length) != 0)
    goto cleanup;
  result = 1;
cleanup:
  if (content != NULL) {
    memset(content, 0, length);
    free(content);
  }
  if (child != NULL) {
    memset(child, 0, child_length);
    free(child);
  }
  if (updates != -1) close(updates);
  if (state != -1) close(state);
  return result;
}

static int keiko_recovery_prepare(keiko_coordinator_context *context,
                                  const keiko_recovery_control *control,
                                  const char *activation_id, const char *executable,
                                  uint64_t deadline_ms) {
  const char *state = getenv("KEIKO_STATE_DIR");
  char canonical_state[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char canonical_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char expected_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  struct stat capsule_status;
  int capsule = -1, result = 0;
  memset(context, 0, sizeof(*context));
  context->supervisor_pid = -1;
  context->supervisor_control = -1;
  context->supervisor_response = -1;
  context->start_gate = -1;
  if (state == NULL || !keiko_khp_is_absolute_canonical_path(state) ||
      realpath(state, canonical_state) == NULL || strcmp(state, canonical_state) != 0 ||
      realpath(executable, canonical_executable) == NULL ||
      !keiko_coordinator_join(context->capsule, sizeof(context->capsule), state,
                              "/updates/handoff/") ||
      strlen(context->capsule) + strlen(activation_id) + 1u > sizeof(context->capsule))
    return 0;
  strcat(context->capsule, activation_id);
  memcpy(context->state_dir, state, strlen(state) + 1u);
  if (!keiko_coordinator_join(expected_executable, sizeof(expected_executable), context->capsule,
                              "/coordinator") ||
      strcmp(canonical_executable, expected_executable) != 0)
    goto cleanup;
  capsule = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule == -1 || fstat(capsule, &capsule_status) != 0 ||
      !S_ISDIR(capsule_status.st_mode) || capsule_status.st_uid != geteuid() ||
      (capsule_status.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      !keiko_coordinator_load_plan(context, capsule, activation_id, deadline_ms) ||
      strcmp(context->plan_sha256, control->plan_sha256) != 0 ||
      !keiko_coordinator_file_digest_matches(executable, control->coordinator_sha256,
                                             deadline_ms) ||
      !keiko_recovery_validate_runtime(context, control, deadline_ms) ||
      !keiko_recovery_validate_lock(context, control, deadline_ms))
    goto cleanup;
  result = 1;
cleanup:
  if (capsule != -1) close(capsule);
  if (!result) keiko_coordinator_clear(context);
  return result;
}

static int keiko_recovery_load_receipts(keiko_coordinator_context *context,
                                        const keiko_recovery_control *control,
                                        uint64_t deadline_ms, unsigned int *forward_count,
                                        unsigned int *restore_count) {
  int restoring = 0;
  *forward_count = *restore_count = 0u;
  while (keiko_coordinator_next_receipt_exists(context)) {
    const char *kind;
    const char *outcome;
    if (context->receipt_sequence >= KEIKO_RECOVERY_MAX_RECEIPTS) return 0;
    if (!restoring &&
        keiko_recovery_forward_expected(*forward_count, &kind, &outcome) &&
        keiko_coordinator_read_expected_receipt(
            context, kind, outcome, deadline_ms)) {
      *forward_count += 1u;
    } else {
      if (!restoring) {
        if (!keiko_recovery_may_begin_restore(*forward_count)) return 0;
        restoring = 1;
      }
      if (!keiko_recovery_restore_expected(*restore_count, &kind, &outcome) ||
          !keiko_coordinator_read_expected_receipt(
              context, kind, outcome, deadline_ms))
        return 0;
      *restore_count += 1u;
    }
    if (context->receipt_sequence == control->receipt_sequence &&
        strcmp(context->receipt_sha256, control->receipt_sha256) != 0)
      return 0;
  }
  return context->receipt_sequence >= control->receipt_sequence &&
         (control->receipt_sequence != 0u || strcmp(control->receipt_sha256, "-") == 0);
}

static int keiko_recovery_remove_tree_if_present(const char *path, uint64_t deadline_ms) {
  struct stat status;
  if (lstat(path, &status) != 0) return errno == ENOENT;
  if (!S_ISDIR(status.st_mode)) return 0;
  return keiko_coordinator_remove_tree(path, deadline_ms);
}

static int keiko_recovery_engine_append_receipt(
    void *opaque,
    const char *kind,
    const char *outcome
) {
  return keiko_coordinator_append_receipt(
      (keiko_coordinator_context *)opaque,
      kind,
      outcome
  );
}

static int keiko_recovery_engine_restore_platform(void *opaque, uint64_t deadline_ms) {
  return keiko_coordinator_restore_roots(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_recovery_engine_restore_previous(void *opaque, uint64_t deadline_ms) {
  return keiko_coordinator_restore_previous(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_recovery_engine_registration_is_prepared(
    void *opaque,
    uint64_t deadline_ms
) {
  int registration;
  return keiko_coordinator_promoted_registration(
             (keiko_coordinator_context *)opaque,
             deadline_ms,
             &registration
         ) &&
         registration == KEIKO_COORDINATOR_REGISTRATION_PREPARED;
}

static int keiko_recovery_engine_cleanup(void *opaque, uint64_t deadline_ms) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_recovery_remove_tree_if_present(
             context->plan.field[KEIKO_KHP_BACKUP_ROOT],
             deadline_ms
         ) &&
         keiko_recovery_remove_tree_if_present(
             context->plan.field[KEIKO_KHP_STAGE_ROOT],
             deadline_ms
         );
}

static int keiko_recovery_reconcile(keiko_coordinator_context *context,
                                    unsigned int forward_count, unsigned int restore_count,
                                    uint64_t deadline_ms) {
  const keiko_recovery_engine engine = {
      context,
      keiko_recovery_engine_append_receipt,
      keiko_recovery_engine_restore_platform,
      keiko_recovery_engine_restore_previous,
      keiko_recovery_engine_registration_is_prepared,
      keiko_recovery_engine_cleanup};
  return keiko_recovery_reconcile_engine(
      &engine,
      forward_count,
      restore_count,
      deadline_ms
  );
}

static int keiko_recovery_control_posix(const char *activation_id, const char *executable) {
  char content[KEIKO_RECOVERY_CONTROL_MAX_BYTES + 1u];
  keiko_recovery_control control;
  keiko_coordinator_context context;
  unsigned int forward_count, restore_count;
  uint64_t deadline = keiko_tree_now_ms() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  int prepared = 0, result = 0;
  memset(&control, 0, sizeof(control));
  if (!keiko_recovery_read_control(content, deadline) ||
      !keiko_recovery_parse_control(content, &control) ||
      strcmp(control.activation_id, activation_id) != 0 ||
      !keiko_recovery_prepare(&context, &control, activation_id, executable, deadline))
    return 0;
  prepared = 1;
  if (!keiko_recovery_load_receipts(&context, &control, deadline, &forward_count,
                                    &restore_count) ||
      !keiko_recovery_reconcile(&context, forward_count, restore_count, deadline))
    goto cleanup;
  result = 1;
cleanup:
  if (prepared) keiko_coordinator_clear(&context);
  memset(content, 0, sizeof(content));
  memset(&control, 0, sizeof(control));
  return result;
}

#else

#include "keiko-portable-recovery-control-windows.h"

#endif

#endif
