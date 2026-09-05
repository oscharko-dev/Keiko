#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00

#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

enum {
  KEIKO_PATH_CAP = 32768,
  KEIKO_SAMPLE_COUNT = 32,
  KEIKO_CONTENTION_ROUNDS = 24,
  KEIKO_READER_COUNT = 2,
  KEIKO_WAIT_MS = 3000
};

static const unsigned char KEIKO_OLD_BYTES[] = "keiko-cutover-old\n";
static const unsigned char KEIKO_NEW_BYTES[] = "keiko-cutover-new\n";

typedef struct {
  wchar_t root[KEIKO_PATH_CAP];
  wchar_t active[KEIKO_PATH_CAP];
  wchar_t pending[KEIKO_PATH_CAP];
  wchar_t ready[KEIKO_PATH_CAP];
} keiko_paths;

typedef struct {
  FILE_ID_INFO id;
  LARGE_INTEGER size;
} keiko_file_fact;

typedef struct {
  const wchar_t *active;
  volatile LONG stop;
  volatile LONG failed;
  volatile LONG request_epoch;
  volatile LONG release_epoch;
  volatile LONG held_count;
  volatile LONG complete_count;
  const unsigned char *old_bytes;
  const unsigned char *new_bytes;
  DWORD length;
} keiko_reader_context;

typedef struct {
  int success;
  int allowing_handle;
  int denying_handle;
  int invalid_candidate;
  int pre_termination;
  int post_termination;
  int contention;
  LONG flush_before_attempts;
  LONG flush_before_successes;
  LONG flush_after_attempts;
  LONG flush_after_successes;
  int first_failure_step;
  DWORD first_failure_error;
} keiko_results;

typedef enum {
  KEIKO_FAILURE_NONE = 0,
  KEIKO_FAILURE_SETUP = 1,
  KEIKO_FAILURE_INITIAL_OPEN = 2,
  KEIKO_FAILURE_INITIAL_READ_FACT = 3,
  KEIKO_FAILURE_RENAME_ALLOCATION = 4,
  KEIKO_FAILURE_RENAME_DIRECTORY_OPEN = 5,
  KEIKO_FAILURE_RENAME_SOURCE_OPEN = 6,
  KEIKO_FAILURE_RENAME_EXISTING_OPEN = 7,
  KEIKO_FAILURE_RENAME_SOURCE_FACT = 8,
  KEIKO_FAILURE_RENAME_EXISTING_FACT = 9,
  KEIKO_FAILURE_RENAME_DIRECTORY_ID = 10,
  KEIKO_FAILURE_RENAME_INVARIANT = 11,
  KEIKO_FAILURE_RENAME_CALL = 12,
  KEIKO_FAILURE_POST_RENAME_OPEN = 13,
  KEIKO_FAILURE_POST_RENAME_READ_FACT = 14,
  KEIKO_FAILURE_POST_RENAME_IDENTITY = 15,
  KEIKO_FAILURE_RETAINED_READ_FACT = 16,
  KEIKO_FAILURE_RETAINED_IDENTITY = 17,
  KEIKO_FAILURE_PENDING_STILL_PRESENT = 18,
  KEIKO_FAILURE_STABILITY_READ_FACT = 19,
  KEIKO_FAILURE_STABILITY_IDENTITY = 20
} keiko_first_failure_step;

static void record_first_failure(keiko_results *results, keiko_first_failure_step step, DWORD error) {
  if (results->first_failure_step != KEIKO_FAILURE_NONE) {
    return;
  }
  results->first_failure_step = step;
  results->first_failure_error = error;
  fprintf(
    stderr, "DEBUG-3405-cutover step=%d winerr=%lu\n", (int)step, (unsigned long)error
  );
}

static void close_if_valid(HANDLE handle) {
  if (handle != INVALID_HANDLE_VALUE && handle != NULL) {
    (void)CloseHandle(handle);
  }
}

static int path_join(wchar_t *out, size_t cap, const wchar_t *root, const wchar_t *leaf) {
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"%ls\\%ls", root, leaf);
  return written > 0 && (size_t)written < cap;
}

static int equal_id(const FILE_ID_INFO *left, const FILE_ID_INFO *right) {
  return left->VolumeSerialNumber == right->VolumeSerialNumber &&
         memcmp(left->FileId.Identifier, right->FileId.Identifier, sizeof(left->FileId.Identifier)) == 0;
}

static int query_fact(HANDLE handle, keiko_file_fact *fact) {
  return GetFileInformationByHandleEx(handle, FileIdInfo, &fact->id, sizeof(fact->id)) &&
         GetFileSizeEx(handle, &fact->size);
}

static int query_id(HANDLE handle, FILE_ID_INFO *id) {
  return GetFileInformationByHandleEx(handle, FileIdInfo, id, sizeof(*id));
}

static int is_regular_non_reparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) {
    return 0;
  }
  return (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

static int is_plain_directory(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))) {
    return 0;
  }
  return (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
         (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

static HANDLE open_regular(const wchar_t *path, DWORD access, DWORD share) {
  DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return INVALID_HANDLE_VALUE;
  }
  HANDLE handle = CreateFileW(
    path, access, share, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL
  );
  if (handle == INVALID_HANDLE_VALUE || !is_regular_non_reparse(handle)) {
    close_if_valid(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static HANDLE open_directory(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return INVALID_HANDLE_VALUE;
  }
  HANDLE handle = CreateFileW(
    path,
    FILE_LIST_DIRECTORY | FILE_TRAVERSE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    NULL
  );
  if (handle == INVALID_HANDLE_VALUE || !is_plain_directory(handle)) {
    close_if_valid(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static int parent_matches(HANDLE pinned_directory, const wchar_t *root, const FILE_ID_INFO *expected) {
  FILE_ID_INFO actual;
  HANDLE current = open_directory(root);
  int matches = current != INVALID_HANDLE_VALUE && query_id(current, &actual) &&
                equal_id(expected, &actual) && is_plain_directory(pinned_directory);
  close_if_valid(current);
  return matches;
}

static int write_bytes(const keiko_paths *paths, const wchar_t *path, const unsigned char *bytes, DWORD length,
                       keiko_results *results) {
  DWORD written = 0;
  FILE_ID_INFO directory_id;
  FILE_STANDARD_INFO standard;
  keiko_file_fact file_fact;
  HANDLE directory = open_directory(paths->root);
  if (directory == INVALID_HANDLE_VALUE || !query_id(directory, &directory_id)) {
    close_if_valid(directory);
    return 0;
  }
  HANDLE handle = CreateFileW(
    path,
    GENERIC_READ | GENERIC_WRITE,
    /* A freshly created fixture must remain exclusively held until its identity and parent are
     * revalidated; otherwise a second opener could race a new hard link into the write window. */
    0,
    NULL,
    CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
    NULL
  );
  if (handle == INVALID_HANDLE_VALUE || !is_regular_non_reparse(handle) ||
      !query_fact(handle, &file_fact) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      standard.NumberOfLinks != 1 || !parent_matches(directory, paths->root, &directory_id)) {
    close_if_valid(handle);
    close_if_valid(directory);
    return 0;
  }
  int ok = WriteFile(handle, bytes, length, &written, NULL) && written == length;
  InterlockedIncrement(&results->flush_before_attempts);
  if (ok && FlushFileBuffers(handle)) {
    InterlockedIncrement(&results->flush_before_successes);
  } else {
    ok = 0;
  }
  close_if_valid(handle);
  close_if_valid(directory);
  return ok;
}

static int read_exact_diagnostic(HANDLE handle, const unsigned char *expected, DWORD expected_length,
                                 keiko_file_fact *fact, DWORD *failure_error) {
  unsigned char buffer[64];
  DWORD read = 0;
  LARGE_INTEGER origin;
  origin.QuadPart = 0;
  if (expected_length > sizeof(buffer)) {
    if (failure_error != NULL) {
      *failure_error = ERROR_INVALID_PARAMETER;
    }
    return 0;
  }
  if (!query_fact(handle, fact)) {
    if (failure_error != NULL) {
      *failure_error = GetLastError();
    }
    return 0;
  }
  if (fact->size.QuadPart != (LONGLONG)expected_length) {
    if (failure_error != NULL) {
      *failure_error = ERROR_BAD_LENGTH;
    }
    return 0;
  }
  if (!SetFilePointerEx(handle, origin, NULL, FILE_BEGIN)) {
    if (failure_error != NULL) {
      *failure_error = GetLastError();
    }
    return 0;
  }
  if (!ReadFile(handle, buffer, expected_length, &read, NULL)) {
    if (failure_error != NULL) {
      *failure_error = GetLastError();
    }
    return 0;
  }
  if (read != expected_length || memcmp(buffer, expected, expected_length) != 0) {
    if (failure_error != NULL) {
      *failure_error = ERROR_INVALID_DATA;
    }
    return 0;
  }
  return 1;
}

static int read_exact(HANDLE handle, const unsigned char *expected, DWORD expected_length,
                      keiko_file_fact *fact) {
  return read_exact_diagnostic(handle, expected, expected_length, fact, NULL);
}

static int flush_after(HANDLE handle, keiko_results *results) {
  InterlockedIncrement(&results->flush_after_attempts);
  if (!FlushFileBuffers(handle)) {
    return 0;
  }
  InterlockedIncrement(&results->flush_after_successes);
  return 1;
}

static int snapshot_path(const wchar_t *path, const unsigned char *expected, DWORD length,
                         keiko_file_fact *fact, keiko_results *results) {
  HANDLE handle = open_regular(
    path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (handle == INVALID_HANDLE_VALUE) {
    return 0;
  }
  int ok = read_exact(handle, expected, length, fact) && flush_after(handle, results);
  close_if_valid(handle);
  return ok;
}

static int remove_owned_path(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
  }
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return 0;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return RemoveDirectoryW(path) != 0;
  }
  return DeleteFileW(path) != 0;
}

static int reset_pair(const keiko_paths *paths, const unsigned char *active, DWORD active_length,
                      const unsigned char *pending, DWORD pending_length, keiko_results *results) {
  return remove_owned_path(paths->active) && remove_owned_path(paths->pending) &&
         write_bytes(paths, paths->active, active, active_length, results) &&
         write_bytes(paths, paths->pending, pending, pending_length, results);
}

static void set_rename_failure(keiko_first_failure_step *failure_step, DWORD *failure_error,
                               keiko_first_failure_step step, DWORD error) {
  if (failure_step != NULL) {
    *failure_step = step;
  }
  if (failure_error != NULL) {
    *failure_error = error;
  }
}

static int rename_pending_diagnostic(const keiko_paths *paths, keiko_first_failure_step *failure_step,
                                     DWORD *failure_error) {
  const wchar_t *target_name = L"active.bin";
  const size_t target_bytes = wcslen(target_name) * sizeof(wchar_t);
  const size_t info_size = sizeof(FILE_RENAME_INFO) + target_bytes;
  FILE_RENAME_INFO *info = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, info_size);
  HANDLE source = INVALID_HANDLE_VALUE;
  HANDLE existing = INVALID_HANDLE_VALUE;
  HANDLE directory = INVALID_HANDLE_VALUE;
  keiko_file_fact source_fact;
  keiko_file_fact existing_fact;
  FILE_ID_INFO directory_id;
  int renamed = 0;
  DWORD directory_open_error = ERROR_SUCCESS;
  DWORD source_open_error = ERROR_SUCCESS;
  DWORD existing_open_error = ERROR_SUCCESS;

  if (info == NULL) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_ALLOCATION, ERROR_NOT_ENOUGH_MEMORY
    );
    return 0;
  }
  directory = open_directory(paths->root);
  if (directory == INVALID_HANDLE_VALUE) {
    directory_open_error = GetLastError();
  }
  source = open_regular(
    paths->pending,
    GENERIC_READ | GENERIC_WRITE | DELETE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (source == INVALID_HANDLE_VALUE) {
    source_open_error = GetLastError();
  }
  existing = open_regular(
    paths->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (existing == INVALID_HANDLE_VALUE) {
    existing_open_error = GetLastError();
  }
  if (directory == INVALID_HANDLE_VALUE) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_DIRECTORY_OPEN, directory_open_error
    );
    goto cleanup;
  }
  if (source == INVALID_HANDLE_VALUE) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_SOURCE_OPEN, source_open_error
    );
    goto cleanup;
  }
  if (existing == INVALID_HANDLE_VALUE) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_EXISTING_OPEN, existing_open_error
    );
    goto cleanup;
  }
  if (!query_fact(source, &source_fact)) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_SOURCE_FACT, GetLastError()
    );
    goto cleanup;
  }
  if (!query_fact(existing, &existing_fact)) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_EXISTING_FACT, GetLastError()
    );
    goto cleanup;
  }
  if (!query_id(directory, &directory_id)) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_DIRECTORY_ID, GetLastError()
    );
    goto cleanup;
  }
  if (source_fact.size.QuadPart <= 0 || existing_fact.size.QuadPart <= 0 ||
      source_fact.id.VolumeSerialNumber != directory_id.VolumeSerialNumber ||
      existing_fact.id.VolumeSerialNumber != directory_id.VolumeSerialNumber) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_INVARIANT, ERROR_INVALID_DATA
    );
    goto cleanup;
  }
  info->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
  info->RootDirectory = directory;
  info->FileNameLength = (DWORD)target_bytes;
  memcpy(info->FileName, target_name, target_bytes);
  renamed = SetFileInformationByHandle(source, FileRenameInfoEx, info, (DWORD)info_size) != 0;
  if (!renamed) {
    set_rename_failure(
      failure_step, failure_error, KEIKO_FAILURE_RENAME_CALL, GetLastError()
    );
  }

cleanup:
  close_if_valid(directory);
  close_if_valid(existing);
  close_if_valid(source);
  (void)HeapFree(GetProcessHeap(), 0, info);
  return renamed;
}

static int rename_pending(const keiko_paths *paths) {
  return rename_pending_diagnostic(paths, NULL, NULL);
}

static int create_paths(keiko_paths *paths) {
  DWORD length;
  ZeroMemory(paths, sizeof(*paths));
  length = GetTempPathW(KEIKO_PATH_CAP, paths->active);
  if (length == 0 || length >= KEIKO_PATH_CAP ||
      GetTempFileNameW(paths->active, L"kcp", 0, paths->pending) == 0 ||
      !DeleteFileW(paths->pending)) {
    return 0;
  }
  if (!CreateDirectoryW(paths->pending, NULL)) {
    return 0;
  }
  if (wcsncpy_s(paths->root, KEIKO_PATH_CAP, paths->pending, _TRUNCATE) != 0 ||
      !path_join(paths->active, KEIKO_PATH_CAP, paths->root, L"active.bin") ||
      !path_join(paths->pending, KEIKO_PATH_CAP, paths->root, L"pending.bin") ||
      !path_join(paths->ready, KEIKO_PATH_CAP, paths->root, L"child-ready.bin")) {
    (void)RemoveDirectoryW(paths->root);
    return 0;
  }
  return 1;
}

static void remove_paths(const keiko_paths *paths) {
  (void)remove_owned_path(paths->ready);
  (void)remove_owned_path(paths->pending);
  (void)remove_owned_path(paths->active);
  (void)RemoveDirectoryW(paths->root);
}

static int expect_namespace(const keiko_paths *paths, const unsigned char *active, DWORD active_length,
                            const unsigned char *pending, DWORD pending_length, int pending_exists,
                            keiko_results *results) {
  keiko_file_fact fact;
  if (!snapshot_path(paths->active, active, active_length, &fact, results)) {
    return 0;
  }
  if (pending_exists) {
    return snapshot_path(paths->pending, pending, pending_length, &fact, results);
  }
  return GetFileAttributesW(paths->pending) == INVALID_FILE_ATTRIBUTES;
}

static int case_success(const keiko_paths *paths, keiko_results *results) {
  HANDLE retained = INVALID_HANDLE_VALUE;
  keiko_file_fact before = {0};
  keiko_file_fact after = {0};
  FILE_ID_INFO old_id = {0};
  FILE_ID_INFO new_id = {0};
  keiko_first_failure_step failure_step = KEIKO_FAILURE_NONE;
  DWORD failure_error = ERROR_SUCCESS;
  int ok = reset_pair(
    paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  );
  if (!ok) {
    record_first_failure(results, KEIKO_FAILURE_SETUP, GetLastError());
    return 0;
  }
  retained = open_regular(
    paths->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (retained == INVALID_HANDLE_VALUE) {
    record_first_failure(results, KEIKO_FAILURE_INITIAL_OPEN, GetLastError());
    return 0;
  }
  ok = read_exact_diagnostic(
    retained, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &before, &failure_error
  );
  if (!ok) {
    record_first_failure(results, KEIKO_FAILURE_INITIAL_READ_FACT, failure_error);
  }
  if (ok) {
    old_id = before.id;
    ok = rename_pending_diagnostic(paths, &failure_step, &failure_error);
    if (!ok) {
      record_first_failure(results, failure_step, failure_error);
    }
  }
  HANDLE current = INVALID_HANDLE_VALUE;
  if (ok) {
    current = open_regular(
      paths->active, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    );
    if (current == INVALID_HANDLE_VALUE) {
      record_first_failure(results, KEIKO_FAILURE_POST_RENAME_OPEN, GetLastError());
      ok = 0;
    }
  }
  if (ok && !read_exact_diagnostic(
              current, KEIKO_NEW_BYTES, sizeof(KEIKO_NEW_BYTES) - 1, &after, &failure_error
            )) {
    record_first_failure(results, KEIKO_FAILURE_POST_RENAME_READ_FACT, failure_error);
    ok = 0;
  }
  if (ok && !flush_after(current, results)) {
    record_first_failure(results, KEIKO_FAILURE_POST_RENAME_READ_FACT, GetLastError());
    ok = 0;
  }
  close_if_valid(current);
  if (ok && equal_id(&old_id, &after.id)) {
    record_first_failure(results, KEIKO_FAILURE_POST_RENAME_IDENTITY, ERROR_INVALID_DATA);
    ok = 0;
  }
  if (ok && !read_exact_diagnostic(
              retained, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &before, &failure_error
            )) {
    record_first_failure(results, KEIKO_FAILURE_RETAINED_READ_FACT, failure_error);
    ok = 0;
  }
  if (ok && !equal_id(&old_id, &before.id)) {
    record_first_failure(results, KEIKO_FAILURE_RETAINED_IDENTITY, ERROR_INVALID_DATA);
    ok = 0;
  }
  if (ok && GetFileAttributesW(paths->pending) != INVALID_FILE_ATTRIBUTES) {
    record_first_failure(results, KEIKO_FAILURE_PENDING_STILL_PRESENT, ERROR_ALREADY_EXISTS);
    ok = 0;
  }
  if (ok) {
    new_id = after.id;
  }
  for (int sample = 0; ok && sample < KEIKO_SAMPLE_COUNT; sample++) {
    if (!snapshot_path(paths->active, KEIKO_NEW_BYTES, sizeof(KEIKO_NEW_BYTES) - 1, &after, results)) {
      record_first_failure(results, KEIKO_FAILURE_STABILITY_READ_FACT, GetLastError());
      ok = 0;
    } else if (!equal_id(&new_id, &after.id)) {
      record_first_failure(results, KEIKO_FAILURE_STABILITY_IDENTITY, ERROR_INVALID_DATA);
      ok = 0;
    }
  }
  close_if_valid(retained);
  return ok;
}

static int case_held_handles(const keiko_paths *paths, keiko_results *results) {
  HANDLE allowing = INVALID_HANDLE_VALUE;
  HANDLE denying = INVALID_HANDLE_VALUE;
  keiko_file_fact old_fact = {0};
  keiko_file_fact current_fact = {0};
  FILE_ID_INFO allowing_old_id = {0};
  FILE_ID_INFO denying_old_id = {0};
  int allowing_ok = reset_pair(
    paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  );
  if (allowing_ok) {
    allowing = open_regular(
      paths->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    );
    allowing_ok = allowing != INVALID_HANDLE_VALUE &&
                  read_exact(allowing, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &old_fact);
    if (allowing_ok) {
      allowing_old_id = old_fact.id;
      allowing_ok = rename_pending(paths) &&
                    read_exact(allowing, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &old_fact) &&
                    equal_id(&allowing_old_id, &old_fact.id) &&
                    snapshot_path(
                      paths->active, KEIKO_NEW_BYTES, sizeof(KEIKO_NEW_BYTES) - 1, &current_fact, results
                    ) && !equal_id(&allowing_old_id, &current_fact.id);
    }
  }
  close_if_valid(allowing);

  int denying_ok = reset_pair(
    paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  );
  if (denying_ok) {
    denying = open_regular(paths->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE);
    denying_ok = denying != INVALID_HANDLE_VALUE &&
                 read_exact(denying, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &old_fact);
    if (denying_ok) {
      denying_old_id = old_fact.id;
      denying_ok = !rename_pending(paths) &&
                   read_exact(denying, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &old_fact) &&
                   equal_id(&denying_old_id, &old_fact.id) &&
                   expect_namespace(
                     paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
                     sizeof(KEIKO_NEW_BYTES) - 1, 1, results
                   ) && snapshot_path(
                     paths->active, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, &current_fact, results
                   ) && equal_id(&denying_old_id, &current_fact.id);
    }
  }
  close_if_valid(denying);
  results->allowing_handle = allowing_ok;
  results->denying_handle = denying_ok;
  return allowing_ok && denying_ok;
}

static int case_invalid_candidate(const keiko_paths *paths, keiko_results *results) {
  int missing_rejected = remove_owned_path(paths->pending) && !rename_pending(paths);
  int directory_rejected = CreateDirectoryW(paths->pending, NULL) && !rename_pending(paths);
  int cleaned = remove_owned_path(paths->pending);
  results->invalid_candidate = missing_rejected && directory_rejected && cleaned;
  return results->invalid_candidate;
}

static int wait_for_ready(const keiko_paths *paths) {
  DWORD elapsed = 0;
  while (elapsed < KEIKO_WAIT_MS) {
    if (GetFileAttributesW(paths->ready) != INVALID_FILE_ATTRIBUTES) {
      return 1;
    }
    Sleep(20);
    elapsed += 20;
  }
  return 0;
}

static int child_mode(const wchar_t *mode, const wchar_t *root) {
  keiko_paths *paths = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*paths));
  keiko_results ignored;
  ZeroMemory(&ignored, sizeof(ignored));
  if (paths == NULL || wcslen(root) >= KEIKO_PATH_CAP || wcsstr(root, L"kcp") == NULL ||
      wcsncpy_s(paths->root, KEIKO_PATH_CAP, root, _TRUNCATE) != 0 ||
      !path_join(paths->active, KEIKO_PATH_CAP, paths->root, L"active.bin") ||
      !path_join(paths->pending, KEIKO_PATH_CAP, paths->root, L"pending.bin") ||
      !path_join(paths->ready, KEIKO_PATH_CAP, paths->root, L"child-ready.bin")) {
    if (paths != NULL) {
      (void)HeapFree(GetProcessHeap(), 0, paths);
    }
    return 1;
  }
  HANDLE source = open_regular(
    paths->pending, GENERIC_READ | GENERIC_WRITE | DELETE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  HANDLE directory = open_directory(paths->root);
  int ok = source != INVALID_HANDLE_VALUE && directory != INVALID_HANDLE_VALUE;
  if (ok && wcscmp(mode, L"--child-post") == 0) {
    ok = rename_pending(paths);
  }
  if (ok) {
    ok = write_bytes(paths, paths->ready, (const unsigned char *)"ready", 5, &ignored);
  }
  if (ok) {
    Sleep(30000);
  }
  close_if_valid(directory);
  close_if_valid(source);
  (void)HeapFree(GetProcessHeap(), 0, paths);
  return ok ? 0 : 1;
}

static int run_terminating_child(const wchar_t *mode, const keiko_paths *paths) {
  wchar_t *self = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, KEIKO_PATH_CAP * sizeof(*self));
  wchar_t *command = HeapAlloc(
    GetProcessHeap(), HEAP_ZERO_MEMORY, KEIKO_PATH_CAP * 2 * sizeof(*command)
  );
  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  DWORD self_length = self == NULL ? 0 : GetModuleFileNameW(NULL, self, KEIKO_PATH_CAP);
  if (self == NULL || command == NULL || self_length == 0 || self_length >= KEIKO_PATH_CAP ||
      _snwprintf_s(command, KEIKO_PATH_CAP * 2, _TRUNCATE, L"\"%ls\" %ls \"%ls\"", self, mode,
                   paths->root) <= 0) {
    if (command != NULL) {
      (void)HeapFree(GetProcessHeap(), 0, command);
    }
    if (self != NULL) {
      (void)HeapFree(GetProcessHeap(), 0, self);
    }
    return 0;
  }
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&child, sizeof(child));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(self, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, paths->root, &startup, &child)) {
    (void)HeapFree(GetProcessHeap(), 0, command);
    (void)HeapFree(GetProcessHeap(), 0, self);
    return 0;
  }
  int ready = wait_for_ready(paths);
  int terminated = TerminateProcess(child.hProcess, 73) != 0;
  int reaped = WaitForSingleObject(child.hProcess, KEIKO_WAIT_MS) == WAIT_OBJECT_0;
  int ok = ready && terminated && reaped;
  close_if_valid(child.hThread);
  close_if_valid(child.hProcess);
  (void)HeapFree(GetProcessHeap(), 0, command);
  (void)HeapFree(GetProcessHeap(), 0, self);
  return ok;
}

static int case_termination(const keiko_paths *paths, keiko_results *results) {
  int pre_ok = reset_pair(
    paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  ) && run_terminating_child(L"--child-pre", paths) &&
    expect_namespace(
      paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
      sizeof(KEIKO_NEW_BYTES) - 1, 1, results
    );
  (void)remove_owned_path(paths->ready);
  int post_ok = reset_pair(
    paths, KEIKO_OLD_BYTES, sizeof(KEIKO_OLD_BYTES) - 1, KEIKO_NEW_BYTES,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  ) && run_terminating_child(L"--child-post", paths) &&
    expect_namespace(
      paths, KEIKO_NEW_BYTES, sizeof(KEIKO_NEW_BYTES) - 1, NULL, 0, 0, results
    );
  results->pre_termination = pre_ok;
  results->post_termination = post_ok;
  return pre_ok && post_ok;
}

static int reader_failed(keiko_reader_context *context) {
  return InterlockedCompareExchange(&context->failed, 0, 0) != 0;
}

static int wait_for_count(volatile LONG *count, LONG expected, keiko_reader_context *context) {
  DWORD elapsed = 0;
  while (elapsed < KEIKO_WAIT_MS) {
    if (reader_failed(context)) {
      return 0;
    }
    if (InterlockedCompareExchange(count, 0, 0) == expected) {
      return 1;
    }
    Sleep(10);
    elapsed += 10;
  }
  return 0;
}

static DWORD WINAPI reader_main(LPVOID parameter) {
  keiko_reader_context *context = parameter;
  LONG seen_epoch = 0;
  while (InterlockedCompareExchange(&context->stop, 0, 0) == 0) {
    LONG requested = InterlockedCompareExchange(&context->request_epoch, 0, 0);
    if (requested <= seen_epoch) {
      Sleep(1);
      continue;
    }
    const unsigned char *old_bytes = context->old_bytes;
    const unsigned char *new_bytes = context->new_bytes;
    DWORD length = context->length;
    keiko_file_fact fact = {0};
    HANDLE held = open_regular(
      context->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    );
    if (held == INVALID_HANDLE_VALUE || !read_exact(held, old_bytes, length, &fact)) {
      InterlockedExchange(&context->failed, 1);
      close_if_valid(held);
      return 0;
    }
    InterlockedIncrement(&context->held_count);
    while (InterlockedCompareExchange(&context->release_epoch, 0, 0) < requested) {
      if (InterlockedCompareExchange(&context->stop, 0, 0) != 0) {
        close_if_valid(held);
        return 0;
      }
      Sleep(1);
    }
    if (!read_exact(held, old_bytes, length, &fact)) {
      InterlockedExchange(&context->failed, 1);
      close_if_valid(held);
      return 0;
    }
    close_if_valid(held);
    HANDLE fresh = open_regular(
      context->active, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    );
    if (fresh == INVALID_HANDLE_VALUE || !read_exact(fresh, new_bytes, length, &fact)) {
      InterlockedExchange(&context->failed, 1);
      close_if_valid(fresh);
      return 0;
    }
    close_if_valid(fresh);
    InterlockedIncrement(&context->complete_count);
    seen_epoch = requested;
  }
  return 0;
}

static void stop_and_reap_readers(HANDLE *readers, keiko_reader_context *context) {
  InterlockedExchange(&context->stop, 1);
  for (int index = 0; index < KEIKO_READER_COUNT; index++) {
    if (readers[index] == NULL) {
      continue;
    }
    if (WaitForSingleObject(readers[index], KEIKO_WAIT_MS) != WAIT_OBJECT_0) {
      (void)CancelSynchronousIo(readers[index]);
      if (WaitForSingleObject(readers[index], KEIKO_WAIT_MS) != WAIT_OBJECT_0) {
        fputs("windows-cutover-probe: FAIL reader-reap-timeout\n", stderr);
        ExitProcess(1);
      }
    }
    close_if_valid(readers[index]);
  }
}

static int case_contention(const keiko_paths *paths, keiko_results *results) {
  keiko_reader_context context;
  HANDLE readers[KEIKO_READER_COUNT] = {NULL, NULL};
  const unsigned char *active_bytes = KEIKO_OLD_BYTES;
  const unsigned char *pending_bytes = KEIKO_NEW_BYTES;
  int ok = reset_pair(
    paths, active_bytes, sizeof(KEIKO_OLD_BYTES) - 1, pending_bytes,
    sizeof(KEIKO_NEW_BYTES) - 1, results
  );
  ZeroMemory(&context, sizeof(context));
  context.active = paths->active;
  for (int index = 0; ok && index < KEIKO_READER_COUNT; index++) {
    readers[index] = CreateThread(NULL, 0, reader_main, &context, 0, NULL);
    ok = readers[index] != NULL;
  }
  for (int round = 1; ok && round <= KEIKO_CONTENTION_ROUNDS; round++) {
    InterlockedExchange(&context.held_count, 0);
    InterlockedExchange(&context.complete_count, 0);
    context.old_bytes = active_bytes;
    context.new_bytes = pending_bytes;
    context.length = sizeof(KEIKO_OLD_BYTES) - 1;
    MemoryBarrier();
    InterlockedExchange(&context.request_epoch, round);
    ok = wait_for_count(&context.held_count, KEIKO_READER_COUNT, &context) &&
         rename_pending(paths);
    if (ok) {
      InterlockedExchange(&context.release_epoch, round);
      ok = wait_for_count(&context.complete_count, KEIKO_READER_COUNT, &context) &&
           write_bytes(paths, paths->pending, active_bytes, sizeof(KEIKO_OLD_BYTES) - 1, results);
    }
    const unsigned char *previous_active = active_bytes;
    active_bytes = pending_bytes;
    pending_bytes = previous_active;
  }
  stop_and_reap_readers(readers, &context);
  results->contention = ok && !reader_failed(&context);
  return results->contention;
}

static void print_result(const keiko_results *results) {
  const char *status = results->success ? "PASS" : "FAIL";
  printf(
    "windows-cutover-probe: %s success=%d allowing=%d denying=%d invalid=%d pre=%d post=%d "
    "contention=%d flush-before=%ld/%ld flush-after=%ld/%ld first-failure-step=%d "
    "first-failure-winerr=%lu\n",
    status, results->success, results->allowing_handle, results->denying_handle,
    results->invalid_candidate, results->pre_termination, results->post_termination,
    results->contention, results->flush_before_successes, results->flush_before_attempts,
    results->flush_after_successes, results->flush_after_attempts, results->first_failure_step,
    (unsigned long)results->first_failure_error
  );
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && (wcscmp(argv[1], L"--child-pre") == 0 || wcscmp(argv[1], L"--child-post") == 0)) {
    return child_mode(argv[1], argv[2]);
  }
  if (argc != 1) {
    return 1;
  }
  keiko_paths *paths = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*paths));
  keiko_results results;
  ZeroMemory(&results, sizeof(results));
  int ready = paths != NULL && create_paths(paths);
  if (ready) {
    results.success = case_success(paths, &results);
    results.success = results.success && case_held_handles(paths, &results);
    results.success = results.success && case_invalid_candidate(paths, &results);
    results.success = results.success && case_termination(paths, &results);
    results.success = results.success && case_contention(paths, &results);
    results.success = results.success &&
                      results.flush_before_attempts == results.flush_before_successes &&
                      results.flush_after_attempts == results.flush_after_successes;
    remove_paths(paths);
  }
  if (paths != NULL) {
    (void)HeapFree(GetProcessHeap(), 0, paths);
  }
  print_result(&results);
  return results.success ? 0 : 1;
}
