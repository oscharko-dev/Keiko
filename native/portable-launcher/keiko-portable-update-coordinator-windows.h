#ifndef KEIKO_PORTABLE_UPDATE_COORDINATOR_WINDOWS_H
#define KEIKO_PORTABLE_UPDATE_COORDINATOR_WINDOWS_H

#if !defined(_WIN32)
#error "keiko-portable-update-coordinator-windows.h requires Win32"
#endif

#include "keiko-portable-update-windows-mechanics.h"
#include "../keiko-windows-local-volume.h"

#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>

#include <fcntl.h>
#include <process.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <tlhelp32.h>

#if defined(_MSC_VER)
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#endif

#ifndef KEIKO_COORDINATOR_CUTOVER_CHECKPOINT
#define KEIKO_COORDINATOR_CUTOVER_CHECKPOINT(name) (1)
#endif

#define KEIKO_COORDINATOR_MAX_CONTROL_MS (15u * 60u * 1000u)
#define KEIKO_COORDINATOR_RECEIPT_MAX_BYTES 4096u
#define KEIKO_COORDINATOR_KRP_MAX_BYTES (128u * 1024u)
#define KEIKO_COORDINATOR_KRP_HEADER_BYTES 12u
#define KEIKO_COORDINATOR_START_GATE_FD 5
#define KEIKO_COORDINATOR_PROBE_MS 3000u

typedef struct {
  keiko_handoff_plan plan;
  wchar_t *state_dir;
  wchar_t *capsule;
  char *state_dir_utf8;
  char plan_sha256[65];
  char receipt_sha256[65];
  unsigned int receipt_sequence;
  uint64_t old_exit_deadline;
  HANDLE old_process;
  HANDLE supervisor_process;
  HANDLE capsule_directory;
  HANDLE receipts_directory;
  keiko_windows_local_volume_pin managed_root;
  keiko_windows_atomic_file_fact capsule_fact;
  keiko_windows_atomic_file_fact receipts_fact;
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

static int keiko_coordinator_windows_owner_private(
    PSID owner,
    PSID token_user,
    PSID token_owner,
    PSID system_sid,
    PSID administrators_sid
) {
  if (owner == NULL || token_user == NULL || token_owner == NULL || system_sid == NULL ||
      administrators_sid == NULL || !IsValidSid(owner) || !IsValidSid(token_user) ||
      !IsValidSid(token_owner) || !IsValidSid(system_sid) ||
      !IsValidSid(administrators_sid)) return 0;
  if (EqualSid(owner, token_user)) return 1;
  return EqualSid(owner, token_owner) &&
         (EqualSid(owner, system_sid) || EqualSid(owner, administrators_sid));
}

static int keiko_coordinator_windows_directory_private(HANDLE directory) {
  HANDLE token = NULL;
  TOKEN_USER *token_user = NULL;
  TOKEN_OWNER *token_owner = NULL;
  DWORD token_bytes = 0;
  DWORD token_owner_bytes = 0;
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  BYTE system_storage[SECURITY_MAX_SID_SIZE];
  BYTE administrators_storage[SECURITY_MAX_SID_SIZE];
  DWORD system_size = sizeof(system_storage);
  DWORD administrators_size = sizeof(administrators_storage);
  DWORD status;
  DWORD index;
  int result = 0;
  const DWORD write_mask = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_WRITE_DATA |
                           FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
                           FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER |
                           GENERIC_WRITE | GENERIC_ALL;
  if (directory == NULL || directory == INVALID_HANDLE_VALUE ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &token_bytes);
  (void)GetTokenInformation(token, TokenOwner, NULL, 0, &token_owner_bytes);
  if (token_bytes == 0 || token_owner_bytes == 0) goto cleanup;
  token_user = (TOKEN_USER *)calloc(1u, token_bytes);
  token_owner = (TOKEN_OWNER *)calloc(1u, token_owner_bytes);
  if (token_user == NULL || token_owner == NULL ||
      !GetTokenInformation(token, TokenUser, token_user, token_bytes, &token_bytes) ||
      !GetTokenInformation(
          token,
          TokenOwner,
          token_owner,
          token_owner_bytes,
          &token_owner_bytes
      ) ||
      !CreateWellKnownSid(WinLocalSystemSid, NULL, system_storage, &system_size) ||
      !CreateWellKnownSid(
          WinBuiltinAdministratorsSid,
          NULL,
          administrators_storage,
          &administrators_size
      )) goto cleanup;
  status = GetSecurityInfo(
      directory,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner,
      NULL,
      &dacl,
      NULL,
      &descriptor
  );
  if (status != ERROR_SUCCESS || owner == NULL || dacl == NULL ||
      !keiko_coordinator_windows_owner_private(
          owner,
          token_user->User.Sid,
          token_owner->Owner,
          system_storage,
          administrators_storage
      )) goto cleanup;
  for (index = 0; index < dacl->AceCount; ++index) {
    ACE_HEADER *header = NULL;
    ACCESS_ALLOWED_ACE *allowed;
    PSID sid;
    if (!GetAce(dacl, index, (LPVOID *)&header) || header == NULL) goto cleanup;
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      if (header->AceType == ACCESS_ALLOWED_OBJECT_ACE_TYPE ||
          header->AceType == ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE) {
        ACCESS_ALLOWED_OBJECT_ACE *object = (ACCESS_ALLOWED_OBJECT_ACE *)header;
        if ((object->Mask & write_mask) != 0u) goto cleanup;
      } else if (header->AceType == ACCESS_ALLOWED_CALLBACK_ACE_TYPE) {
        ACCESS_ALLOWED_ACE *callback = (ACCESS_ALLOWED_ACE *)header;
        if ((callback->Mask & write_mask) != 0u) goto cleanup;
      }
      continue;
    }
    allowed = (ACCESS_ALLOWED_ACE *)header;
    if ((allowed->Mask & write_mask) == 0u) continue;
    sid = (PSID)&allowed->SidStart;
    if (!IsValidSid(sid) ||
        (!EqualSid(sid, token_user->User.Sid) &&
        !EqualSid(sid, system_storage) &&
        !EqualSid(sid, administrators_storage))) goto cleanup;
  }
  result = 1;
cleanup:
  if (descriptor != NULL) LocalFree(descriptor);
  free(token_owner);
  free(token_user);
  if (token != NULL) CloseHandle(token);
  return result;
}

static int keiko_coordinator_windows_pin_capsule(keiko_coordinator_context *context) {
  if (context->capsule_directory != NULL &&
      context->capsule_directory != INVALID_HANDLE_VALUE) return 1;
  context->capsule_directory = keiko_windows_atomic_open_directory(
      context->capsule,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  if (context->capsule_directory == NULL ||
      context->capsule_directory == INVALID_HANDLE_VALUE ||
      !keiko_windows_atomic_query_fact(
          context->capsule_directory,
          &context->capsule_fact
      ) ||
      !keiko_coordinator_windows_directory_private(context->capsule_directory)) {
    if (context->capsule_directory != NULL &&
        context->capsule_directory != INVALID_HANDLE_VALUE)
      CloseHandle(context->capsule_directory);
    context->capsule_directory = INVALID_HANDLE_VALUE;
    return 0;
  }
  return 1;
}

static int keiko_coordinator_windows_pin_receipts(
    keiko_coordinator_context *context,
    int create
) {
  wchar_t *receipts = NULL;
  int result = 0;
  if (context->receipts_directory != NULL &&
      context->receipts_directory != INVALID_HANDLE_VALUE) return 1;
  if (!keiko_coordinator_windows_pin_capsule(context)) return 0;
  receipts = keiko_windows_update_path_join(context->capsule, L"\\receipts");
  if (receipts == NULL) goto cleanup;
  if (create && !CreateDirectoryW(receipts, NULL) &&
      GetLastError() != ERROR_ALREADY_EXISTS) goto cleanup;
  context->receipts_directory = keiko_windows_atomic_open_directory(
      receipts,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  if (context->receipts_directory == NULL ||
      context->receipts_directory == INVALID_HANDLE_VALUE ||
      !keiko_windows_atomic_parent_matches(receipts, &context->capsule_fact) ||
      !keiko_windows_atomic_query_fact(
          context->receipts_directory,
          &context->receipts_fact
      ) ||
      !keiko_coordinator_windows_directory_private(context->receipts_directory))
    goto cleanup;
  result = 1;
cleanup:
  if (!result && context->receipts_directory != NULL &&
      context->receipts_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(context->receipts_directory);
    context->receipts_directory = INVALID_HANDLE_VALUE;
  }
  free(receipts);
  return result;
}

static int keiko_coordinator_windows_read_file(
    const wchar_t *path,
    size_t maximum,
    uint64_t deadline_ms,
    unsigned char **output,
    size_t *output_length
);

static int keiko_coordinator_windows_read_file_bound(
    const wchar_t *path,
    const keiko_windows_atomic_file_fact *parent,
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
  HANDLE pipe = (HANDLE)_get_osfhandle(descriptor);
  size_t offset = 0;
  if (pipe == INVALID_HANDLE_VALUE || pipe == NULL) return 0;
  while (offset < length) {
    DWORD available = 0;
    int count;
    if (GetTickCount64() > deadline_ms || length - offset > INT_MAX) return 0;
    if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) return 0;
    if (available == 0) {
      Sleep(10);
      continue;
    }
    if ((size_t)available > length - offset) available = (DWORD)(length - offset);
    count = _read(descriptor, (unsigned char *)output + offset, available);
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int keiko_coordinator_windows_write_exact_fd(
    int descriptor,
    const void *content,
    size_t length,
    uint64_t deadline_ms,
    HANDLE observed_process
) {
  HANDLE pipe = (HANDLE)_get_osfhandle(descriptor);
  DWORD mode = PIPE_NOWAIT;
  size_t offset = 0;
  if (pipe == NULL || pipe == INVALID_HANDLE_VALUE || content == NULL ||
      length == 0 || length > KEIKO_COORDINATOR_KRP_MAX_BYTES) return 0;
  if (!SetNamedPipeHandleState(pipe, &mode, NULL, NULL)) return 0;
  while (offset < length) {
    DWORD written = 0;
    DWORD remaining;
    DWORD error;
    if (GetTickCount64() > deadline_ms) return 0;
    if (observed_process != NULL && observed_process != INVALID_HANDLE_VALUE) {
      DWORD process_state = WaitForSingleObject(observed_process, 0);
      if (process_state != WAIT_TIMEOUT) return 0;
    }
    remaining = length - offset > MAXDWORD
                    ? MAXDWORD
                    : (DWORD)(length - offset);
    if (WriteFile(
            pipe,
            (const unsigned char *)content + offset,
            remaining,
            &written,
            NULL
        )) {
      offset += written;
      if (written != 0) continue;
    } else {
      error = GetLastError();
      if (error != ERROR_NO_DATA && error != ERROR_PIPE_BUSY) return 0;
    }
    Sleep(1);
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
    keiko_coordinator_context *context
) {
  wchar_t *managed = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_MANAGED_ROOT]
  );
  wchar_t *stage = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_STAGE_ROOT]
  );
  keiko_windows_local_volume_pin stage_pin;
  int result = 0;
  memset(&stage_pin, 0, sizeof(stage_pin));
  stage_pin.directory = INVALID_HANDLE_VALUE;
  result = managed != NULL && stage != NULL &&
           keiko_windows_local_volume_pin_path(managed, 1, &context->managed_root) &&
           keiko_windows_local_volume_pin_path(stage, 1, &stage_pin) &&
           context->managed_root.identity.VolumeSerialNumber ==
               stage_pin.identity.VolumeSerialNumber &&
           keiko_windows_local_volume_recheck(&context->managed_root) &&
           keiko_windows_local_volume_recheck(&stage_pin);
  keiko_windows_local_volume_clear(&stage_pin);
  if (!result) keiko_windows_local_volume_clear(&context->managed_root);
  free(stage);
  free(managed);
  return result;
}

static int keiko_coordinator_windows_managed_root_current(
    const keiko_coordinator_context *context
) {
  return context != NULL && keiko_windows_local_volume_recheck(&context->managed_root);
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

static int keiko_coordinator_windows_read_file_bound(
    const wchar_t *path,
    const keiko_windows_atomic_file_fact *parent,
    size_t maximum,
    uint64_t deadline_ms,
    unsigned char **output,
    size_t *output_length
) {
  if (!keiko_windows_atomic_parent_matches(path, parent) ||
      !keiko_coordinator_windows_read_file(
          path,
          maximum,
          deadline_ms,
          output,
          output_length
      )) return 0;
  if (keiko_windows_atomic_parent_matches(path, parent)) return 1;
  if (*output != NULL) {
    SecureZeroMemory(*output, *output_length);
    free(*output);
    *output = NULL;
    *output_length = 0;
  }
  return 0;
}

static int keiko_coordinator_windows_file_digest_bound(
    const wchar_t *path,
    const keiko_windows_atomic_file_fact *parent,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  HANDLE file = INVALID_HANDLE_VALUE;
  keiko_windows_atomic_file_fact before;
  keiko_windows_atomic_file_fact after;
  char actual[65];
  int result = 0;
  if (!keiko_windows_atomic_parent_matches(path, parent)) return 0;
  file = keiko_windows_atomic_open_regular(path, GENERIC_READ, FILE_SHARE_READ);
  if (file == INVALID_HANDLE_VALUE || file == NULL ||
      !keiko_windows_atomic_query_fact(file, &before) ||
      !keiko_windows_update_handle_hash(file, deadline_ms, actual) ||
      !keiko_windows_atomic_query_fact(file, &after) ||
      !keiko_windows_atomic_same_file(&before, &after) ||
      before.standard.EndOfFile.QuadPart != after.standard.EndOfFile.QuadPart ||
      !keiko_windows_atomic_parent_matches(path, parent) ||
      strcmp(actual, expected_sha256) != 0) goto cleanup;
  result = 1;
cleanup:
  SecureZeroMemory(actual, sizeof(actual));
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
      !keiko_coordinator_windows_pin_capsule(context) ||
      !keiko_coordinator_windows_read_file_bound(
          plan_path,
          &context->capsule_fact,
          KEIKO_KHP_MAX_BYTES,
          deadline_ms,
          &plan_content,
          &plan_length
      ) ||
      !keiko_coordinator_windows_read_file_bound(
          digest_path,
          &context->capsule_fact,
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
    keiko_coordinator_context *context,
    const wchar_t *name,
    const char *digest,
    uint64_t deadline_ms
) {
  wchar_t *path = keiko_windows_update_path_join(context->capsule, name);
  int result = path != NULL &&
               keiko_coordinator_windows_pin_capsule(context) &&
               keiko_coordinator_windows_file_digest_bound(
      path,
      &context->capsule_fact,
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
  if (context->old_process != NULL && context->old_process != INVALID_HANDLE_VALUE) {
    CloseHandle(context->old_process);
  }
  if (context->receipts_directory != NULL &&
      context->receipts_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(context->receipts_directory);
  }
  if (context->capsule_directory != NULL &&
      context->capsule_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(context->capsule_directory);
  }
  keiko_windows_local_volume_clear(&context->managed_root);
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
      (context->old_process = OpenProcess(
           SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
           FALSE,
           parent_pid
       )) == NULL ||
      GetProcessId(context->old_process) != parent_pid ||
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
  size_t length;
  if (content == NULL || offset == NULL || value == NULL) return 0;
  length = strlen(value);
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
  FILE_ATTRIBUTE_TAG_INFO file_tag;
  keiko_windows_atomic_file_fact file_before;
  keiko_windows_atomic_file_fact file_after;
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
  if (!keiko_coordinator_windows_pin_receipts(context, 1)) goto cleanup;
  receipts = keiko_windows_update_path_join(context->capsule, L"\\receipts");
  if (receipts == NULL) goto cleanup;
  path = keiko_windows_update_path_join(receipts, filename);
  if (path == NULL) goto cleanup;
  file = CreateFileW(
      path,
      GENERIC_WRITE | FILE_READ_ATTRIBUTES,
      0,
      NULL,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  if (file == INVALID_HANDLE_VALUE || file == NULL ||
      !keiko_windows_atomic_parent_matches(path, &context->receipts_fact) ||
      !GetFileInformationByHandleEx(
          file,
          FileAttributeTagInfo,
          &file_tag,
          sizeof(file_tag)
      ) ||
      (file_tag.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !keiko_windows_atomic_query_fact(file, &file_before) ||
      file_before.standard.DeletePending || file_before.standard.NumberOfLinks != 1 ||
      !WriteFile(file, content, (DWORD)offset, &written, NULL) ||
      written != offset || !FlushFileBuffers(file) ||
      !keiko_windows_atomic_query_fact(file, &file_after) ||
      !keiko_windows_atomic_same_file(&file_before, &file_after) ||
      file_after.standard.EndOfFile.QuadPart != (LONGLONG)offset ||
      !keiko_windows_atomic_parent_matches(path, &context->receipts_fact)) goto cleanup;
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

static int keiko_coordinator_windows_receipt_field(
    const unsigned char *content,
    size_t length,
    size_t *offset,
    const unsigned char **value,
    size_t *value_length
) {
  uint32_t field_length;
  if (*offset > length || length - *offset < 4u) return 0;
  field_length = keiko_khp_read_u32(content + *offset);
  *offset += 4u;
  if ((size_t)field_length > length - *offset) return 0;
  *value = content + *offset;
  *value_length = (size_t)field_length;
  *offset += (size_t)field_length;
  return 1;
}

static int keiko_coordinator_windows_field_equals(
    const unsigned char *value,
    size_t length,
    const char *expected
) {
  return strlen(expected) == length && memcmp(value, expected, length) == 0;
}

static int keiko_coordinator_windows_read_expected_receipt(
    keiko_coordinator_context *context,
    const char *kind,
    const char *outcome,
    uint64_t deadline_ms
) {
  unsigned char *content = NULL;
  const unsigned char *field[7];
  size_t field_length[7];
  size_t length = 0;
  size_t offset = 8u;
  size_t index;
  char sequence[32];
  char digest[65];
  wchar_t filename[32];
  wchar_t *receipts = NULL;
  wchar_t *path = NULL;
  int result = 0;
  if (snprintf(sequence, sizeof(sequence), "%u", context->receipt_sequence + 1u) <= 0 ||
      _snwprintf_s(
          filename,
          sizeof(filename) / sizeof(filename[0]),
          _TRUNCATE,
          L"\\%06u.khr",
          context->receipt_sequence + 1u
      ) <= 0) goto cleanup;
  if (!keiko_coordinator_windows_pin_receipts(context, 0)) goto cleanup;
  receipts = keiko_windows_update_path_join(context->capsule, L"\\receipts");
  if (receipts != NULL) path = keiko_windows_update_path_join(receipts, filename);
  if (path == NULL ||
      !keiko_coordinator_windows_read_file_bound(
          path,
          &context->receipts_fact,
          KEIKO_COORDINATOR_RECEIPT_MAX_BYTES,
          deadline_ms,
          &content,
          &length
      ) ||
      length < 8u || memcmp(content, "KHR1", 4u) != 0 ||
      keiko_khp_read_u16(content + 4u) != 1u ||
      keiko_khp_read_u16(content + 6u) != 7u) goto cleanup;
  for (index = 0; index < 7u; ++index) {
    if (!keiko_coordinator_windows_receipt_field(
            content,
            length,
            &offset,
            &field[index],
            &field_length[index]
        )) goto cleanup;
  }
  if (offset != length ||
      !keiko_coordinator_windows_field_equals(
          field[0],
          field_length[0],
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]
      ) ||
      !keiko_coordinator_windows_field_equals(
          field[1],
          field_length[1],
          context->plan_sha256
      ) ||
      !keiko_coordinator_windows_field_equals(field[2], field_length[2], sequence) ||
      !keiko_coordinator_windows_field_equals(field[3], field_length[3], kind) ||
      !keiko_coordinator_windows_field_equals(field[4], field_length[4], outcome) ||
      field_length[5] < 1u || field_length[5] > 16u ||
      (field_length[5] > 1u && field[5][0] == '0') ||
      (context->receipt_sequence == 0u
           ? field_length[6] != 0u
           : !keiko_coordinator_windows_field_equals(
                 field[6],
                 field_length[6],
                 context->receipt_sha256
             ))) goto cleanup;
  for (index = 0; index < field_length[5]; ++index) {
    if (field[5][index] < '0' || field[5][index] > '9') goto cleanup;
  }
  if (!keiko_coordinator_windows_hash_bytes(content, length, digest)) goto cleanup;
  memcpy(context->receipt_sha256, digest, sizeof(context->receipt_sha256));
  context->receipt_sequence += 1u;
  result = 1;
cleanup:
  if (content != NULL) {
    SecureZeroMemory(content, length);
    free(content);
  }
  free(path);
  free(receipts);
  return result;
}

static int keiko_coordinator_windows_next_receipt_exists(
    keiko_coordinator_context *context
) {
  wchar_t filename[32];
  wchar_t *receipts = NULL;
  wchar_t *path = NULL;
  DWORD attributes;
  DWORD error;
  int result = 1;
  if (_snwprintf_s(
          filename,
          sizeof(filename) / sizeof(filename[0]),
          _TRUNCATE,
          L"\\%06u.khr",
          context->receipt_sequence + 1u
      ) <= 0) return 1;
  receipts = keiko_windows_update_path_join(context->capsule, L"\\receipts");
  if (receipts == NULL) return 1;
  if (!keiko_coordinator_windows_pin_receipts(context, 0)) {
    result = !keiko_windows_atomic_destination_absent(receipts);
    free(receipts);
    return result;
  }
  if (receipts != NULL) path = keiko_windows_update_path_join(receipts, filename);
  if (path != NULL &&
      keiko_windows_atomic_parent_matches(path, &context->receipts_fact)) {
    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      error = GetLastError();
      result = error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND;
    }
  }
  free(path);
  free(receipts);
  return result;
}

static inline int keiko_coordinator_windows_wait_expected_receipt(
    keiko_coordinator_context *context,
    const char *kind,
    const char *outcome,
    uint64_t deadline_ms
) {
  while (GetTickCount64() <= deadline_ms) {
    if (keiko_coordinator_windows_next_receipt_exists(context)) {
      return keiko_coordinator_windows_read_expected_receipt(
          context,
          kind,
          outcome,
          deadline_ms
      );
    }
    Sleep(10);
  }
  return 0;
}

static inline int keiko_coordinator_windows_wait_verified_ack(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  wchar_t *path = keiko_windows_update_path_join(context->capsule, L"\\verified.ack");
  unsigned char *content = NULL;
  size_t length = 0;
  int result = 0;
  if (path == NULL) return 0;
  if (!keiko_coordinator_windows_pin_capsule(context)) goto cleanup;
  while (GetTickCount64() <= deadline_ms) {
    DWORD attributes = GetFileAttributesW(path);
    if (attributes != INVALID_FILE_ATTRIBUTES) break;
    if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND)
      goto cleanup;
    Sleep(10);
  }
  if (GetTickCount64() > deadline_ms ||
      !keiko_coordinator_windows_read_file_bound(
          path,
          &context->capsule_fact,
          69u,
          deadline_ms,
          &content,
          &length
      ) ||
      length != 69u || memcmp(content, "KHV1", 4u) != 0 || content[68] != '\n' ||
      memcmp(content + 4u, context->plan_sha256, 64u) != 0) goto cleanup;
  result = 1;
cleanup:
  if (content != NULL) {
    SecureZeroMemory(content, length);
    free(content);
  }
  free(path);
  return result;
}

static inline int keiko_coordinator_windows_emit_acceptance(
    keiko_coordinator_context *context
) {
  char response[69];
  int result;
  if (!keiko_coordinator_windows_append_receipt(context, "prepared", "completed") ||
      !keiko_coordinator_windows_append_receipt(context, "old-exit", "intent")) return 0;
  memcpy(response, "KHA1", 4u);
  memcpy(response + 4u, context->plan_sha256, 64u);
  response[68] = '\n';
  result = keiko_coordinator_windows_write_exact_fd(
      3,
      response,
      sizeof(response),
      context->old_exit_deadline,
      context->old_process
  );
  (void)_close(3);
  return result;
}

static int keiko_coordinator_windows_wait_parent_eof(uint64_t deadline_ms) {
  HANDLE input = (HANDLE)_get_osfhandle(_fileno(stdin));
  if (input == INVALID_HANDLE_VALUE || input == NULL) return 0;
  while (GetTickCount64() <= deadline_ms) {
    DWORD available = 0;
    unsigned char unexpected;
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
      DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
        (void)_close(_fileno(stdin));
        return 1;
      }
      return 0;
    }
    if (available != 0) return _read(_fileno(stdin), &unexpected, 1u) == 0;
    Sleep(10);
  }
  return 0;
}

static int keiko_coordinator_windows_port_bindable(
    const keiko_coordinator_context *context
) {
  WSADATA data;
  SOCKET probe = INVALID_SOCKET;
  struct sockaddr_in address;
  uint64_t port;
  BOOL exclusive = TRUE;
  int result = 0;
  if (!keiko_khp_decimal_value(
          context->plan.field[KEIKO_KHP_OLD_PORT],
          65535u,
          &port
      ) ||
      port == 0u || WSAStartup(MAKEWORD(2, 2), &data) != 0) return 0;
  probe = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((u_short)port);
  if (probe != INVALID_SOCKET &&
      setsockopt(
          probe,
          SOL_SOCKET,
          SO_EXCLUSIVEADDRUSE,
          (const char *)&exclusive,
          sizeof(exclusive)
      ) == 0 &&
      bind(probe, (const struct sockaddr *)&address, sizeof(address)) == 0) result = 1;
  if (probe != INVALID_SOCKET) closesocket(probe);
  WSACleanup();
  return result;
}

static inline int keiko_coordinator_windows_wait_old_exit(
    keiko_coordinator_context *context
) {
  if (context->old_process == NULL || context->old_process == INVALID_HANDLE_VALUE ||
      !keiko_coordinator_windows_wait_parent_eof(context->old_exit_deadline)) return 0;
  while (GetTickCount64() <= context->old_exit_deadline) {
    if (context->old_process != NULL) {
      DWORD waited = WaitForSingleObject(context->old_process, 10u);
      if (waited == WAIT_OBJECT_0) {
        CloseHandle(context->old_process);
        context->old_process = NULL;
      } else if (waited == WAIT_FAILED) {
        return 0;
      }
    } else if (keiko_coordinator_windows_port_bindable(context)) {
      return keiko_coordinator_windows_append_receipt(
          context,
          "old-exit",
          "completed"
      );
    }
  }
  return 0;
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

static int keiko_coordinator_windows_remove_tree_if_present(
    const wchar_t *path,
    uint64_t deadline_ms
) {
  DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 0;
  return keiko_windows_update_remove_tree(path, deadline_ms);
}

static int keiko_coordinator_restore_platform_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  keiko_coordinator_windows_paths paths;
  wchar_t *registration = NULL;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  int result = 0;
  if (!keiko_coordinator_windows_paths_build(context, &paths) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix > KEIKO_WINDOWS_PREFIX_REGISTRATION) goto cleanup;
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
      !keiko_coordinator_windows_remove_tree_if_present(
          paths.incoming_generation,
          deadline_ms
      ) ||
      !keiko_coordinator_windows_classify(context, deadline_ms, &prefix) ||
      prefix != KEIKO_WINDOWS_PREFIX_PREVIOUS) goto cleanup;
  result = 1;
cleanup:
  free(registration);
  keiko_coordinator_windows_paths_clear(&paths);
  return result;
}

static inline int keiko_coordinator_restore_previous_windows(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_append_receipt(context, "restore", "intent") &&
         keiko_coordinator_restore_platform_windows(context, deadline_ms) &&
         keiko_coordinator_windows_append_receipt(context, "restore", "completed");
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
      !keiko_coordinator_windows_remove_tree_if_present(
          paths.incoming_generation,
          deadline_ms
      ) ||
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

static int keiko_coordinator_windows_append_krp_string(
    unsigned char *content,
    size_t capacity,
    size_t *offset,
    const char *value
) {
  size_t length = strlen(value);
  if (length > UINT32_MAX || *offset > capacity ||
      capacity - *offset < 4u + length + 1u) return 0;
  content[*offset] = (unsigned char)length;
  content[*offset + 1u] = (unsigned char)(length >> 8);
  content[*offset + 2u] = (unsigned char)(length >> 16);
  content[*offset + 3u] = (unsigned char)(length >> 24);
  *offset += 4u;
  memcpy(content + *offset, value, length);
  content[*offset + length] = 0;
  *offset += length + 1u;
  return 1;
}

static int keiko_coordinator_windows_launch_packet(
    const keiko_coordinator_context *context,
    const char *executable,
    int restoring,
    unsigned char **output,
    size_t *output_length
) {
  unsigned char *content;
  const char *resume_argument = restoring ? "--resume-restored-update" : "--resume-update";
  size_t offset = KEIKO_COORDINATOR_KRP_HEADER_BYTES + 4u;
  uint32_t payload_length;
  if (context == NULL || executable == NULL || output == NULL || output_length == NULL)
    return 0;
  content = (unsigned char *)calloc(KEIKO_COORDINATOR_KRP_MAX_BYTES, 1u);
  if (content == NULL) return 0;
  memcpy(content, "KRP1", 4u);
  content[4] = 1u;
  content[6] = 1u;
  content[KEIKO_COORDINATOR_KRP_HEADER_BYTES] = 2u;
  content[KEIKO_COORDINATOR_KRP_HEADER_BYTES + 2u] = 1u;
  if (!keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          executable
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          context->plan.field[KEIKO_KHP_MANAGED_ROOT]
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          resume_argument
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          "KEIKO_STATE_DIR"
      ) ||
      !keiko_coordinator_windows_append_krp_string(
          content,
          KEIKO_COORDINATOR_KRP_MAX_BYTES,
          &offset,
          context->state_dir_utf8
      ) ||
      offset - KEIKO_COORDINATOR_KRP_HEADER_BYTES > UINT32_MAX) {
    SecureZeroMemory(content, KEIKO_COORDINATOR_KRP_MAX_BYTES);
    free(content);
    return 0;
  }
  payload_length = (uint32_t)(offset - KEIKO_COORDINATOR_KRP_HEADER_BYTES);
  content[8] = (unsigned char)payload_length;
  content[9] = (unsigned char)(payload_length >> 8);
  content[10] = (unsigned char)(payload_length >> 16);
  content[11] = (unsigned char)(payload_length >> 24);
  *output = content;
  *output_length = offset;
  return 1;
}

static int keiko_coordinator_windows_reserve_low_descriptors(
    int opened[6],
    size_t *opened_count
) {
  *opened_count = 0;
  while (*opened_count < 6u) {
    int descriptor = _open("NUL", _O_RDWR | _O_BINARY | _O_NOINHERIT);
    if (descriptor < 0) return 0;
    opened[(*opened_count)++] = descriptor;
    if (descriptor >= KEIKO_COORDINATOR_START_GATE_FD) return 1;
  }
  return 0;
}

static void keiko_coordinator_windows_close_descriptors(int *descriptors, size_t count) {
  size_t index;
  for (index = 0; index < count; ++index) {
    if (descriptors[index] >= 0) {
      (void)_close(descriptors[index]);
      descriptors[index] = -1;
    }
  }
}

static int keiko_coordinator_windows_wait_process(
    HANDLE *process,
    uint64_t deadline_ms
) {
  DWORD exit_code = 1;
  ULONGLONG now;
  DWORD timeout;
  DWORD waited;
  if (process == NULL || *process == NULL || *process == INVALID_HANDLE_VALUE) return 0;
  now = GetTickCount64();
  if (now > deadline_ms) return 0;
  timeout = deadline_ms - now > MAXDWORD ? MAXDWORD : (DWORD)(deadline_ms - now);
  waited = WaitForSingleObject(*process, timeout);
  if (waited != WAIT_OBJECT_0 || !GetExitCodeProcess(*process, &exit_code)) return 0;
  CloseHandle(*process);
  *process = NULL;
  return exit_code == 0u;
}

static int keiko_coordinator_windows_spawn_supervisor(
    keiko_coordinator_context *context,
    uint64_t deadline_ms,
    int restoring
) {
  wchar_t *supervisor = keiko_windows_update_path_join(
      context->capsule,
      L"\\runtime-supervisor.exe"
  );
  keiko_coordinator_windows_paths paths;
  char *active_launcher = NULL;
  unsigned char *packet = NULL;
  size_t packet_length = 0;
  int placeholders[6] = {-1, -1, -1, -1, -1, -1};
  size_t placeholder_count = 0;
  int control[2] = {-1, -1};
  int response[2] = {-1, -1};
  int gate[2] = {-1, -1};
  int child_descriptors[3] = {-1, -1, -1};
  const wchar_t *arguments[2];
  const wchar_t *environment[1] = {NULL};
  intptr_t child = -1;
  unsigned char header[KEIKO_COORDINATOR_KRP_HEADER_BYTES];
  int result = 0;
  memset(&paths, 0, sizeof(paths));
  if (supervisor == NULL || !keiko_coordinator_windows_paths_build(context, &paths))
    goto cleanup;
  active_launcher = keiko_coordinator_windows_utf8_wide(paths.launcher);
  if (active_launcher == NULL ||
      GetTickCount64() > deadline_ms ||
      !keiko_windows_update_file_digest_matches(
          supervisor,
          context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_windows_update_file_digest_matches(
          paths.launcher,
          context->plan.field[restoring ? KEIKO_KHP_CURRENT_LAUNCHER_SHA256
                                        : KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_launch_packet(
          context,
          active_launcher,
          restoring,
          &packet,
          &packet_length
      ) ||
      !keiko_coordinator_windows_reserve_low_descriptors(
          placeholders,
          &placeholder_count
      ) ||
      _pipe(control, 4096u, _O_BINARY | _O_NOINHERIT) != 0 ||
      _pipe(response, 4096u, _O_BINARY | _O_NOINHERIT) != 0 ||
      _pipe(gate, 4096u, _O_BINARY | _O_NOINHERIT) != 0) goto cleanup;
  keiko_coordinator_windows_close_descriptors(placeholders, placeholder_count);
  placeholder_count = 0;
  if (_dup2(gate[0], 0) != 0) goto cleanup;
  child_descriptors[0] = 0;
  if (_dup2(control[0], 3) != 0) goto cleanup;
  child_descriptors[1] = 3;
  if (_dup2(response[1], 4) != 0) goto cleanup;
  child_descriptors[2] = 4;
  arguments[0] = supervisor;
  arguments[1] = NULL;
  child = _wspawnve(_P_NOWAIT, supervisor, arguments, environment);
  keiko_coordinator_windows_close_descriptors(child_descriptors, 3u);
  if (child == -1) goto cleanup;
  context->supervisor_process = (HANDLE)child;
  child = -1;
  (void)_close(control[0]);
  control[0] = -1;
  (void)_close(response[1]);
  response[1] = -1;
  (void)_close(gate[0]);
  gate[0] = -1;
  context->supervisor_control = control[1];
  control[1] = -1;
  context->supervisor_response = response[0];
  response[0] = -1;
  context->start_gate = gate[1];
  gate[1] = -1;
  if (!keiko_coordinator_windows_write_exact_fd(
          context->supervisor_control,
          packet,
          packet_length,
          deadline_ms,
          context->supervisor_process
      ) ||
      !keiko_coordinator_windows_read_exact_fd(
          context->supervisor_response,
          header,
          sizeof(header),
          deadline_ms
      ) ||
      memcmp(header, "KRS1", 4u) != 0 || keiko_khp_read_u16(header + 4u) != 1u ||
      keiko_khp_read_u16(header + 6u) != 1u || keiko_khp_read_u32(header + 8u) != 0u) {
    goto cleanup;
  }
  result = 1;
cleanup:
  if (packet != NULL) {
    SecureZeroMemory(packet, packet_length);
    free(packet);
  }
  keiko_coordinator_windows_close_descriptors(placeholders, placeholder_count);
  keiko_coordinator_windows_close_descriptors(control, 2u);
  keiko_coordinator_windows_close_descriptors(response, 2u);
  keiko_coordinator_windows_close_descriptors(gate, 2u);
  keiko_coordinator_windows_close_descriptors(child_descriptors, 3u);
  if (child != -1) CloseHandle((HANDLE)child);
  free(active_launcher);
  keiko_coordinator_windows_paths_clear(&paths);
  free(supervisor);
  return result;
}

static int keiko_coordinator_windows_start_runtime(
    keiko_coordinator_context *context,
    uint64_t deadline_ms,
    int restoring
) {
  char gate[65];
  const char *kind = restoring ? "restored-start" : "start";
  if (GetTickCount64() > deadline_ms ||
      !keiko_coordinator_windows_append_receipt(context, kind, "intent") ||
      !keiko_coordinator_windows_spawn_supervisor(context, deadline_ms, restoring) ||
      !keiko_coordinator_windows_append_receipt(context, kind, "completed")) return 0;
  memcpy(gate, context->plan_sha256, 64u);
  gate[64] = '\n';
  if (!keiko_coordinator_windows_write_exact_fd(
          context->start_gate,
          gate,
          sizeof(gate),
          deadline_ms,
          context->supervisor_process
      )) return 0;
  (void)_close(context->start_gate);
  context->start_gate = -1;
  return 1;
}

static int keiko_coordinator_windows_stop_runtime(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  unsigned char control[12] = {'K', 'R', 'C', '1', 1, 0, 3, 0, 0, 0, 0, 0};
  unsigned char response[20];
  if (context->supervisor_process == NULL ||
      context->supervisor_process == INVALID_HANDLE_VALUE ||
      context->supervisor_control < 0 || context->supervisor_response < 0 ||
      !keiko_coordinator_windows_write_exact_fd(
          context->supervisor_control,
          control,
          sizeof(control),
          deadline_ms,
          context->supervisor_process
      )) return 0;
  (void)_close(context->supervisor_control);
  context->supervisor_control = -1;
  if (!keiko_coordinator_windows_read_exact_fd(
          context->supervisor_response,
          response,
          sizeof(response),
          deadline_ms
      ) ||
      memcmp(response, "KRS1", 4u) != 0 ||
      keiko_khp_read_u16(response + 4u) != 1u ||
      keiko_khp_read_u16(response + 6u) != 2u ||
      keiko_khp_read_u32(response + 8u) != 8u ||
      keiko_khp_read_u32(response + 12u) != 0u ||
      keiko_khp_read_u32(response + 16u) != 0u ||
      !keiko_coordinator_windows_wait_process(
          &context->supervisor_process,
          deadline_ms
      )) return 0;
  (void)_close(context->supervisor_response);
  context->supervisor_response = -1;
  return 1;
}

static int keiko_coordinator_windows_reconcile_stopped_runtime(
    const keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  wchar_t *supervisor = keiko_windows_update_path_join(
      context->capsule,
      L"\\runtime-supervisor.exe"
  );
  wchar_t *activation = keiko_coordinator_windows_wide_utf8(
      context->plan.field[KEIKO_KHP_ACTIVATION_ID]
  );
  const wchar_t *arguments[4];
  const wchar_t *environment[1] = {NULL};
  int placeholders[6] = {-1, -1, -1, -1, -1, -1};
  size_t placeholder_count = 0;
  int response_pipe[2] = {-1, -1};
  int child_response = -1;
  intptr_t child = -1;
  HANDLE child_handle = NULL;
  unsigned char response[20];
  int result = 0;
  if (supervisor == NULL || activation == NULL || GetTickCount64() > deadline_ms ||
      !keiko_windows_update_file_digest_matches(
          supervisor,
          context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
          deadline_ms
      ) ||
      !keiko_coordinator_windows_reserve_low_descriptors(
          placeholders,
          &placeholder_count
      ) ||
      _pipe(response_pipe, 4096u, _O_BINARY | _O_NOINHERIT) != 0) goto cleanup;
  keiko_coordinator_windows_close_descriptors(placeholders, placeholder_count);
  placeholder_count = 0;
  if (_dup2(response_pipe[1], 4) != 0) goto cleanup;
  child_response = 4;
  arguments[0] = supervisor;
  arguments[1] = L"--reconcile";
  arguments[2] = activation;
  arguments[3] = NULL;
  child = _wspawnve(_P_NOWAIT, supervisor, arguments, environment);
  (void)_close(child_response);
  child_response = -1;
  if (child == -1) goto cleanup;
  child_handle = (HANDLE)child;
  child = -1;
  (void)_close(response_pipe[1]);
  response_pipe[1] = -1;
  if (!keiko_coordinator_windows_read_exact_fd(
          response_pipe[0],
          response,
          sizeof(response),
          deadline_ms
      ) ||
      memcmp(response, "KRS1", 4u) != 0 ||
      keiko_khp_read_u16(response + 4u) != 1u ||
      keiko_khp_read_u16(response + 6u) != 2u ||
      keiko_khp_read_u32(response + 8u) != 8u ||
      keiko_khp_read_u32(response + 12u) != 0u ||
      keiko_khp_read_u32(response + 16u) != 0u ||
      !keiko_coordinator_windows_wait_process(&child_handle, deadline_ms)) goto cleanup;
  result = 1;
cleanup:
  keiko_coordinator_windows_close_descriptors(placeholders, placeholder_count);
  keiko_coordinator_windows_close_descriptors(response_pipe, 2u);
  if (child_response >= 0) (void)_close(child_response);
  if (child != -1) CloseHandle((HANDLE)child);
  if (child_handle != NULL && child_handle != INVALID_HANDLE_VALUE) {
    (void)TerminateProcess(child_handle, 137u);
    (void)WaitForSingleObject(child_handle, KEIKO_COORDINATOR_PROBE_MS);
    CloseHandle(child_handle);
  }
  SecureZeroMemory(response, sizeof(response));
  free(activation);
  free(supervisor);
  return result;
}

static int keiko_coordinator_windows_stop_failed_start(
    keiko_coordinator_context *context,
    uint64_t deadline_ms
) {
  if (context->start_gate >= 0) {
    (void)_close(context->start_gate);
    context->start_gate = -1;
  }
  if (context->supervisor_control >= 0) {
    (void)_close(context->supervisor_control);
    context->supervisor_control = -1;
  }
  if (context->supervisor_process != NULL &&
      context->supervisor_process != INVALID_HANDLE_VALUE &&
      !keiko_coordinator_windows_wait_process(
          &context->supervisor_process,
          deadline_ms
      )) return 0;
  if (context->supervisor_response >= 0) {
    (void)_close(context->supervisor_response);
    context->supervisor_response = -1;
  }
  return keiko_coordinator_windows_reconcile_stopped_runtime(context, deadline_ms);
}

static void keiko_coordinator_windows_hold_runtime(keiko_coordinator_context *context) {
  if (context->supervisor_process != NULL &&
      context->supervisor_process != INVALID_HANDLE_VALUE) {
    (void)WaitForSingleObject(context->supervisor_process, INFINITE);
    CloseHandle(context->supervisor_process);
    context->supervisor_process = NULL;
  }
  if (context->supervisor_control >= 0) {
    (void)_close(context->supervisor_control);
    context->supervisor_control = -1;
  }
  if (context->supervisor_response >= 0) {
    (void)_close(context->supervisor_response);
    context->supervisor_response = -1;
  }
}

static int keiko_coordinator_windows_engine_deadline(
    void *opaque,
    int field,
    uint64_t *deadline_ms
) {
  return keiko_coordinator_windows_deadline(
      (keiko_coordinator_context *)opaque,
      field,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_emit_acceptance(void *opaque) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_windows_emit_acceptance(context);
}

static int keiko_coordinator_windows_engine_wait_old_exit(void *opaque) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_windows_wait_old_exit(context);
}

static int keiko_coordinator_windows_engine_promote(
    void *opaque,
    uint64_t deadline_ms
) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_promote_windows(context, deadline_ms);
}

static int keiko_coordinator_windows_engine_publish_registration(
    void *opaque,
    uint64_t deadline_ms
) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_publish_registration_windows(context, deadline_ms);
}

static int keiko_coordinator_windows_engine_start_runtime(
    void *opaque,
    uint64_t deadline_ms,
    int restoring
) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_windows_start_runtime(context, deadline_ms, restoring);
}

static int keiko_coordinator_windows_engine_wait_receipt(
    void *opaque,
    const char *kind,
    const char *outcome,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_wait_expected_receipt(
      (keiko_coordinator_context *)opaque,
      kind,
      outcome,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_next_receipt_exists(void *opaque) {
  return keiko_coordinator_windows_next_receipt_exists(
      (keiko_coordinator_context *)opaque
  );
}

static int keiko_coordinator_windows_engine_stop_runtime(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_stop_runtime(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_reconcile_stopped_runtime(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_reconcile_stopped_runtime(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_stop_failed_start(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_stop_failed_start(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_wait_verified_ack(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_windows_wait_verified_ack(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_windows_engine_cleanup_verified(
    void *opaque,
    uint64_t deadline_ms
) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_cleanup_verified_windows(context, deadline_ms);
}

static int keiko_coordinator_windows_engine_restore_previous(
    void *opaque,
    uint64_t deadline_ms
) {
  keiko_coordinator_context *context = (keiko_coordinator_context *)opaque;
  return keiko_coordinator_windows_managed_root_current(context) &&
         keiko_coordinator_restore_previous_windows(context, deadline_ms);
}

static void keiko_coordinator_windows_engine_hold_runtime(void *opaque) {
  keiko_coordinator_windows_hold_runtime((keiko_coordinator_context *)opaque);
}

/* Production forward/restore transaction. All authority checks complete before this function
 * emits KHA1 and releases the parent process to exit. */
static inline int keiko_coordinator_execute_windows(
    keiko_coordinator_context *context
) {
  const keiko_coordinator_engine engine = {
      context,
      keiko_coordinator_windows_engine_deadline,
      keiko_coordinator_windows_engine_emit_acceptance,
      keiko_coordinator_windows_engine_wait_old_exit,
      keiko_coordinator_windows_engine_promote,
      keiko_coordinator_windows_engine_publish_registration,
      keiko_coordinator_windows_engine_start_runtime,
      keiko_coordinator_windows_engine_wait_receipt,
      keiko_coordinator_windows_engine_next_receipt_exists,
      keiko_coordinator_windows_engine_stop_runtime,
      keiko_coordinator_windows_engine_reconcile_stopped_runtime,
      keiko_coordinator_windows_engine_stop_failed_start,
      keiko_coordinator_windows_engine_wait_verified_ack,
      keiko_coordinator_windows_engine_cleanup_verified,
      keiko_coordinator_windows_engine_restore_previous,
      keiko_coordinator_windows_engine_hold_runtime};
  return keiko_coordinator_execute_engine(
      &engine,
      KEIKO_KHP_START_AT,
      KEIKO_KHP_VERIFY_AT,
      KEIKO_KHP_CLEANUP_AT
  );
}

static int keiko_coordinator_windows_parent_image_matches(
    const wchar_t *expected_path,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  DWORD parent_pid;
  HANDLE parent = NULL;
  wchar_t *actual_path = NULL;
  DWORD capacity = KEIKO_WINDOWS_UPDATE_PATH_CAP;
  int result = 0;
  if (!keiko_coordinator_windows_parent_pid(&parent_pid)) return 0;
  parent = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent_pid);
  actual_path = (wchar_t *)calloc((size_t)capacity, sizeof(wchar_t));
  if (parent == NULL || actual_path == NULL || GetProcessId(parent) != parent_pid ||
      !QueryFullProcessImageNameW(parent, 0, actual_path, &capacity) ||
      _wcsicmp(actual_path, expected_path) != 0 ||
      !keiko_windows_update_file_digest_matches(
          expected_path,
          expected_sha256,
          deadline_ms
      )) goto cleanup;
  result = 1;
cleanup:
  free(actual_path);
  if (parent != NULL && parent != INVALID_HANDLE_VALUE) CloseHandle(parent);
  return result;
}

static inline int keiko_coordinator_prepare_resume_windows(
    keiko_coordinator_context *context,
    const char *activation_id,
    const wchar_t *executable,
    int restoring
) {
  DWORD state_length;
  wchar_t *state = NULL;
  wchar_t *handoff = NULL;
  wchar_t *expected_supervisor = NULL;
  keiko_coordinator_windows_paths paths;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  char gate[65];
  uint64_t deadline = (uint64_t)GetTickCount64() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  int result = 0;
  memset(context, 0, sizeof(*context));
  memset(&paths, 0, sizeof(paths));
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
    expected_supervisor = keiko_windows_update_path_join(
        context->capsule,
        L"\\runtime-supervisor.exe"
    );
  if (context->state_dir_utf8 == NULL || expected_supervisor == NULL ||
      !keiko_coordinator_windows_load_plan(context, activation_id, deadline) ||
      !keiko_coordinator_windows_paths_build(context, &paths) ||
      _wcsicmp(paths.launcher, executable) != 0 ||
      !keiko_windows_update_file_digest_matches(
          executable,
          context->plan.field[restoring ? KEIKO_KHP_CURRENT_LAUNCHER_SHA256
                                        : KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline
      ) ||
      !keiko_coordinator_windows_parent_image_matches(
          expected_supervisor,
          context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
          deadline
      ) ||
      !keiko_coordinator_windows_roots_same_volume(context) ||
      !keiko_coordinator_windows_classify(context, deadline, &prefix) ||
      prefix != (restoring ? KEIKO_WINDOWS_PREFIX_PREVIOUS
                           : KEIKO_WINDOWS_PREFIX_REGISTRATION) ||
      !keiko_coordinator_windows_read_exact_fd(
          _fileno(stdin),
          gate,
          sizeof(gate),
          deadline
      ) ||
      gate[64] != '\n' || memcmp(gate, context->plan_sha256, 64u) != 0) goto cleanup;
  (void)_close(_fileno(stdin));
  result = 1;
cleanup:
  keiko_coordinator_windows_paths_clear(&paths);
  free(expected_supervisor);
  free(handoff);
  free(state);
  SecureZeroMemory(gate, sizeof(gate));
  if (!result) keiko_coordinator_clear(context);
  return result;
}

#endif
