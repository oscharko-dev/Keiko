#ifndef KEIKO_PORTABLE_WINDOWS_ATOMIC_REPLACE_H
#define KEIKO_PORTABLE_WINDOWS_ATOMIC_REPLACE_H

#if !defined(_WIN32)
#error "keiko-portable-windows-atomic-replace.h requires Win32"
#endif

#include <windows.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef KEIKO_WINDOWS_ATOMIC_REPLACE_CHECKPOINT
#define KEIKO_WINDOWS_ATOMIC_REPLACE_CHECKPOINT(name) (1)
#endif

typedef struct {
  FILE_ID_INFO identity;
  FILE_STANDARD_INFO standard;
} keiko_windows_atomic_file_fact;

static int keiko_windows_atomic_query_fact(
    HANDLE handle,
    keiko_windows_atomic_file_fact *fact
) {
  if (handle == NULL || handle == INVALID_HANDLE_VALUE || fact == NULL) return 0;
  return GetFileInformationByHandleEx(
             handle,
             FileIdInfo,
             &fact->identity,
             sizeof(fact->identity)
         ) != 0 &&
         GetFileInformationByHandleEx(
             handle,
             FileStandardInfo,
             &fact->standard,
             sizeof(fact->standard)
         ) != 0;
}

static int keiko_windows_atomic_same_file(
    const keiko_windows_atomic_file_fact *left,
    const keiko_windows_atomic_file_fact *right
) {
  return left != NULL && right != NULL &&
         left->identity.VolumeSerialNumber == right->identity.VolumeSerialNumber &&
         memcmp(
             left->identity.FileId.Identifier,
             right->identity.FileId.Identifier,
             sizeof(left->identity.FileId.Identifier)
         ) == 0;
}

static HANDLE keiko_windows_atomic_open_directory(
    const wchar_t *path,
    DWORD access,
    DWORD share
) {
  HANDLE handle = CreateFileW(
      path,
      access,
      share,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  FILE_ATTRIBUTE_TAG_INFO tag;
  keiko_windows_atomic_file_fact fact;
  if (handle == INVALID_HANDLE_VALUE || handle == NULL ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !keiko_windows_atomic_query_fact(handle, &fact) || fact.standard.DeletePending) {
    if (handle != INVALID_HANDLE_VALUE && handle != NULL) CloseHandle(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static HANDLE keiko_windows_atomic_open_regular(
    const wchar_t *path,
    DWORD access,
    DWORD share
) {
  HANDLE handle = CreateFileW(
      path,
      access,
      share,
      NULL,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  FILE_ATTRIBUTE_TAG_INFO tag;
  keiko_windows_atomic_file_fact fact;
  if (handle == INVALID_HANDLE_VALUE || handle == NULL ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !keiko_windows_atomic_query_fact(handle, &fact) || fact.standard.DeletePending ||
      fact.standard.NumberOfLinks != 1) {
    if (handle != INVALID_HANDLE_VALUE && handle != NULL) CloseHandle(handle);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static int keiko_windows_atomic_parent_matches(
    const wchar_t *path,
    const keiko_windows_atomic_file_fact *expected_parent
) {
  wchar_t *parent = NULL;
  size_t length;
  wchar_t *separator;
  HANDLE handle;
  keiko_windows_atomic_file_fact actual;
  int result;
  if (path == NULL || expected_parent == NULL) return 0;
  length = wcslen(path);
  if (length == 0 || length >= 32768u || length > (SIZE_MAX / sizeof(wchar_t)) - 1u)
    return 0;
  parent = (wchar_t *)malloc((length + 1u) * sizeof(wchar_t));
  if (parent == NULL) return 0;
  memcpy(parent, path, (length + 1u) * sizeof(wchar_t));
  separator = wcsrchr(parent, L'\\');
  if (separator == NULL) separator = wcsrchr(parent, L'/');
  if (separator == NULL || separator == parent) {
    free(parent);
    return 0;
  }
  *separator = L'\0';
  handle = keiko_windows_atomic_open_directory(
      parent,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  free(parent);
  if (handle == INVALID_HANDLE_VALUE || handle == NULL) return 0;
  result = keiko_windows_atomic_query_fact(handle, &actual) &&
           keiko_windows_atomic_same_file(&actual, expected_parent);
  CloseHandle(handle);
  return result;
}

static int keiko_windows_atomic_destination_absent(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  DWORD error;
  if (attributes != INVALID_FILE_ATTRIBUTES) return 0;
  error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

static int keiko_windows_atomic_retryable(DWORD error) {
  return error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION ||
         error == ERROR_ACCESS_DENIED;
}

/*
 * Replace an existing file while parent, source, and destination identities
 * remain pinned. The caller creates and flushes the source before this call and
 * verifies the destination identity and bytes afterwards.
 */
static inline int keiko_windows_atomic_replace_existing(
    const wchar_t *parent_path,
    const wchar_t *source_path,
    const wchar_t *destination_path,
    ULONGLONG deadline_ms,
    HANDLE *published_handle
) {
  HANDLE parent = INVALID_HANDLE_VALUE;
  HANDLE source = INVALID_HANDLE_VALUE;
  HANDLE destination = INVALID_HANDLE_VALUE;
  HANDLE namespace_handle = INVALID_HANDLE_VALUE;
  FILE_RENAME_INFO *rename_info = NULL;
  keiko_windows_atomic_file_fact parent_fact;
  keiko_windows_atomic_file_fact source_fact;
  keiko_windows_atomic_file_fact destination_fact;
  int result = 0;
  size_t destination_chars;
  size_t rename_size;
  size_t attempt;
  static const DWORD backoff_ms[] = {0, 20, 40, 80, 160, 320};

  if (published_handle != NULL) *published_handle = INVALID_HANDLE_VALUE;
  if (parent_path == NULL || source_path == NULL || destination_path == NULL ||
      published_handle == NULL) return 0;
  parent = keiko_windows_atomic_open_directory(
      parent_path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  source = keiko_windows_atomic_open_regular(
      source_path,
      GENERIC_READ | GENERIC_WRITE | DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  destination = keiko_windows_atomic_open_regular(
      destination_path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (parent == INVALID_HANDLE_VALUE || parent == NULL ||
      source == INVALID_HANDLE_VALUE || source == NULL ||
      destination == INVALID_HANDLE_VALUE || destination == NULL ||
      !keiko_windows_atomic_query_fact(parent, &parent_fact) ||
      !keiko_windows_atomic_query_fact(source, &source_fact) ||
      !keiko_windows_atomic_query_fact(destination, &destination_fact) ||
      source_fact.identity.VolumeSerialNumber != parent_fact.identity.VolumeSerialNumber ||
      destination_fact.identity.VolumeSerialNumber != parent_fact.identity.VolumeSerialNumber ||
      !keiko_windows_atomic_parent_matches(source_path, &parent_fact) ||
      !keiko_windows_atomic_parent_matches(destination_path, &parent_fact)) {
    goto cleanup;
  }

  destination_chars = wcslen(destination_path);
  if (destination_chars == 0 ||
      destination_chars > (SIZE_MAX - sizeof(FILE_RENAME_INFO)) / sizeof(wchar_t)) {
    goto cleanup;
  }
  rename_size = sizeof(FILE_RENAME_INFO) + destination_chars * sizeof(wchar_t);
  rename_info = (FILE_RENAME_INFO *)calloc(1, rename_size);
  if (rename_info == NULL) goto cleanup;
  rename_info->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS |
                       FILE_RENAME_FLAG_POSIX_SEMANTICS;
  rename_info->RootDirectory = NULL;
  rename_info->FileNameLength = (DWORD)(destination_chars * sizeof(wchar_t));
  memcpy(rename_info->FileName, destination_path, destination_chars * sizeof(wchar_t));

  for (attempt = 0; attempt < sizeof(backoff_ms) / sizeof(backoff_ms[0]); ++attempt) {
    DWORD error;
    if (backoff_ms[attempt] != 0) {
      ULONGLONG now = GetTickCount64();
      if (now >= deadline_ms || backoff_ms[attempt] > deadline_ms - now) break;
      Sleep(backoff_ms[attempt]);
    }
    if (SetFileInformationByHandle(
            source,
            FileRenameInfoEx,
            rename_info,
            (DWORD)rename_size
        )) {
      keiko_windows_atomic_file_fact renamed_source_fact;
      keiko_windows_atomic_file_fact published_fact;
      namespace_handle = keiko_windows_atomic_open_regular(
          destination_path,
          FILE_READ_ATTRIBUTES,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
      );
      if (namespace_handle != INVALID_HANDLE_VALUE && namespace_handle != NULL &&
          keiko_windows_atomic_query_fact(source, &renamed_source_fact) &&
          keiko_windows_atomic_query_fact(namespace_handle, &published_fact) &&
          keiko_windows_atomic_same_file(&source_fact, &renamed_source_fact) &&
          keiko_windows_atomic_same_file(&renamed_source_fact, &published_fact) &&
          renamed_source_fact.standard.EndOfFile.QuadPart ==
              published_fact.standard.EndOfFile.QuadPart &&
          keiko_windows_atomic_parent_matches(destination_path, &parent_fact) &&
          GetTickCount64() <= deadline_ms &&
          KEIKO_WINDOWS_ATOMIC_REPLACE_CHECKPOINT("post-rename-before-flush") &&
          FlushFileBuffers(source)) result = 1;
      break;
    }
    error = GetLastError();
    if (!keiko_windows_atomic_retryable(error) || GetTickCount64() >= deadline_ms) break;
  }

cleanup:
  free(rename_info);
  if (result) {
    *published_handle = source;
    source = INVALID_HANDLE_VALUE;
  }
  if (namespace_handle != INVALID_HANDLE_VALUE && namespace_handle != NULL)
    CloseHandle(namespace_handle);
  if (destination != INVALID_HANDLE_VALUE && destination != NULL) CloseHandle(destination);
  if (source != INVALID_HANDLE_VALUE && source != NULL) CloseHandle(source);
  if (parent != INVALID_HANDLE_VALUE && parent != NULL) CloseHandle(parent);
  return result;
}

/* Atomically publishes an already verified incoming directory to an absent name. */
static inline int keiko_windows_atomic_publish_directory(
    const wchar_t *parent_path,
    const wchar_t *source_path,
    const wchar_t *destination_path,
    ULONGLONG deadline_ms
) {
  HANDLE parent = INVALID_HANDLE_VALUE;
  HANDLE source = INVALID_HANDLE_VALUE;
  FILE_RENAME_INFO *rename_info = NULL;
  keiko_windows_atomic_file_fact parent_fact;
  keiko_windows_atomic_file_fact source_fact;
  size_t destination_chars;
  size_t rename_size;
  size_t attempt;
  int result = 0;
  static const DWORD backoff_ms[] = {0, 20, 40, 80, 160, 320};

  if (parent_path == NULL || source_path == NULL || destination_path == NULL ||
      !keiko_windows_atomic_destination_absent(destination_path)) return 0;
  parent = keiko_windows_atomic_open_directory(
      parent_path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  source = keiko_windows_atomic_open_directory(
      source_path,
      DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  );
  if (parent == INVALID_HANDLE_VALUE || parent == NULL ||
      source == INVALID_HANDLE_VALUE || source == NULL ||
      !keiko_windows_atomic_query_fact(parent, &parent_fact) ||
      !keiko_windows_atomic_query_fact(source, &source_fact) ||
      source_fact.identity.VolumeSerialNumber != parent_fact.identity.VolumeSerialNumber ||
      !keiko_windows_atomic_parent_matches(source_path, &parent_fact) ||
      !keiko_windows_atomic_destination_absent(destination_path)) {
    goto cleanup;
  }

  destination_chars = wcslen(destination_path);
  if (destination_chars == 0 ||
      destination_chars > (SIZE_MAX - sizeof(FILE_RENAME_INFO)) / sizeof(wchar_t)) {
    goto cleanup;
  }
  rename_size = sizeof(FILE_RENAME_INFO) + destination_chars * sizeof(wchar_t);
  rename_info = (FILE_RENAME_INFO *)calloc(1, rename_size);
  if (rename_info == NULL) goto cleanup;
  rename_info->Flags = FILE_RENAME_FLAG_POSIX_SEMANTICS;
  rename_info->RootDirectory = NULL;
  rename_info->FileNameLength = (DWORD)(destination_chars * sizeof(wchar_t));
  memcpy(rename_info->FileName, destination_path, destination_chars * sizeof(wchar_t));

  for (attempt = 0; attempt < sizeof(backoff_ms) / sizeof(backoff_ms[0]); ++attempt) {
    DWORD error;
    if (backoff_ms[attempt] != 0) {
      ULONGLONG now = GetTickCount64();
      if (now >= deadline_ms || backoff_ms[attempt] > deadline_ms - now) break;
      Sleep(backoff_ms[attempt]);
    }
    if (!keiko_windows_atomic_destination_absent(destination_path)) break;
    if (SetFileInformationByHandle(
            source,
            FileRenameInfoEx,
            rename_info,
            (DWORD)rename_size
        )) {
      result = 1;
      break;
    }
    error = GetLastError();
    if (!keiko_windows_atomic_retryable(error) || GetTickCount64() >= deadline_ms) break;
  }

cleanup:
  free(rename_info);
  if (source != INVALID_HANDLE_VALUE && source != NULL) CloseHandle(source);
  if (parent != INVALID_HANDLE_VALUE && parent != NULL) CloseHandle(parent);
  return result;
}

#endif
