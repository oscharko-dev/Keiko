#ifndef KEIKO_PORTABLE_UPDATE_COORDINATOR_WINDOWS_H
#define KEIKO_PORTABLE_UPDATE_COORDINATOR_WINDOWS_H

#if !defined(_WIN32)
#error "keiko-portable-update-coordinator-windows.h requires Win32"
#endif

#include "keiko-portable-update-windows-mechanics.h"

#include <windows.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <tlhelp32.h>

#ifndef KEIKO_COORDINATOR_CUTOVER_CHECKPOINT
#define KEIKO_COORDINATOR_CUTOVER_CHECKPOINT(name) (1)
#endif

#define KEIKO_COORDINATOR_MAX_CONTROL_MS (15u * 60u * 1000u)
#define KEIKO_COORDINATOR_RECEIPT_MAX_BYTES 4096u

typedef struct {
  keiko_handoff_plan plan;
  wchar_t *state_dir;
  wchar_t *capsule;
  char *state_dir_utf8;
  char plan_sha256[65];
  char receipt_sha256[65];
  unsigned int receipt_sequence;
  uint64_t old_exit_deadline;
  HANDLE supervisor_process;
  int supervisor_control;
  int supervisor_response;
  int start_gate;
} keiko_coordinator_context;

typedef struct {
  wchar_t *managed;
  wchar_t *candidate;
  wchar_t *portable;
  wchar_t *generations;
  wchar_t *current_generation;
  wchar_t *candidate_source_generation;
  wchar_t *incoming_generation;
  wchar_t *candidate_generation;
  wchar_t *launcher;
  wchar_t *setup;
  wchar_t *current_supervisor;
  wchar_t *candidate_supervisor;
} keiko_coordinator_windows_paths;

static wchar_t *keiko_coordinator_windows_wide_utf8(const char *value) {
  int length;
  wchar_t *wide;
  if (value == NULL) return NULL;
  length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, NULL, 0);
  if (length <= 0) return NULL;
  wide = (wchar_t *)calloc((size_t)length, sizeof(wchar_t));
  if (wide == NULL || MultiByteToWideChar(
                          CP_UTF8,
                          MB_ERR_INVALID_CHARS,
                          value,
                          -1,
                          wide,
                          length
                      ) != length) {
    free(wide);
    return NULL;
  }
  return wide;
}

static char *keiko_coordinator_windows_utf8_wide(const wchar_t *value) {
  int length;
  char *utf8;
  if (value == NULL) return NULL;
  length = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value,
      -1,
      NULL,
      0,
      NULL,
      NULL
  );
  if (length <= 0) return NULL;
  utf8 = (char *)calloc((size_t)length, 1u);
  if (utf8 == NULL || WideCharToMultiByte(
                          CP_UTF8,
                          WC_ERR_INVALID_CHARS,
                          value,
                          -1,
                          utf8,
                          length,
                          NULL,
                          NULL
                      ) != length) {
    free(utf8);
    return NULL;
  }
  return utf8;
}

static wchar_t *keiko_coordinator_windows_ascii_path(
    const wchar_t *base,
    const wchar_t *prefix,
    const char *ascii
) {
  wchar_t *wide = keiko_coordinator_windows_wide_utf8(ascii);
  wchar_t *first = NULL;
  wchar_t *result = NULL;
  if (wide != NULL) first = keiko_windows_update_path_join(base, prefix);
  if (first != NULL) result = keiko_windows_update_path_join(first, wide);
  free(first);
  free(wide);
  return result;
}

static uint64_t keiko_coordinator_windows_wall_ms(void) {
  FILETIME now;
  ULARGE_INTEGER ticks;
  GetSystemTimeAsFileTime(&now);
  ticks.LowPart = now.dwLowDateTime;
  ticks.HighPart = now.dwHighDateTime;
  if (ticks.QuadPart < UINT64_C(116444736000000000)) return UINT64_MAX;
  return (ticks.QuadPart - UINT64_C(116444736000000000)) / UINT64_C(10000);
}

static int keiko_coordinator_windows_read_file(
    const wchar_t *path,
    size_t maximum,
    uint64_t deadline_ms,
    unsigned char **output,
    size_t *output_length
);

static int keiko_coordinator_windows_deadline(
    keiko_coordinator_context *context,
    int field,
    uint64_t *deadline_ms
) {
  uint64_t wall_deadline;
  uint64_t wall_now = keiko_coordinator_windows_wall_ms();
  uint64_t monotonic_now = (uint64_t)GetTickCount64();
  if (!keiko_khp_decimal_value(
          context->plan.field[field],
          UINT64_C(9007199254740991),
          &wall_deadline
      ) ||
      wall_now == UINT64_MAX || wall_deadline < wall_now ||
      wall_deadline - wall_now > KEIKO_COORDINATOR_MAX_CONTROL_MS ||
      monotonic_now > UINT64_MAX - (wall_deadline - wall_now)) return 0;
  *deadline_ms = monotonic_now + (wall_deadline - wall_now);
  return 1;
}

static int keiko_coordinator_windows_read_exact_fd(
    int descriptor,
    void *output,
    size_t length,
    uint64_t deadline_ms
) {
  size_t offset = 0;
  while (offset < length) {
    int count;
    if (GetTickCount64() > deadline_ms || length - offset > INT_MAX) return 0;
    count = _read(descriptor, (unsigned char *)output + offset, (unsigned int)(length - offset));
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int keiko_coordinator_windows_parent_pid(DWORD *parent_pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W entry;
  int result = 0;
  if (snapshot == INVALID_HANDLE_VALUE || snapshot == NULL) return 0;
  memset(&entry, 0, sizeof(entry));
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == GetCurrentProcessId()) {
        *parent_pid = entry.th32ParentProcessID;
        result = 1;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

static int keiko_coordinator_windows_parent_control(
    const keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  char control[65];
  return keiko_coordinator_windows_read_exact_fd(
             _fileno(stdin),
             control,
             sizeof(control),
             deadline_ms
         ) &&
         control[64] == '\n' && memcmp(control, context->plan_sha256, 64u) == 0;
}

static int keiko_coordinator_windows_ui_identity(
    const keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  wchar_t *path = keiko_windows_update_path_join(context->state_dir, L"\\ui.pid");
  unsigned char *content = NULL;
  size_t length = 0;
  char expected[512];
  int expected_length = snprintf(
      expected,
      sizeof(expected),
      "%s\n%s\n",
      context->plan.field[KEIKO_KHP_OLD_PID],
      context->plan.field[KEIKO_KHP_OLD_LAUNCH_ID]
  );
  int result = path != NULL && expected_length > 0 &&
               (size_t)expected_length < sizeof(expected) &&
               keiko_coordinator_windows_read_file(
                   path,
                   sizeof(expected),
                   deadline_ms,
                   &content,
                   &length
               ) &&
               length == (size_t)expected_length &&
               memcmp(content, expected, length) == 0;
  if (content != NULL) {
    SecureZeroMemory(content, length);
    free(content);
  }
  free(path);
  return result;
}

static int keiko_coordinator_windows_roots_same_volume(
    const keiko_coordinator_context *context
) {
  wchar_t *managed = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_MANAGED_ROOT]
  );
  wchar_t *stage = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_STAGE_ROOT]
  );
  HANDLE managed_handle = INVALID_HANDLE_VALUE;
  HANDLE stage_handle = INVALID_HANDLE_VALUE;
  keiko_windows_atomic_file_fact managed_fact;
  keiko_windows_atomic_file_fact stage_fact;
  int result = 0;
  if (managed != NULL)
    managed_handle = keiko_windows_atomic_open_directory(
        managed,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ
    );
  if (stage != NULL)
    stage_handle = keiko_windows_atomic_open_directory(
        stage,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ
    );
  result = managed_handle != INVALID_HANDLE_VALUE && managed_handle != NULL &&
           stage_handle != INVALID_HANDLE_VALUE && stage_handle != NULL &&
           keiko_windows_atomic_query_fact(managed_handle, &managed_fact) &&
           keiko_windows_atomic_query_fact(stage_handle, &stage_fact) &&
           managed_fact.identity.VolumeSerialNumber == stage_fact.identity.VolumeSerialNumber;
  if (stage_handle != INVALID_HANDLE_VALUE && stage_handle != NULL) CloseHandle(stage_handle);
  if (managed_handle != INVALID_HANDLE_VALUE && managed_handle != NULL)
    CloseHandle(managed_handle);
  free(stage);
  free(managed);
  return result;
}

static int keiko_coordinator_windows_registration_matches(
    const keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  wchar_t *registration = keiko_windows_update_path_join(
      context->state_dir,
      L"\\portable-install-state.json"
  );
  int result = strcmp(
                   context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_STATE],
                   "present"
               ) == 0 &&
               registration != NULL &&
               keiko_windows_update_file_digest_matches(
                   registration,
                   context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256],
                   deadline_ms
               );
  free(registration);
  return result;
}

static int keiko_coordinator_windows_hash_bytes(
    const void *content,
    size_t length,
    char output[65]
) {
  keiko_sha256 hash;
  unsigned char digest[32];
  if (!keiko_sha256_init(&hash) || !keiko_sha256_update(&hash, content, length) ||
      !keiko_sha256_final(&hash, digest)) return 0;
  keiko_sha256_hex(digest, output);
  SecureZeroMemory(digest, sizeof(digest));
  return 1;
}

static int keiko_coordinator_windows_read_file(
    const wchar_t *path,
    size_t maximum,
    uint64_t deadline_ms,
    unsigned char **output,
    size_t *output_length
) {
  HANDLE file = keiko_windows_atomic_open_regular(path, GENERIC_READ, FILE_SHARE_READ);
  keiko_windows_atomic_file_fact before;
  keiko_windows_atomic_file_fact after;
  unsigned char *content = NULL;
  size_t offset = 0;
  int result = 0;
  if (file == INVALID_HANDLE_VALUE || file == NULL ||
      !keiko_windows_atomic_query_fact(file, &before) ||
      before.standard.EndOfFile.QuadPart < 0 ||
      (uint64_t)before.standard.EndOfFile.QuadPart > maximum) goto cleanup;
  content = (unsigned char *)malloc((size_t)before.standard.EndOfFile.QuadPart + 1u);
  if (content == NULL) goto cleanup;
  while (offset < (size_t)before.standard.EndOfFile.QuadPart) {
    DWORD read_bytes = 0;
    DWORD remaining = (DWORD)((size_t)before.standard.EndOfFile.QuadPart - offset);
    if (GetTickCount64() > deadline_ms ||
        !ReadFile(file, content + offset, remaining, &read_bytes, NULL) || read_bytes == 0) {
      goto cleanup;
    }
    offset += read_bytes;
  }
  if (!keiko_windows_atomic_query_fact(file, &after) ||
      !keiko_windows_atomic_same_file(&before, &after)) goto cleanup;
  content[offset] = 0;
  *output = content;
  *output_length = offset;
  content = NULL;
  result = 1;
cleanup:
  if (content != NULL) {
    SecureZeroMemory(content, offset);
    free(content);
  }
  if (file != INVALID_HANDLE_VALUE && file != NULL) CloseHandle(file);
  return result;
}

static int keiko_coordinator_windows_load_plan(
    keiko_coordinator_context *context,
    const char *activation_id,
    uint64_t deadline_ms
) {
  wchar_t *plan_path = keiko_windows_update_path_join(context->capsule, L"\\plan.khp");
  wchar_t *digest_path = keiko_windows_update_path_join(context->capsule, L"\\plan.sha256");
  unsigned char *plan_content = NULL;
  unsigned char *digest_content = NULL;
  size_t plan_length = 0;
  size_t digest_length = 0;
  char actual[65];
  int result = 0;
  if (plan_path == NULL || digest_path == NULL ||
      !keiko_coordinator_windows_read_file(
          plan_path,
          KEIKO_KHP_MAX_BYTES,
          deadline_ms,
          &plan_content,
          &plan_length
      ) ||
      !keiko_coordinator_windows_read_file(
          digest_path,
          65u,
          deadline_ms,
          &digest_content,
          &digest_length
      ) ||
      digest_length != 65u || digest_content[64] != '\n' ||
      memchr(digest_content, 0, 64u) != NULL) goto cleanup;
  digest_content[64] = 0;
  if (!keiko_khp_is_lower_hex((const char *)digest_content, 64u) ||
      !keiko_coordinator_windows_hash_bytes(plan_content, plan_length, actual) ||
      strcmp(actual, (const char *)digest_content) != 0 ||
      !keiko_khp_parse(plan_content, plan_length, &context->plan) ||
      strcmp(context->plan.field[KEIKO_KHP_ACTIVATION_ID], activation_id) != 0) goto cleanup;
  memcpy(context->plan_sha256, actual, sizeof(context->plan_sha256));
  result = 1;
cleanup:
  if (plan_content != NULL) {
    SecureZeroMemory(plan_content, plan_length);
    free(plan_content);
  }
  if (digest_content != NULL) {
    SecureZeroMemory(digest_content, digest_length);
    free(digest_content);
  }
  free(digest_path);
  free(plan_path);
  if (!result) keiko_khp_clear(&context->plan);
  return result;
}

static void keiko_coordinator_windows_paths_clear(
    keiko_coordinator_windows_paths *paths
) {
  free(paths->candidate_supervisor);
  free(paths->current_supervisor);
  free(paths->setup);
  free(paths->launcher);
  free(paths->candidate_generation);
  free(paths->incoming_generation);
  free(paths->candidate_source_generation);
  free(paths->current_generation);
  free(paths->generations);
  free(paths->portable);
  free(paths->candidate);
  free(paths->managed);
  memset(paths, 0, sizeof(*paths));
}

static int keiko_coordinator_windows_paths_build(
    const keiko_coordinator_context *context,
    keiko_coordinator_windows_paths *paths
) {
  memset(paths, 0, sizeof(*paths));
  paths->managed = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_MANAGED_ROOT]
  );
  paths->candidate = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_CANDIDATE_ROOT]
  );
  if (paths->managed != NULL)
    paths->portable = keiko_windows_update_path_join(paths->managed, L"\\.portable");
  if (paths->portable != NULL)
    paths->generations = keiko_windows_update_path_join(
        paths->portable,
        L"\\generations"
    );
  if (paths->generations != NULL) {
    paths->current_generation = keiko_coordinator_windows_ascii_path(
        paths->generations,
        L"\\",
        context->plan.field[KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256]
    );
    paths->incoming_generation = keiko_coordinator_windows_ascii_path(
        paths->generations,
        L"\\.incoming-",
        context->plan.field[KEIKO_KHP_ACTIVATION_ID]
    );
    paths->candidate_generation = keiko_coordinator_windows_ascii_path(
        paths->generations,
        L"\\",
        context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256]
    );
  }
  if (paths->candidate != NULL) {
    wchar_t *candidate_portable = keiko_windows_update_path_join(
        paths->candidate,
        L"\\.portable\\generations"
    );
    if (candidate_portable != NULL) {
      paths->candidate_source_generation = keiko_coordinator_windows_ascii_path(
          candidate_portable,
          L"\\",
          context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256]
      );
      free(candidate_portable);
    }
  }
  if (paths->managed != NULL)
    paths->launcher = keiko_windows_update_path_join(paths->managed, L"\\Keiko.exe");
  if (paths->portable != NULL)
    paths->setup = keiko_windows_update_path_join(
        paths->portable,
        L"\\setup-manifest.json"
    );
  if (paths->current_generation != NULL)
    paths->current_supervisor = keiko_windows_update_path_join(
        paths->current_generation,
        L"\\runtime\\native\\keiko-runtime-supervisor.exe"
    );
  if (paths->candidate_generation != NULL)
    paths->candidate_supervisor = keiko_windows_update_path_join(
        paths->candidate_generation,
        L"\\runtime\\native\\keiko-runtime-supervisor.exe"
    );
  if (paths->managed == NULL || paths->candidate == NULL || paths->portable == NULL ||
      paths->generations == NULL || paths->current_generation == NULL ||
      paths->candidate_source_generation == NULL || paths->incoming_generation == NULL ||
      paths->candidate_generation == NULL || paths->launcher == NULL || paths->setup == NULL ||
      paths->current_supervisor == NULL || paths->candidate_supervisor == NULL) {
    keiko_coordinator_windows_paths_clear(paths);
    return 0;
  }
  return 1;
}

static int keiko_coordinator_windows_absent(const wchar_t *path) {
  return keiko_windows_atomic_destination_absent(path);
}

static int keiko_coordinator_windows_snapshot_matches(
    const keiko_coordinator_context *context,
    const wchar_t *name,
    const char *digest,
    uint64_t deadline_ms
) {
  wchar_t *path = keiko_windows_update_path_join(context->capsule, name);
  int result = path != NULL && keiko_windows_update_file_digest_matches(
      path,
      digest,
      deadline_ms
  );
  free(path);
  return result;
}

static int keiko_coordinator_windows_preacceptance(
    keiko_coordinator_context *context,
    const wchar_t *executable,
    uint64_t deadline_ms
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *backup = NULL;
  wchar_t *candidate_launcher = NULL;
  wchar_t *candidate_supervisor = NULL;
  int result = 0;
  if (!keiko_coordinator_windows_paths_build(context, &paths)) return 0;
  backup = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_BACKUP_ROOT]
  );
  candidate_launcher = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER]
  );
  candidate_supervisor = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_CANDIDATE_SUPERVISOR]
  );
  if (backup == NULL || candidate_launcher == NULL || candidate_supervisor == NULL ||
      !keiko_coordinator_windows_absent(backup) ||
      !keiko_coordinator_windows_absent(paths.incoming_generation) ||
      !keiko_coordinator_windows_absent(paths.candidate_generation) ||
      !keiko_windows_update_tree_digest_matches(
          paths.managed,
          context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_tree_digest_matches(
          paths.candidate,
          context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_tree_digest_matches(
          paths.current_generation,
          context->plan.field[KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_tree_digest_matches(
          paths.candidate_source_generation,
          context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          executable,
          context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.launcher,
          context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.setup,
          context->plan.field[KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.current_supervisor,
          context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          candidate_launcher,
          context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          candidate_supervisor,
          context->plan.field[KEIKO_KHP_CANDIDATE_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\coordinator.exe",
          context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\runtime-supervisor.exe",
          context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\launcher.next",
          context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\setup-manifest.previous",
          context->plan.field[KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\setup-manifest.next",
          context->plan.field[KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\registration.previous",
          context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_snapshot_matches(
          context,
          L"\\registration.next",
          context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256],
          deadline_ms
      )) goto cleanup;
  result = 1;
cleanup:
  free(candidate_supervisor);
  free(candidate_launcher);
  free(backup);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

static inline void keiko_coordinator_clear(keiko_coordinator_context *context) {
  if (context == NULL) return;
  if (context->supervisor_control >= 0) _close(context->supervisor_control);
  if (context->supervisor_response >= 0) _close(context->supervisor_response);
  if (context->start_gate >= 0) _close(context->start_gate);
  if (context->supervisor_process != NULL &&
      context->supervisor_process != INVALID_HANDLE_VALUE) {
    CloseHandle(context->supervisor_process);
  }
  keiko_khp_clear(&context->plan);
  free(context->state_dir_utf8);
  free(context->capsule);
  free(context->state_dir);
  SecureZeroMemory(context, sizeof(*context));
}

static inline int keiko_coordinator_prepare_windows(
    keiko_coordinator_context *context,
    const char *activation_id,
    const wchar_t *executable
) {
  DWORD state_length;
  wchar_t *state = NULL;
  wchar_t *handoff = NULL;
  wchar_t *expected_executable = NULL;
  uint64_t deadline = (uint64_t)GetTickCount64() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  uint64_t plan_deadline;
  uint64_t old_pid;
  DWORD parent_pid;
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
  if (context->state_dir_utf8 == NULL || expected_executable == NULL ||
      wcscmp(expected_executable, executable) != 0 ||
      !keiko_coordinator_windows_load_plan(context, activation_id, deadline) ||
      !keiko_coordinator_windows_deadline(context, KEIKO_KHP_OLD_EXIT_AT, &plan_deadline) ||
      (context->old_exit_deadline = plan_deadline) == 0 ||
      !keiko_coordinator_windows_deadline(context, KEIKO_KHP_START_AT, &plan_deadline) ||
      !keiko_coordinator_windows_deadline(context, KEIKO_KHP_VERIFY_AT, &plan_deadline) ||
      !keiko_coordinator_windows_deadline(context, KEIKO_KHP_CLEANUP_AT, &plan_deadline) ||
      !keiko_khp_decimal_value(
          context->plan.field[KEIKO_KHP_OLD_PID],
          UINT32_MAX,
          &old_pid
      ) ||
      !keiko_coordinator_windows_parent_pid(&parent_pid) || old_pid != parent_pid ||
      !keiko_coordinator_windows_parent_control(context, deadline) ||
      !keiko_coordinator_windows_ui_identity(context, deadline) ||
      !keiko_coordinator_windows_registration_matches(context, deadline) ||
      !keiko_coordinator_windows_roots_same_volume(context) ||
      !keiko_coordinator_windows_preacceptance(context, executable, deadline)) goto cleanup;
  result = 1;
cleanup:
  free(expected_executable);
  free(handoff);
  free(state);
  if (!result) keiko_coordinator_clear(context);
  return result;
}

static int keiko_coordinator_windows_append_field(
    unsigned char *content,
    size_t capacity,
    size_t *offset,
    const char *value
) {
  size_t length = strlen(value);
  if (length > UINT32_MAX || *offset > capacity || capacity - *offset < 4u + length)
    return 0;
  content[*offset] = (unsigned char)length;
  content[*offset + 1u] = (unsigned char)(length >> 8);
  content[*offset + 2u] = (unsigned char)(length >> 16);
  content[*offset + 3u] = (unsigned char)(length >> 24);
  *offset += 4u;
  memcpy(content + *offset, value, length);
  *offset += length;
  return 1;
}

static int keiko_coordinator_windows_append_receipt(
    keiko_coordinator_context *context,
    const char *kind,
    const char *outcome
) {
  unsigned char content[KEIKO_COORDINATOR_RECEIPT_MAX_BYTES] = {
      'K', 'H', 'R', '1', 1, 0, 7, 0};
  char sequence[32];
  char timestamp[32];
  char digest[65];
  wchar_t filename[32];
  wchar_t *receipts = NULL;
  wchar_t *path = NULL;
  HANDLE file = INVALID_HANDLE_VALUE;
  DWORD written = 0;
  size_t offset = 8u;
  uint64_t now = keiko_coordinator_windows_wall_ms();
  const char *previous = context->receipt_sequence == 0u ? "" : context->receipt_sha256;
  int result = 0;
  if (now == UINT64_MAX ||
      snprintf(sequence, sizeof(sequence), "%u", context->receipt_sequence + 1u) <= 0 ||
      snprintf(timestamp, sizeof(timestamp), "%llu", (unsigned long long)now) <= 0 ||
      _snwprintf_s(
          filename,
          sizeof(filename) / sizeof(filename[0]),
          _TRUNCATE,
          L"\\%06u.khr",
          context->receipt_sequence + 1u
      ) <= 0 ||
      !keiko_coordinator_windows_append_field(
          content,
          sizeof(content),
          &offset,
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]
      ) ||
      !keiko_coordinator_windows_append_field(
          content,
          sizeof(content),
          &offset,
          context->plan_sha256
      ) ||
      !keiko_coordinator_windows_append_field(content, sizeof(content), &offset, sequence) ||
      !keiko_coordinator_windows_append_field(content, sizeof(content), &offset, kind) ||
      !keiko_coordinator_windows_append_field(content, sizeof(content), &offset, outcome) ||
      !keiko_coordinator_windows_append_field(content, sizeof(content), &offset, timestamp) ||
      !keiko_coordinator_windows_append_field(content, sizeof(content), &offset, previous) ||
      !keiko_coordinator_windows_hash_bytes(content, offset, digest)) goto cleanup;
  receipts = keiko_windows_update_path_join(context->capsule, L"\\receipts");
  if (receipts == NULL ||
      (!CreateDirectoryW(receipts, NULL) && GetLastError() != ERROR_ALREADY_EXISTS)) goto cleanup;
  path = keiko_windows_update_path_join(receipts, filename);
  if (path == NULL) goto cleanup;
  file = CreateFileW(
      path,
      GENERIC_WRITE,
      0,
      NULL,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  if (file == INVALID_HANDLE_VALUE || file == NULL ||
      !WriteFile(file, content, (DWORD)offset, &written, NULL) ||
      written != offset || !FlushFileBuffers(file)) goto cleanup;
  if (!CloseHandle(file)) {
    file = INVALID_HANDLE_VALUE;
    goto cleanup;
  }
  file = INVALID_HANDLE_VALUE;
  memcpy(context->receipt_sha256, digest, sizeof(context->receipt_sha256));
  context->receipt_sequence += 1u;
  result = 1;
cleanup:
  if (file != INVALID_HANDLE_VALUE && file != NULL) CloseHandle(file);
  free(path);
  free(receipts);
  SecureZeroMemory(content, sizeof(content));
  return result;
}

static inline int keiko_coordinator_promote_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *launcher_snapshot = NULL;
  wchar_t *setup_snapshot = NULL;
  wchar_t *launcher_temporary = NULL;
  wchar_t *setup_temporary = NULL;
  int result = 0;
  if (!keiko_coordinator_windows_paths_build(context, &paths)) return 0;
  launcher_snapshot = keiko_windows_update_path_join(context->capsule, L"\\launcher.next");
  setup_snapshot = keiko_windows_update_path_join(
      context->capsule,
      L"\\setup-manifest.next"
  );
  launcher_temporary = keiko_coordinator_windows_ascii_path(
      paths.managed,
      L"\\.launcher-",
      context->plan.field[KEIKO_KHP_ACTIVATION_ID]
  );
  setup_temporary = keiko_coordinator_windows_ascii_path(
      paths.portable,
      L"\\.setup-",
      context->plan.field[KEIKO_KHP_ACTIVATION_ID]
  );
  if (launcher_snapshot == NULL || setup_snapshot == NULL || launcher_temporary == NULL ||
      setup_temporary == NULL ||
      !keiko_coordinator_windows_append_receipt(context, "promote", "intent") ||
      !keiko_windows_update_copy_publish_generation(
          paths.candidate_source_generation,
          paths.generations,
          paths.incoming_generation,
          paths.candidate_generation,
          context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256],
          deadline_ms
      ) ||
      !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("windows-promote-after-generation") ||
      !keiko_windows_update_replace_file(
          launcher_snapshot,
          paths.managed,
          launcher_temporary,
          paths.launcher,
          context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("windows-promote-after-launcher") ||
      !keiko_windows_update_replace_file(
          setup_snapshot,
          paths.portable,
          setup_temporary,
          paths.setup,
          context->plan.field[KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256],
          deadline_ms
      ) ||
      !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("windows-promote-after-setup") ||
      !keiko_windows_update_tree_digest_matches(
          paths.candidate_generation,
          context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.launcher,
          context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.setup,
          context->plan.field[KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.candidate_supervisor,
          context->plan.field[KEIKO_KHP_CANDIDATE_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_append_receipt(context, "promote", "completed")) goto cleanup;
  result = 1;
cleanup:
  free(setup_temporary);
  free(launcher_temporary);
  free(setup_snapshot);
  free(launcher_snapshot);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

enum keiko_coordinator_windows_authority {
  KEIKO_WINDOWS_AUTHORITY_INVALID = 0,
  KEIKO_WINDOWS_AUTHORITY_PREVIOUS = 1,
  KEIKO_WINDOWS_AUTHORITY_CANDIDATE = 2
};

enum keiko_coordinator_windows_prefix {
  KEIKO_WINDOWS_PREFIX_INVALID = 0,
  KEIKO_WINDOWS_PREFIX_PREVIOUS = 1,
  KEIKO_WINDOWS_PREFIX_PREVIOUS_WITH_INCOMING = 2,
  KEIKO_WINDOWS_PREFIX_GENERATION = 3,
  KEIKO_WINDOWS_PREFIX_LAUNCHER = 4,
  KEIKO_WINDOWS_PREFIX_SETUP = 5,
  KEIKO_WINDOWS_PREFIX_REGISTRATION = 6,
  KEIKO_WINDOWS_PREFIX_CLEANED = 7
};

static int keiko_coordinator_windows_file_authority(
    const wchar_t *path,
    const char *previous_sha256,
    const char *candidate_sha256,
    uint64_t deadline_ms
) {
  if (keiko_windows_update_file_digest_matches(path, previous_sha256, deadline_ms))
    return KEIKO_WINDOWS_AUTHORITY_PREVIOUS;
  if (keiko_windows_update_file_digest_matches(path, candidate_sha256, deadline_ms))
    return KEIKO_WINDOWS_AUTHORITY_CANDIDATE;
  return KEIKO_WINDOWS_AUTHORITY_INVALID;
}

static int keiko_coordinator_windows_generation_state(
    const wchar_t *path,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  DWORD attributes = GetFileAttributesW(path);
  DWORD error;
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    error = GetLastError();
    return (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) ? 0 : -1;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !keiko_windows_update_tree_digest_matches(path, expected_sha256, deadline_ms)) return -1;
  return 1;
}

static int keiko_coordinator_windows_directory_presence(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  DWORD error;
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    error = GetLastError();
    return (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) ? 0 : -1;
  }
  return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 ? 1 : -1;
}

static inline int keiko_coordinator_windows_classify(
    const keiko_coordinator_context *context,
    uint64_t deadline_ms,
    int *prefix
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *registration = NULL;
  int current_generation;
  int candidate_generation;
  int incoming;
  int launcher;
  int setup;
  int registration_authority;
  if (prefix == NULL || !keiko_coordinator_windows_paths_build(context, &paths)) return 0;
  registration = keiko_windows_update_path_join(
      context->state_dir,
      L"\\portable-install-state.json"
  );
  current_generation = keiko_coordinator_windows_generation_state(
      paths.current_generation,
      context->plan.field[KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256],
      deadline_ms
  );
  candidate_generation = keiko_coordinator_windows_generation_state(
      paths.candidate_generation,
      context->plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256],
      deadline_ms
  );
  incoming = keiko_coordinator_windows_directory_presence(paths.incoming_generation);
  launcher = keiko_coordinator_windows_file_authority(
      paths.launcher,
      context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256],
      context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
      deadline_ms
  );
  setup = keiko_coordinator_windows_file_authority(
      paths.setup,
      context->plan.field[KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256],
      context->plan.field[KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256],
      deadline_ms
  );
  registration_authority = registration == NULL
      ? KEIKO_WINDOWS_AUTHORITY_INVALID
      : keiko_coordinator_windows_file_authority(
            registration,
            context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256],
            context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256],
            deadline_ms
        );
  *prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  if (current_generation == 1 && candidate_generation == 0 && incoming == 0 &&
      launcher == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
      setup == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
      registration_authority == KEIKO_WINDOWS_AUTHORITY_PREVIOUS) {
    *prefix = KEIKO_WINDOWS_PREFIX_PREVIOUS;
  } else if (current_generation == 1 && candidate_generation == 0 && incoming == 1 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
             setup == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_PREVIOUS) {
    *prefix = KEIKO_WINDOWS_PREFIX_PREVIOUS_WITH_INCOMING;
  } else if (current_generation == 1 && candidate_generation == 1 && incoming == 0 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
             setup == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_PREVIOUS) {
    *prefix = KEIKO_WINDOWS_PREFIX_GENERATION;
  } else if (current_generation == 1 && candidate_generation == 1 && incoming == 0 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             setup == KEIKO_WINDOWS_AUTHORITY_PREVIOUS &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_PREVIOUS) {
    *prefix = KEIKO_WINDOWS_PREFIX_LAUNCHER;
  } else if (current_generation == 1 && candidate_generation == 1 && incoming == 0 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             setup == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_PREVIOUS) {
    *prefix = KEIKO_WINDOWS_PREFIX_SETUP;
  } else if (current_generation == 1 && candidate_generation == 1 && incoming == 0 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             setup == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_CANDIDATE) {
    *prefix = KEIKO_WINDOWS_PREFIX_REGISTRATION;
  } else if (current_generation == 0 && candidate_generation == 1 && incoming == 0 &&
             launcher == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             setup == KEIKO_WINDOWS_AUTHORITY_CANDIDATE &&
             registration_authority == KEIKO_WINDOWS_AUTHORITY_CANDIDATE) {
    *prefix = KEIKO_WINDOWS_PREFIX_CLEANED;
  }
  free(registration);
  keiko_coordinator_windows_paths_clear(&paths);
  return *prefix != KEIKO_WINDOWS_PREFIX_INVALID;
}

static int keiko_coordinator_windows_restore_snapshot(
    const keiko_coordinator_context *context,
    const wchar_t *snapshot_name,
    const wchar_t *parent,
    const wchar_t *temporary_prefix,
    const wchar_t *destination,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  wchar_t *snapshot = keiko_windows_update_path_join(context->capsule, snapshot_name);
  wchar_t *temporary = keiko_coordinator_windows_ascii_path(
      parent,
      temporary_prefix,
      context->plan.field[KEIKO_KHP_ACTIVATION_ID]
  );
  int result = snapshot != NULL && temporary != NULL &&
               keiko_windows_update_replace_file(
                   snapshot,
                   parent,
                   temporary,
                   destination,
                   expected_sha256,
                   deadline_ms
               );
  free(temporary);
  free(snapshot);
  return result;
}

static inline int keiko_coordinator_restore_previous_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *registration = NULL;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  int result = 0;
  if (!keiko_coordinator_windows_paths_build(context, &paths) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix > KEIKO_WINDOWS_PREFIX_REGISTRATION ||
      !keiko_coordinator_windows_append_receipt(context, "restore", "intent")) goto cleanup;
  registration = keiko_windows_update_path_join(
      context->state_dir,
      L"\\portable-install-state.json"
  );
  if (registration == NULL) goto cleanup;
  if (prefix >= KEIKO_WINDOWS_PREFIX_REGISTRATION &&
      !keiko_coordinator_windows_restore_snapshot(
          context,
          L"\\registration.previous",
          context->state_dir,
          L"\\.registration-restore-",
          registration,
          context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256],
          deadline_ms
      )) goto cleanup;
  if (prefix >= KEIKO_WINDOWS_PREFIX_SETUP &&
      !keiko_coordinator_windows_restore_snapshot(
          context,
          L"\\setup-manifest.previous",
          paths.portable,
          L"\\.setup-restore-",
          paths.setup,
          context->plan.field[KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256],
          deadline_ms
      )) goto cleanup;
  if (prefix >= KEIKO_WINDOWS_PREFIX_LAUNCHER &&
      !keiko_coordinator_windows_restore_snapshot(
          context,
          L"\\coordinator.exe",
          paths.managed,
          L"\\.launcher-restore-",
          paths.launcher,
          context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256],
          deadline_ms
      )) goto cleanup;
  if ((prefix >= KEIKO_WINDOWS_PREFIX_GENERATION &&
       !keiko_windows_update_remove_tree(paths.candidate_generation, deadline_ms)) ||
      !keiko_windows_update_remove_tree(paths.incoming_generation, deadline_ms) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix != KEIKO_WINDOWS_PREFIX_PREVIOUS ||
      !keiko_coordinator_windows_append_receipt(context, "restore", "completed")) goto cleanup;
  result = 1;
cleanup:
  free(registration);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

static inline int keiko_coordinator_cleanup_verified_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *stage = NULL;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  int result = 0;
  if (!keiko_coordinator_windows_paths_build(context, &paths) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      (prefix != KEIKO_WINDOWS_PREFIX_REGISTRATION &&
       prefix != KEIKO_WINDOWS_PREFIX_CLEANED)) goto cleanup;
  stage = keiko_coordinator_windows_wide_utf8(context->plan.field[KEIKO_KHP_STAGE_ROOT]);
  if (stage == NULL ||
      !keiko_coordinator_windows_append_receipt(context, "cleanup", "intent") ||
      !keiko_windows_update_remove_tree(paths.current_generation, deadline_ms) ||
      !keiko_windows_update_remove_tree(paths.incoming_generation, deadline_ms) ||
      !keiko_windows_update_remove_tree(stage, deadline_ms) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix != KEIKO_WINDOWS_PREFIX_CLEANED ||
      !keiko_coordinator_windows_append_receipt(context, "cleanup", "completed") ||
      !keiko_coordinator_windows_append_receipt(context, "complete", "completed")) goto cleanup;
  result = 1;
cleanup:
  free(stage);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

static inline int keiko_coordinator_publish_registration_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  wchar_t *snapshot = keiko_windows_update_path_join(context->capsule, L"\\registration.next");
  wchar_t *destination = keiko_windows_update_path_join(
      context->state_dir,
      L"\\portable-install-state.json"
  );
  wchar_t *temporary = keiko_coordinator_windows_ascii_path(
      context->state_dir,
      L"\\.portable-install-state-",
      context->plan.field[KEIKO_KHP_ACTIVATION_ID]
  );
  int result = snapshot != NULL && destination != NULL && temporary != NULL &&
               keiko_coordinator_windows_append_receipt(context, "register", "intent") &&
               keiko_windows_update_replace_file(
                   snapshot,
                   context->state_dir,
                   temporary,
                   destination,
                   context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256],
                   deadline_ms
               ) &&
               KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("windows-register-after-publish") &&
               keiko_coordinator_windows_append_receipt(
                   context,
                   "register",
                   "completed"
               );
  free(temporary);
  free(destination);
  free(snapshot);
  return result;
}

#endif
