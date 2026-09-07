#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <assert.h>
#include <stdio.h>
#include <wchar.h>
#include <windows.h>

#include "keiko-windows-local-volume.h"

enum { TEST_PATH_CAP = 32768 };

static void test_join(
    wchar_t output[TEST_PATH_CAP],
    const wchar_t *base,
    const wchar_t *suffix
) {
  int written = _snwprintf_s(output, TEST_PATH_CAP, _TRUNCATE, L"%ls%ls", base, suffix);
  assert(written > 0 && written < TEST_PATH_CAP);
}

static void test_classify_local_pin_failure(const wchar_t *path) {
  wchar_t *full = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *final = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *volume = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  HANDLE directory = INVALID_HANDLE_VALUE;
  FILE_ATTRIBUTE_TAG_INFO tag;
  FILE_ID_INFO identity;
  DWORD attributes = INVALID_FILE_ATTRIBUTES;
  DWORD length = 0;
  DWORD open_error = ERROR_SUCCESS;
  DWORD final_error = ERROR_SUCCESS;
  DWORD volume_error = ERROR_SUCCESS;
  UINT drive_type = DRIVE_UNKNOWN;
  unsigned int stages = 0u;
  assert(full != NULL && final != NULL && volume != NULL);
  if (keiko_windows_local_volume_dos_absolute(path)) stages |= 1u;
  length = GetFullPathNameW(path, TEST_PATH_CAP, full, NULL);
  if (length > 0 && length < TEST_PATH_CAP) stages |= 2u;
  if ((stages & 2u) != 0u && keiko_windows_local_volume_same_path(path, full)) stages |= 4u;
  attributes = GetFileAttributesW(path);
  if (attributes != INVALID_FILE_ATTRIBUTES &&
      (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) stages |= 8u;
  directory = CreateFileW(
      path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  if (directory != INVALID_HANDLE_VALUE && directory != NULL) {
    stages |= 16u;
  } else {
    open_error = GetLastError();
  }
  if ((stages & 16u) != 0u && GetFileInformationByHandleEx(
          directory,
          FileAttributeTagInfo,
          &tag,
          sizeof(tag)
      ) && (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) stages |= 32u;
  if ((stages & 16u) != 0u && GetFileInformationByHandleEx(
          directory,
          FileIdInfo,
          &identity,
          sizeof(identity)
      )) stages |= 64u;
  if ((stages & 16u) != 0u &&
      keiko_windows_local_volume_final_path(directory, final)) {
    stages |= 128u;
  } else if ((stages & 16u) != 0u) {
    final_error = GetLastError();
  }
  if ((stages & 128u) != 0u && keiko_windows_local_volume_same_path(path, final))
    stages |= 256u;
  if ((stages & 128u) != 0u && GetVolumePathNameW(final, volume, TEST_PATH_CAP)) {
    stages |= 512u;
    drive_type = GetDriveTypeW(volume);
    if (keiko_windows_local_volume_drive_type_allowed(drive_type)) stages |= 1024u;
  } else if ((stages & 128u) != 0u) {
    volume_error = GetLastError();
  }
  fprintf(
      stderr,
      "windows-local-volume-positive: stages=%u open=%lu final=%lu volume=%lu drive=%u\n",
      stages,
      (unsigned long)open_error,
      (unsigned long)final_error,
      (unsigned long)volume_error,
      drive_type
  );
  if (directory != INVALID_HANDLE_VALUE && directory != NULL) CloseHandle(directory);
  free(volume);
  free(final);
  free(full);
}

static void test_local_pin_and_nearest_ancestor(void) {
  wchar_t *temporary = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *root = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *missing = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *renamed = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  keiko_windows_local_volume_pin pin;
  assert(temporary != NULL && root != NULL && missing != NULL && renamed != NULL);
  assert(GetTempPathW(TEST_PATH_CAP, temporary) > 0);
  assert(GetTempFileNameW(temporary, L"klv", 0, root) != 0);
  assert(DeleteFileW(root));
  assert(CreateDirectoryW(root, NULL));
  test_join(missing, root, L"\\missing\\managed");
  test_join(renamed, root, L"-renamed");
  if (!keiko_windows_local_volume_pin_path(root, 1, &pin)) {
    test_classify_local_pin_failure(root);
    assert(0 && "local directory pin failed");
  }
  assert(keiko_windows_local_volume_recheck(&pin));
  assert(!MoveFileExW(root, renamed, MOVEFILE_WRITE_THROUGH));
  keiko_windows_local_volume_clear(&pin);
  assert(keiko_windows_local_volume_pin_path(missing, 0, &pin));
  assert(keiko_windows_local_volume_recheck(&pin));
  keiko_windows_local_volume_clear(&pin);
  assert(!keiko_windows_local_volume_pin_path(missing, 1, &pin));
  assert(RemoveDirectoryW(root));
  free(renamed);
  free(missing);
  free(root);
  free(temporary);
}

static void test_closed_path_and_drive_policy(void) {
  keiko_windows_local_volume_pin pin;
  assert(keiko_windows_local_volume_drive_type_allowed(DRIVE_REMOVABLE));
  assert(keiko_windows_local_volume_drive_type_allowed(DRIVE_FIXED));
  assert(keiko_windows_local_volume_drive_type_allowed(DRIVE_RAMDISK));
  assert(!keiko_windows_local_volume_drive_type_allowed(DRIVE_UNKNOWN));
  assert(!keiko_windows_local_volume_drive_type_allowed(DRIVE_NO_ROOT_DIR));
  assert(!keiko_windows_local_volume_drive_type_allowed(DRIVE_REMOTE));
  assert(!keiko_windows_local_volume_drive_type_allowed(DRIVE_CDROM));
  assert(!keiko_windows_local_volume_pin_path(L"\\\\server\\share\\Keiko", 0, &pin));
  assert(!keiko_windows_local_volume_pin_path(L"\\\\?\\UNC\\server\\share\\Keiko", 0, &pin));
  assert(!keiko_windows_local_volume_pin_path(L"Keiko", 0, &pin));
  assert(!keiko_windows_local_volume_pin_path(L"C:\\Windows\\..\\Windows", 0, &pin));
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && wcscmp(argv[1], L"--probe") == 0) {
    keiko_windows_local_volume_pin pin;
    int result = keiko_windows_local_volume_pin_path(argv[2], 0, &pin);
    if (result) keiko_windows_local_volume_clear(&pin);
    return result ? 0 : 1;
  }
  if (argc != 1) return 2;
  test_closed_path_and_drive_policy();
  test_local_pin_and_nearest_ancestor();
  return 0;
}
