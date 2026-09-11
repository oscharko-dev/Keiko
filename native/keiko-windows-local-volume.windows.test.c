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

static void test_canonical_directory_path(
    const wchar_t *path,
    wchar_t output[TEST_PATH_CAP]
) {
  HANDLE directory = CreateFileW(
      path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  assert(directory != INVALID_HANDLE_VALUE && directory != NULL);
  assert(keiko_windows_local_volume_final_path(directory, output));
  assert(CloseHandle(directory));
}

static void test_local_pin_and_nearest_ancestor(void) {
  wchar_t *temporary = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *root = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *canonical = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *missing = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  wchar_t *renamed = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  keiko_windows_local_volume_pin pin;
  assert(temporary != NULL && root != NULL && canonical != NULL && missing != NULL &&
         renamed != NULL);
  assert(GetTempPathW(TEST_PATH_CAP, temporary) > 0);
  assert(GetTempFileNameW(temporary, L"klv", 0, root) != 0);
  assert(DeleteFileW(root));
  assert(CreateDirectoryW(root, NULL));
  test_canonical_directory_path(root, canonical);
  if (!keiko_windows_local_volume_same_path(root, canonical)) {
    assert(!keiko_windows_local_volume_pin_path(root, 1, &pin));
  }
  test_join(missing, canonical, L"\\missing\\managed");
  test_join(renamed, canonical, L"-renamed");
  assert(keiko_windows_local_volume_pin_path(canonical, 1, &pin));
  assert(keiko_windows_local_volume_recheck(&pin));
  assert(!MoveFileExW(canonical, renamed, MOVEFILE_WRITE_THROUGH));
  keiko_windows_local_volume_clear(&pin);
  assert(keiko_windows_local_volume_pin_path(missing, 0, &pin));
  assert(keiko_windows_local_volume_recheck(&pin));
  keiko_windows_local_volume_clear(&pin);
  assert(!keiko_windows_local_volume_pin_path(missing, 1, &pin));
  assert(RemoveDirectoryW(root));
  free(renamed);
  free(missing);
  free(canonical);
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
