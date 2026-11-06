/* A checked execution copy delegates only to the digest-pinned executable of the
 * running SCM service. The installed helper subsequently authenticates the actual pipe. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <process.h>
#include <stdlib.h>
#include <wchar.h>
#include "gateway_install.h"
#include "../../portable-launcher/keiko-portable-sha256.h"

BOOL keiko_gateway_image_matches(HANDLE image, const wchar_t *pin) {
  BYTE bytes[4096], digest[32];
  char hex[65];
  DWORD count;
  keiko_sha256 hash;
  if (wcslen(pin) != 64 || !keiko_sha256_init(&hash)) return FALSE;
  do {
    if (!ReadFile(image, bytes, sizeof(bytes), &count, NULL) ||
        !keiko_sha256_update(&hash, bytes, count)) {
      keiko_sha256_clear(&hash);
      return FALSE;
    }
  } while (count);
  if (!keiko_sha256_final(&hash, digest)) return FALSE;
  keiko_sha256_hex(digest, hex);
  for (size_t i = 0; i < 64; i++) if (pin[i] != (wchar_t)hex[i]) return FALSE;
  return TRUE;
}

BOOL keiko_gateway_protected_image_path(const wchar_t *path) {
  wchar_t *program_files = NULL;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, NULL, &program_files))) return FALSE;
  size_t prefix = wcslen(program_files);
  size_t length = wcslen(path);
  BOOL ok = length > prefix + 5 && path[prefix] == L'\\' &&
      CompareStringOrdinal(path, (int)prefix, program_files, (int)prefix, TRUE) == CSTR_EQUAL &&
      _wcsicmp(path + length - 4, L".exe") == 0 && !wcschr(path + 2, L':');
  CoTaskMemFree(program_files);
  return ok;
}

BOOL keiko_gateway_service_command_image(const wchar_t *command, wchar_t *path, DWORD length) {
  static const wchar_t suffix[] = L"\" --gateway-service";
  const wchar_t *end;
  size_t image;
  if (command == NULL || path == NULL || length == 0 || command[0] != L'"') return FALSE;
  end = wcschr(command + 1, L'"');
  if (end == NULL || wcscmp(end, suffix) != 0) return FALSE;
  image = (size_t)(end - (command + 1));
  if (image == 0 || image >= length) return FALSE;
  wmemcpy(path, command + 1, image);
  path[image] = L'\0';
  return TRUE;
}

static BOOL configured_image(SC_HANDLE service, wchar_t *path, DWORD length) {
  QUERY_SERVICE_CONFIGW *config = NULL;
  DWORD needed = 0;
  BOOL ok = FALSE;
  if (QueryServiceConfigW(service, NULL, 0, &needed) || GetLastError() != ERROR_INSUFFICIENT_BUFFER)
    return FALSE;
  config = malloc(needed);
  if (config != NULL && QueryServiceConfigW(service, config, needed, &needed) &&
      config->dwServiceType == SERVICE_WIN32_OWN_PROCESS)
    ok = keiko_gateway_service_command_image(config->lpBinaryPathName, path, length);
  free(config);
  return ok;
}

/* #4068: the image of the running service comes from its configuration, which the default service
 * DACL lets an interactive standard user read. The service process runs as LocalSystem and denies
 * that user PROCESS_QUERY_LIMITED_INFORMATION, so asking the process failed with
 * ERROR_ACCESS_DENIED on every non-elevated status read and launch. A configuration that names
 * another image than the one running fails closed later, at the broker's image-identity
 * authentication of the pipe client. */
BOOL keiko_gateway_running_image(wchar_t *path, DWORD length) {
  SC_HANDLE manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  SC_HANDLE service = manager ? OpenServiceW(manager, KEIKO_GATEWAY_SERVICE_NAME,
                                             SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG)
                              : NULL;
  SERVICE_STATUS_PROCESS status;
  DWORD bytes;
  BOOL ok = FALSE;
  if (service && QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status,
      sizeof(status), &bytes) && status.dwServiceType == SERVICE_WIN32_OWN_PROCESS &&
      status.dwCurrentState == SERVICE_RUNNING)
    ok = configured_image(service, path, length);
  if (service) CloseServiceHandle(service);
  if (manager) CloseServiceHandle(manager);
  return ok;
}

int keiko_gateway_launch_installed(const wchar_t *pin) {
  wchar_t *path = calloc(32768, sizeof(*path));
  HANDLE locks[128];
  size_t locked = 0;
  HANDLE image = INVALID_HANDLE_VALUE;
  intptr_t child = -1;
  DWORD code = 1;
  const wchar_t *args[] = {L"keiko-runtime-supervisor", L"--gateway-supervised", NULL};
  if (!path || !keiko_gateway_running_image(path, 32768) || !keiko_gateway_protected_image_path(path) ||
      path[1] != L':' || path[2] != L'\\' || GetDriveTypeW((wchar_t[]){path[0],L':',L'\\',0}) != DRIVE_FIXED)
    goto done;
  /* Lock each directory entry against replacement/reparse mutation until CreateProcess
   * returns. A digest check on an open leaf alone does not bind a later pathname launch. */
  for (wchar_t *end = path + 3; (end = wcschr(end, L'\\')) != NULL; ++end) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (locked == sizeof(locks)/sizeof(*locks)) goto done;
    *end = 0;
    HANDLE dir = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    *end = L'\\';
    if (dir == INVALID_HANDLE_VALUE) goto done;
    locks[locked++] = dir;
    if (!GetFileInformationByHandleEx(dir, FileAttributeTagInfo, &info, sizeof(info)) ||
        !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
      goto done;
  }
  image = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  FILE_ATTRIBUTE_TAG_INFO info;
  if (image == INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(image, FileAttributeTagInfo,
      &info, sizeof(info)) || (info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      !keiko_gateway_image_matches(image, pin)) goto done;
  /* The CRT passes the numbered KRP control/response descriptors as well as stdio. */
  child = _wspawnv(_P_NOWAIT, path, args);
done:
  if (image != INVALID_HANDLE_VALUE) CloseHandle(image);
  for (size_t i = 0; i < locked; i++) CloseHandle(locks[i]);
  free(path);
  if (child != -1) {
    if (WaitForSingleObject((HANDLE)child, INFINITE) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess((HANDLE)child, &code)) code = 1;
    CloseHandle((HANDLE)child);
  }
  return (int)code;
}
