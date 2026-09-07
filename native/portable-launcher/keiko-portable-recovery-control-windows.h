#ifndef KEIKO_PORTABLE_RECOVERY_CONTROL_WINDOWS_H
#define KEIKO_PORTABLE_RECOVERY_CONTROL_WINDOWS_H

#if !defined(_WIN32)
#error "keiko-portable-recovery-control-windows.h requires Win32"
#endif

#include <windows.h>

#include <io.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static inline int keiko_recovery_read_control_windows(
    char content[KEIKO_RECOVERY_CONTROL_MAX_BYTES + 1u],
    uint64_t deadline_ms
) {
  HANDLE input = (HANDLE)_get_osfhandle(_fileno(stdin));
  size_t offset = 0;
  if (input == INVALID_HANDLE_VALUE || input == NULL) return 0;
  while (offset < KEIKO_RECOVERY_CONTROL_MAX_BYTES) {
    DWORD available = 0;
    int count;
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
      DWORD error = GetLastError();
      if ((error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) && offset > 0u) {
        content[offset] = '\0';
        return 1;
      }
      return 0;
    }
    if (available == 0) {
      if (GetTickCount64() > deadline_ms) return 0;
      Sleep(10);
      continue;
    }
    if (available > KEIKO_RECOVERY_CONTROL_MAX_BYTES - offset)
      available = (DWORD)(KEIKO_RECOVERY_CONTROL_MAX_BYTES - offset);
    count = _read(_fileno(stdin), content + offset, available);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 0;
}

static int keiko_recovery_validate_runtime_windows(
    const keiko_coordinator_context *context,
    const keiko_recovery_control *control,
    uint64_t deadline_ms
) {
  wchar_t *updates = keiko_windows_update_path_join(context->state_dir, L"\\updates");
  wchar_t *path = updates == NULL
      ? NULL
      : keiko_windows_update_path_join(updates, L"\\runtime-state.json");
  unsigned char *content = NULL;
  size_t length = 0;
  char actual[65];
  int result = path != NULL &&
               keiko_coordinator_windows_read_file(
                   path,
                   1024u * 1024u,
                   deadline_ms,
                   &content,
                   &length
               ) &&
               keiko_coordinator_windows_hash_bytes(content, length, actual) &&
               strcmp(actual, control->runtime_state_sha256) == 0;
  if (content != NULL) {
    SecureZeroMemory(content, length);
    free(content);
  }
  free(path);
  free(updates);
  return result;
}

static int keiko_recovery_validate_lock_windows(
    const keiko_coordinator_context *context,
    const keiko_recovery_control *control,
    uint64_t deadline_ms
) {
  wchar_t *updates = keiko_windows_update_path_join(context->state_dir, L"\\updates");
  wchar_t *lock_path = updates == NULL
      ? NULL
      : keiko_windows_update_path_join(updates, L"\\update-session.lock");
  wchar_t *child_stem = NULL;
  wchar_t *child_path = NULL;
  unsigned char *content = NULL;
  unsigned char *child = NULL;
  size_t length = 0;
  size_t child_length = 0;
  char session[257];
  char target[65];
  char started[65];
  char pid[32];
  char process_identity[257];
  char identity_json[1024];
  char actual_identity[65];
  char session_digest[65];
  char expected_child[1024];
  const char *cursor;
  const char *number_end;
  int written;
  int result = 0;
  if (lock_path == NULL ||
      !keiko_coordinator_windows_read_file(
          lock_path,
          4096u,
          deadline_ms,
          &content,
          &length
      )) goto cleanup;
  cursor = (const char *)content;
  if (!keiko_recovery_copy_json_value(
          &cursor,
          "{\"sessionId\":\"",
          session,
          sizeof(session)
      ) ||
      strcmp(session, context->plan.field[KEIKO_KHP_SESSION_ID]) != 0 ||
      !keiko_recovery_copy_json_value(
          &cursor,
          ",\"targetVersion\":\"",
          target,
          sizeof(target)
      ) ||
      strcmp(target, context->plan.field[KEIKO_KHP_TARGET_VERSION]) != 0 ||
      !keiko_recovery_copy_json_value(
          &cursor,
          ",\"startedAt\":\"",
          started,
          sizeof(started)
      ) ||
      strncmp(cursor, ",\"pid\":", 7u) != 0) goto cleanup;
  cursor += 7u;
  number_end = cursor;
  while (*number_end >= '0' && *number_end <= '9') ++number_end;
  if (number_end == cursor || (size_t)(number_end - cursor) >= sizeof(pid)) goto cleanup;
  memcpy(pid, cursor, (size_t)(number_end - cursor));
  pid[number_end - cursor] = '\0';
  cursor = number_end;
  if (strncmp(cursor, ",\"childPid\":", 12u) == 0) {
    cursor += 12u;
    number_end = cursor;
    while (*number_end >= '0' && *number_end <= '9') ++number_end;
    if (number_end == cursor) goto cleanup;
    cursor = number_end;
  }
  if (!keiko_recovery_copy_json_value(
          &cursor,
          ",\"processIdentity\":\"",
          process_identity,
          sizeof(process_identity)
      ) ||
      strcmp(cursor, "}\n") != 0) goto cleanup;
  written = snprintf(
      identity_json,
      sizeof(identity_json),
      "{\"sessionId\":\"%s\",\"targetVersion\":\"%s\","
      "\"startedAt\":\"%s\",\"pid\":%s,\"processIdentity\":\"%s\"}",
      session,
      target,
      started,
      pid,
      process_identity
  );
  if (written <= 0 || (size_t)written >= sizeof(identity_json) ||
      !keiko_coordinator_windows_hash_bytes(
          identity_json,
          (size_t)written,
          actual_identity
      ) ||
      strcmp(actual_identity, control->lock_identity) != 0 ||
      !keiko_coordinator_windows_hash_bytes(
          session,
          strlen(session),
          session_digest
      )) goto cleanup;
  child_stem = keiko_coordinator_windows_ascii_path(
      updates,
      L"\\update-session.lock.",
      session_digest
  );
  if (child_stem != NULL)
    child_path = keiko_windows_update_path_join(child_stem, L".child");
  if (child_path == NULL ||
      !keiko_coordinator_windows_read_file(
          child_path,
          1024u,
          deadline_ms,
          &child,
          &child_length
      )) goto cleanup;
  written = snprintf(
      expected_child,
      sizeof(expected_child),
      "{\"sessionId\":\"%s\",\"lockIdentity\":\"%s\",\"childPid\":%lu}\n",
      session,
      control->lock_identity,
      (unsigned long)GetCurrentProcessId()
  );
  if (written <= 0 || (size_t)written != child_length ||
      memcmp(child, expected_child, child_length) != 0) goto cleanup;
  result = 1;
cleanup:
  if (content != NULL) {
    SecureZeroMemory(content, length);
    free(content);
  }
  if (child != NULL) {
    SecureZeroMemory(child, child_length);
    free(child);
  }
  SecureZeroMemory(identity_json, sizeof(identity_json));
  SecureZeroMemory(expected_child, sizeof(expected_child));
  free(child_path);
  free(child_stem);
  free(lock_path);
  free(updates);
  return result;
}

static int keiko_recovery_prepare_windows(
    keiko_coordinator_context *context,
    const keiko_recovery_control *control,
    const char *activation_id,
    const wchar_t *executable,
    uint64_t deadline_ms
) {
  DWORD state_length;
  wchar_t *state = NULL;
  wchar_t *handoff = NULL;
  wchar_t *expected_executable = NULL;
  int result = 0;
  memset(context, 0, sizeof(*context));
  context->supervisor_control = -1;
  context->supervisor_response = -1;
  context->start_gate = -1;
  state_length = GetEnvironmentVariableW(L"KEIKO_STATE_DIR", NULL, 0);
  if (state_length == 0 || state_length > KEIKO_WINDOWS_UPDATE_PATH_CAP) return 0;
  state = (wchar_t *)calloc((size_t)state_length, sizeof(wchar_t));
  if (state == NULL ||
      GetEnvironmentVariableW(L"KEIKO_STATE_DIR", state, state_length) != state_length - 1u)
    goto cleanup;
  handoff = keiko_windows_update_path_join(state, L"\\updates\\handoff\\");
  if (handoff != NULL)
    context->capsule = keiko_coordinator_windows_ascii_path(handoff, L"", activation_id);
  context->state_dir = state;
  state = NULL;
  context->state_dir_utf8 = keiko_coordinator_windows_utf8_wide(context->state_dir);
  if (context->capsule != NULL)
    expected_executable = keiko_windows_update_path_join(
        context->capsule,
        L"\\coordinator.exe"
    );
  if (context->state_dir_utf8 == NULL ||
      !keiko_khp_is_absolute_canonical_path(context->state_dir_utf8) ||
      expected_executable == NULL || wcscmp(expected_executable, executable) != 0 ||
      !keiko_coordinator_windows_load_plan(context, activation_id, deadline_ms) ||
      strcmp(context->plan_sha256, control->plan_sha256) != 0 ||
      !keiko_windows_update_file_digest_matches(
          executable,
          control->coordinator_sha256,
          deadline_ms
      ) ||
      !keiko_recovery_validate_runtime_windows(context, control, deadline_ms) ||
      !keiko_recovery_validate_lock_windows(context, control, deadline_ms)) goto cleanup;
  result = 1;
cleanup:
  free(expected_executable);
  free(handoff);
  free(state);
  if (!result) keiko_coordinator_clear(context);
  return result;
}

static int keiko_recovery_load_receipts_windows(
    keiko_coordinator_context *context,
    const keiko_recovery_control *control,
    uint64_t deadline_ms,
    unsigned int *forward_count,
    unsigned int *restore_count
) {
  int restoring = 0;
  *forward_count = 0u;
  *restore_count = 0u;
  while (keiko_coordinator_windows_next_receipt_exists(context)) {
    const char *kind;
    const char *outcome;
    if (context->receipt_sequence >= KEIKO_RECOVERY_MAX_RECEIPTS) return 0;
    if (!restoring &&
        keiko_recovery_forward_expected(*forward_count, &kind, &outcome) &&
        keiko_coordinator_windows_read_expected_receipt(
            context,
            kind,
            outcome,
            deadline_ms
        )) {
      *forward_count += 1u;
    } else {
      if (!restoring) {
        if (!keiko_recovery_may_begin_restore(*forward_count)) return 0;
        restoring = 1;
      }
      if (!keiko_recovery_restore_expected(*restore_count, &kind, &outcome) ||
          !keiko_coordinator_windows_read_expected_receipt(
              context,
              kind,
              outcome,
              deadline_ms
          )) return 0;
      *restore_count += 1u;
    }
    if (context->receipt_sequence == control->receipt_sequence &&
        strcmp(context->receipt_sha256, control->receipt_sha256) != 0) return 0;
  }
  return context->receipt_sequence >= control->receipt_sequence &&
         (control->receipt_sequence != 0u || strcmp(control->receipt_sha256, "-") == 0);
}

static int keiko_recovery_append_receipt_windows(
    void *opaque,
    const char *kind,
    const char *outcome
) {
  return keiko_coordinator_windows_append_receipt(
      (keiko_coordinator_context *)opaque,
      kind,
      outcome
  );
}

static int keiko_recovery_restore_platform_windows(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_restore_platform_windows(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_recovery_restore_previous_windows(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_restore_previous_windows(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_recovery_registration_is_prepared_windows(
    void *opaque,
    uint64_t deadline_ms
) {
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  return keiko_coordinator_windows_classify(
             (keiko_coordinator_context *)opaque,
             deadline_ms,
             &prefix
         ) &&
         (prefix == KEIKO_WINDOWS_PREFIX_REGISTRATION ||
          prefix == KEIKO_WINDOWS_PREFIX_CLEANED);
}

static int keiko_recovery_cleanup_windows(void *opaque, uint64_t deadline_ms) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  keiko_coordinator_windows_paths paths;
  wchar_t *stage = NULL;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  int result = 0;
  memset(&paths, 0, sizeof(paths));
  if (!keiko_coordinator_windows_paths_build(context, &paths) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      (prefix != KEIKO_WINDOWS_PREFIX_REGISTRATION &&
       prefix != KEIKO_WINDOWS_PREFIX_CLEANED)) goto cleanup;
  stage = keiko_coordinator_windows_wide_utf8(context->plan.field[KEIKO_KHP_STAGE_ROOT]);
  if (stage == NULL ||
      !keiko_coordinator_windows_remove_tree_if_present(
          paths.current_generation,
          deadline_ms
      ) ||
      !keiko_coordinator_windows_remove_tree_if_present(
          paths.incoming_generation,
          deadline_ms
      ) ||
      !keiko_coordinator_windows_remove_tree_if_present(stage, deadline_ms) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix != KEIKO_WINDOWS_PREFIX_CLEANED) goto cleanup;
  result = 1;
cleanup:
  free(stage);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

static int keiko_recovery_reconcile_windows(
    keiko_coordinator_context *context,
    unsigned int forward_count,
    unsigned int restore_count,
    uint64_t deadline_ms
) {
  const keiko_recovery_engine engine = {
      context,
      keiko_recovery_append_receipt_windows,
      keiko_recovery_restore_platform_windows,
      keiko_recovery_restore_previous_windows,
      keiko_recovery_registration_is_prepared_windows,
      keiko_recovery_cleanup_windows};
  return keiko_recovery_reconcile_engine(
      &engine,
      forward_count,
      restore_count,
      deadline_ms
  );
}

static inline int keiko_recovery_control_windows(
    const char *activation_id,
    const wchar_t *executable
) {
  char content[KEIKO_RECOVERY_CONTROL_MAX_BYTES + 1u];
  keiko_recovery_control control;
  keiko_coordinator_context context;
  unsigned int forward_count;
  unsigned int restore_count;
  uint64_t deadline = (uint64_t)GetTickCount64() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  int prepared = 0;
  int result = 0;
  memset(content, 0, sizeof(content));
  memset(&control, 0, sizeof(control));
  if (!keiko_recovery_read_control_windows(content, deadline) ||
      !keiko_recovery_parse_control(content, &control) ||
      strcmp(control.activation_id, activation_id) != 0 ||
      !keiko_recovery_prepare_windows(
          &context,
          &control,
          activation_id,
          executable,
          deadline
      )) goto cleanup;
  prepared = 1;
  if (!keiko_recovery_load_receipts_windows(
          &context,
          &control,
          deadline,
          &forward_count,
          &restore_count
      ) ||
      !keiko_recovery_reconcile_windows(
          &context,
          forward_count,
          restore_count,
          deadline
      )) goto cleanup;
  result = 1;
cleanup:
  if (prepared) keiko_coordinator_clear(&context);
  SecureZeroMemory(content, sizeof(content));
  SecureZeroMemory(&control, sizeof(control));
  return result;
}

#endif
