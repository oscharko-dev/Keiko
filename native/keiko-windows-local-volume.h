#ifndef KEIKO_WINDOWS_LOCAL_VOLUME_H
#define KEIKO_WINDOWS_LOCAL_VOLUME_H

#if !defined(_WIN32)
#error "keiko-windows-local-volume.h requires Win32"
#endif

#include <windows.h>

#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP 32768u

typedef struct {
  HANDLE directory;
  FILE_ID_INFO identity;
  wchar_t *canonical_path;
} keiko_windows_local_volume_pin;

static void keiko_windows_local_volume_clear(keiko_windows_local_volume_pin *pin) {
  if (pin == NULL) return;
  if (pin->directory != NULL && pin->directory != INVALID_HANDLE_VALUE)
    CloseHandle(pin->directory);
  free(pin->canonical_path);
  memset(pin, 0, sizeof(*pin));
  pin->directory = INVALID_HANDLE_VALUE;
}

static int keiko_windows_local_volume_drive_type_allowed(UINT drive_type) {
  return drive_type == DRIVE_REMOVABLE || drive_type == DRIVE_FIXED ||
         drive_type == DRIVE_RAMDISK;
}

static int keiko_windows_local_volume_dos_absolute(const wchar_t *path) {
  size_t length;
  wchar_t drive;
  if (path == NULL) return 0;
  length = wcslen(path);
  if (length < 3u || length >= KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP) return 0;
  drive = path[0];
  return ((drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z')) &&
         path[1] == L':' && path[2] == L'\\' &&
         !(length > 3u && path[length - 1u] == L'\\');
}

static int keiko_windows_local_volume_same_path(
    const wchar_t *left,
    const wchar_t *right
) {
  size_t left_length;
  size_t right_length;
  if (left == NULL || right == NULL) return 0;
  left_length = wcslen(left);
  right_length = wcslen(right);
  while (left_length > 3u && left[left_length - 1u] == L'\\') --left_length;
  while (right_length > 3u && right[right_length - 1u] == L'\\') --right_length;
  return left_length == right_length && _wcsnicmp(left, right, left_length) == 0;
}

static int keiko_windows_local_volume_final_path(
    HANDLE directory,
    wchar_t output[KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP]
) {
  DWORD length = GetFinalPathNameByHandleW(
      directory,
      output,
      KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP,
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
  );
  if (length == 0 || length >= KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP) return 0;
  if (wcsncmp(output, L"\\\\?\\UNC\\", 8u) == 0 ||
      wcsncmp(output, L"\\\\.\\", 4u) == 0) return 0;
  if (wcsncmp(output, L"\\\\?\\", 4u) == 0) {
    memmove(output, output + 4u, (wcslen(output + 4u) + 1u) * sizeof(wchar_t));
  }
  return keiko_windows_local_volume_dos_absolute(output);
}

static int keiko_windows_local_volume_recheck(
    const keiko_windows_local_volume_pin *pin
) {
  FILE_ID_INFO identity;
  FILE_ATTRIBUTE_TAG_INFO tag;
  wchar_t *actual = NULL;
  wchar_t *volume = NULL;
  int result = 0;
  if (pin == NULL || pin->directory == NULL || pin->directory == INVALID_HANDLE_VALUE ||
      pin->canonical_path == NULL) return 0;
  actual = (wchar_t *)calloc(KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, sizeof(wchar_t));
  volume = (wchar_t *)calloc(KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, sizeof(wchar_t));
  if (actual == NULL || volume == NULL ||
      !GetFileInformationByHandleEx(
          pin->directory,
          FileAttributeTagInfo,
          &tag,
          sizeof(tag)
      ) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !GetFileInformationByHandleEx(
          pin->directory,
          FileIdInfo,
          &identity,
          sizeof(identity)
      ) ||
      identity.VolumeSerialNumber != pin->identity.VolumeSerialNumber ||
      memcmp(
          identity.FileId.Identifier,
          pin->identity.FileId.Identifier,
          sizeof(identity.FileId.Identifier)
      ) != 0 ||
      !keiko_windows_local_volume_final_path(pin->directory, actual) ||
      !keiko_windows_local_volume_same_path(actual, pin->canonical_path) ||
      !GetVolumePathNameW(
          actual,
          volume,
          KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP
      ) ||
      !keiko_windows_local_volume_drive_type_allowed(GetDriveTypeW(volume))) goto cleanup;
  result = 1;
cleanup:
  free(volume);
  free(actual);
  return result;
}

static int keiko_windows_local_volume_pin_path(
    const wchar_t *path,
    int require_exact,
    keiko_windows_local_volume_pin *pin
) {
  wchar_t *full = NULL;
  wchar_t *existing = NULL;
  wchar_t *final = NULL;
  wchar_t *separator;
  DWORD length;
  DWORD attributes;
  DWORD error;
  FILE_ATTRIBUTE_TAG_INFO tag;
  int result = 0;
  if (pin == NULL) return 0;
  memset(pin, 0, sizeof(*pin));
  pin->directory = INVALID_HANDLE_VALUE;
  if (!keiko_windows_local_volume_dos_absolute(path)) return 0;
  full = (wchar_t *)calloc(KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, sizeof(wchar_t));
  existing = (wchar_t *)calloc(KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, sizeof(wchar_t));
  final = (wchar_t *)calloc(KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, sizeof(wchar_t));
  if (full == NULL || existing == NULL || final == NULL) goto cleanup;
  length = GetFullPathNameW(
      path,
      KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP,
      full,
      NULL
  );
  if (length == 0 || length >= KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP ||
      !keiko_windows_local_volume_same_path(path, full) ||
      wcscpy_s(existing, KEIKO_WINDOWS_LOCAL_VOLUME_PATH_CAP, full) != 0) goto cleanup;
  for (;;) {
    attributes = GetFileAttributesW(existing);
    if (attributes != INVALID_FILE_ATTRIBUTES) break;
    error = GetLastError();
    if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) goto cleanup;
    if (require_exact) goto cleanup;
    if (wcslen(existing) <= 3u) goto cleanup;
    separator = wcsrchr(existing, L'\\');
    if (separator == NULL || separator < existing + 2u) goto cleanup;
    if (separator == existing + 2u) {
      existing[3] = L'\0';
    } else {
      *separator = L'\0';
    }
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) goto cleanup;
  pin->directory = CreateFileW(
      existing,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  if (pin->directory == NULL || pin->directory == INVALID_HANDLE_VALUE ||
      !GetFileInformationByHandleEx(
          pin->directory,
          FileAttributeTagInfo,
          &tag,
          sizeof(tag)
      ) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !GetFileInformationByHandleEx(
          pin->directory,
          FileIdInfo,
          &pin->identity,
          sizeof(pin->identity)
      ) ||
      !keiko_windows_local_volume_final_path(pin->directory, final) ||
      !keiko_windows_local_volume_same_path(existing, final)) goto cleanup;
  pin->canonical_path = final;
  final = NULL;
  if (!keiko_windows_local_volume_recheck(pin)) goto cleanup;
  result = 1;
cleanup:
  free(final);
  free(existing);
  free(full);
  if (!result) keiko_windows_local_volume_clear(pin);
  return result;
}

#endif
