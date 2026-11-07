/* Administrator-authorized install, repair and removal of the LocalSystem broker (ADR-0043 D19).
 * Only this digest-checked native image runs elevated: no Node process and no package script does.
 * The bytes the service runs are verified again after they reach the protected directory. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <objbase.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include "gateway_install.h"
#include "gateway_wfp.h"

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")

#define SERVICE_WAIT_MS 30000
#define SERVICE_POLL_MS 250
#define REPLACE_WAIT_MS 5000
#define GUARD_CAPACITY 64
#define SELF_PATH_CHARS 32768

/* Administrators and SYSTEM own the directory. Everyone else may only read and execute. */
static const wchar_t DIRECTORY_SDDL[] =
    L"O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;AU)";

BOOL keiko_gateway_pin_valid(const wchar_t *pin) {
  if (pin == NULL || wcslen(pin) != 64) return FALSE;
  for (size_t i = 0; i < 64; i++) {
    wchar_t c = pin[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return FALSE;
  }
  return TRUE;
}

BOOL keiko_gateway_install_paths(wchar_t *directory, wchar_t *image, wchar_t *stage) {
  wchar_t *program_files = NULL;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, NULL, &program_files))) return FALSE;
  int written = _snwprintf_s(directory, KEIKO_GATEWAY_INSTALL_PATH_CHARS, _TRUNCATE, L"%ls\\%ls",
                             program_files, KEIKO_GATEWAY_INSTALL_DIRECTORY);
  CoTaskMemFree(program_files);
  return written > 0 &&
      _snwprintf_s(image, KEIKO_GATEWAY_INSTALL_PATH_CHARS, _TRUNCATE, L"%ls\\%ls", directory,
                   KEIKO_GATEWAY_IMAGE_NAME) > 0 &&
      _snwprintf_s(stage, KEIKO_GATEWAY_INSTALL_PATH_CHARS, _TRUNCATE, L"%ls\\%ls", directory,
                   KEIKO_GATEWAY_STAGE_NAME) > 0;
}

static BOOL regular_file_matches(const wchar_t *path, const wchar_t *pin) {
  FILE_ATTRIBUTE_TAG_INFO info;
  BOOL ok = FALSE;
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  if (GetFileInformationByHandleEx(file, FileAttributeTagInfo, &info, sizeof(info)) &&
      !(info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
    ok = keiko_gateway_image_matches(file, pin);
  CloseHandle(file);
  return ok;
}

static int running_service_state(const wchar_t *pin) {
  int result = KEIKO_GATEWAY_SERVICE_STATE_UNKNOWN;
  wchar_t *path = calloc(SELF_PATH_CHARS, sizeof(*path));
  if (path == NULL) return result;
  if (keiko_gateway_running_image(path, SELF_PATH_CHARS))
    result = keiko_gateway_protected_image_path(path) && regular_file_matches(path, pin)
        ? KEIKO_GATEWAY_SERVICE_READY
        : KEIKO_GATEWAY_SERVICE_IMAGE_MISMATCH;
  free(path);
  return result;
}

int keiko_gateway_service_status(const wchar_t *pin) {
  SC_HANDLE manager, service;
  SERVICE_STATUS_PROCESS status;
  DWORD bytes;
  int result = KEIKO_GATEWAY_SERVICE_STATE_UNKNOWN;
  if (!keiko_gateway_pin_valid(pin)) return KEIKO_GATEWAY_SERVICE_INVALID_REQUEST;
  manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  if (manager == NULL) return result;
  service = OpenServiceW(manager, KEIKO_GATEWAY_SERVICE_NAME, SERVICE_QUERY_STATUS);
  if (service == NULL) {
    if (GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST) result = KEIKO_GATEWAY_SERVICE_ABSENT;
    CloseServiceHandle(manager);
    return result;
  }
  if (QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status, sizeof(status), &bytes))
    result = status.dwCurrentState == SERVICE_RUNNING ? running_service_state(pin)
                                                      : KEIKO_GATEWAY_SERVICE_STOPPED;
  CloseServiceHandle(service);
  CloseServiceHandle(manager);
  return result;
}

static BOOL is_elevated(void) {
  HANDLE token = NULL;
  TOKEN_ELEVATION elevation = {0};
  DWORD bytes;
  BOOL ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) &&
      GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes) &&
      elevation.TokenIsElevated != 0;
  if (token != NULL) CloseHandle(token);
  return ok;
}

/* parameters holds only a fixed flag and a validated pin. */
static int relaunch_elevated(const wchar_t *parameters) {
  SHELLEXECUTEINFOW request = {sizeof(request)};
  DWORD code = KEIKO_GATEWAY_SERVICE_SCM_FAILED;
  wchar_t *self = calloc(SELF_PATH_CHARS, sizeof(*self));
  DWORD length = self ? GetModuleFileNameW(NULL, self, SELF_PATH_CHARS) : 0;
  HRESULT com = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (length == 0 || length >= SELF_PATH_CHARS) goto done;
  request.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  request.lpVerb = L"runas";
  request.lpFile = self;
  request.lpParameters = parameters;
  request.nShow = SW_HIDE;
  if (!ShellExecuteExW(&request)) {
    if (GetLastError() == ERROR_CANCELLED) code = KEIKO_GATEWAY_SERVICE_ELEVATION_DECLINED;
    goto done;
  }
  if (request.hProcess == NULL || WaitForSingleObject(request.hProcess, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(request.hProcess, &code))
    code = KEIKO_GATEWAY_SERVICE_SCM_FAILED;
done:
  if (request.hProcess != NULL) CloseHandle(request.hProcess);
  if (SUCCEEDED(com)) CoUninitialize();
  free(self);
  return (int)code;
}

/* A directory that already existed is brought to the same state, through this exact handle. */
static BOOL apply_directory_security(HANDLE handle, PSECURITY_DESCRIPTOR descriptor) {
  FILE_ATTRIBUTE_TAG_INFO info;
  PSID owner = NULL;
  PACL dacl = NULL;
  BOOL present = FALSE, defaulted = FALSE;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) ||
      !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    return FALSE;
  return GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) &&
      GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) && present &&
      SetSecurityInfo(handle, SE_FILE_OBJECT,
                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
                          PROTECTED_DACL_SECURITY_INFORMATION,
                      owner, NULL, dacl, NULL) == ERROR_SUCCESS;
}

static BOOL protect_directory(const wchar_t *directory) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES security = {sizeof(security), NULL, FALSE};
  HANDLE handle = INVALID_HANDLE_VALUE;
  BOOL ok = FALSE;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(DIRECTORY_SDDL, SDDL_REVISION_1,
                                                            &descriptor, NULL))
    return FALSE;
  security.lpSecurityDescriptor = descriptor;
  if (CreateDirectoryW(directory, &security) || GetLastError() == ERROR_ALREADY_EXISTS) {
    handle = CreateFileW(directory, READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
                         FILE_SHARE_READ, NULL, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    ok = handle != INVALID_HANDLE_VALUE && apply_directory_security(handle, descriptor);
  }
  if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  LocalFree(descriptor);
  return ok;
}

static BOOL wait_for_state(SC_HANDLE service, DWORD wanted) {
  SERVICE_STATUS_PROCESS status;
  DWORD bytes;
  for (DWORD waited = 0; waited < SERVICE_WAIT_MS; waited += SERVICE_POLL_MS) {
    if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, (BYTE *)&status, sizeof(status), &bytes))
      return FALSE;
    if (status.dwCurrentState == wanted) return TRUE;
    Sleep(SERVICE_POLL_MS);
  }
  return FALSE;
}

static BOOL stop_service(SC_HANDLE service) {
  SERVICE_STATUS status;
  if (!ControlService(service, SERVICE_CONTROL_STOP, &status) &&
      GetLastError() != ERROR_SERVICE_NOT_ACTIVE)
    return FALSE;
  return wait_for_state(service, SERVICE_STOPPED);
}

/* The stopped service's process can hold its image briefly after SCM reports SERVICE_STOPPED. */
static BOOL place_image(const wchar_t *stage, const wchar_t *image) {
  for (DWORD waited = 0; waited < REPLACE_WAIT_MS; waited += SERVICE_POLL_MS) {
    if (MoveFileExW(stage, image, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return TRUE;
    DWORD error = GetLastError();
    if (error != ERROR_ACCESS_DENIED && error != ERROR_SHARING_VIOLATION) return FALSE;
    Sleep(SERVICE_POLL_MS);
  }
  return FALSE;
}

/* A broker that stops on a failed request must come back, because a standard user cannot start it
 * and ordinary launches must not prompt. Every run still needs a fresh verified admission. */
static BOOL configure_recovery(SC_HANDLE service) {
  SERVICE_DELAYED_AUTO_START_INFO delayed = {TRUE};
  SC_ACTION actions[3] = {{SC_ACTION_RESTART, 5000}, {SC_ACTION_RESTART, 5000}, {SC_ACTION_NONE, 0}};
  SERVICE_FAILURE_ACTIONSW failure = {86400, NULL, NULL, 3, actions};
  SERVICE_FAILURE_ACTIONS_FLAG on_stop = {TRUE};
  return ChangeServiceConfig2W(service, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, &delayed) &&
      ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failure) &&
      ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, &on_stop);
}

static SC_HANDLE ensure_service(SC_HANDLE manager, SC_HANDLE existing, const wchar_t *image) {
  static const wchar_t dependencies[] = L"BFE\0";
  wchar_t command[KEIKO_GATEWAY_INSTALL_PATH_CHARS + 32];
  if (_snwprintf_s(command, sizeof(command) / sizeof(*command), _TRUNCATE,
                   L"\"%ls\" --gateway-service", image) <= 0)
    return NULL;
  if (existing == NULL)
    return CreateServiceW(manager, KEIKO_GATEWAY_SERVICE_NAME, L"Keiko Runtime Gateway",
                          SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
                          SERVICE_ERROR_NORMAL, command, NULL, NULL, dependencies, NULL, NULL);
  return ChangeServiceConfigW(existing, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
                              SERVICE_ERROR_NORMAL, command, NULL, NULL, dependencies, NULL, NULL,
                              L"Keiko Runtime Gateway") ? existing : NULL;
}

static int stage_verified_copy(const wchar_t *directory, const wchar_t *stage, const wchar_t *pin) {
  wchar_t *self = calloc(SELF_PATH_CHARS, sizeof(*self));
  DWORD length = self ? GetModuleFileNameW(NULL, self, SELF_PATH_CHARS) : 0;
  int result = KEIKO_GATEWAY_SERVICE_COPY_FAILED;
  if (length == 0 || length >= SELF_PATH_CHARS) goto done;
  if (!regular_file_matches(self, pin)) {
    result = KEIKO_GATEWAY_SERVICE_SOURCE_MISMATCH;
    goto done;
  }
  if (!protect_directory(directory)) {
    result = KEIKO_GATEWAY_SERVICE_TARGET_UNSAFE;
    goto done;
  }
  if (CopyFileW(self, stage, FALSE)) {
    result = regular_file_matches(stage, pin) ? KEIKO_GATEWAY_SERVICE_READY
                                              : KEIKO_GATEWAY_SERVICE_SOURCE_MISMATCH;
    if (result != KEIKO_GATEWAY_SERVICE_READY) (void)DeleteFileW(stage);
  }
done:
  free(self);
  return result;
}

/* Nothing that runs is touched until the new bytes sit verified beside the old image. */
static int install_elevated(const wchar_t *pin) {
  wchar_t directory[KEIKO_GATEWAY_INSTALL_PATH_CHARS], image[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  wchar_t stage[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  SC_HANDLE manager = NULL, existing = NULL, service = NULL;
  int result;
  if (!keiko_gateway_install_paths(directory, image, stage)) return KEIKO_GATEWAY_SERVICE_TARGET_UNSAFE;
  if (keiko_gateway_service_status(pin) == KEIKO_GATEWAY_SERVICE_READY) return KEIKO_GATEWAY_SERVICE_READY;
  result = stage_verified_copy(directory, stage, pin);
  if (result != KEIKO_GATEWAY_SERVICE_READY) return result;
  result = KEIKO_GATEWAY_SERVICE_SCM_FAILED;
  manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE);
  if (manager == NULL) goto done;
  existing = OpenServiceW(manager, KEIKO_GATEWAY_SERVICE_NAME, SERVICE_ALL_ACCESS);
  if (existing == NULL && GetLastError() != ERROR_SERVICE_DOES_NOT_EXIST) goto done;
  if (existing != NULL && !stop_service(existing)) goto done;
  if (!place_image(stage, image)) {
    result = KEIKO_GATEWAY_SERVICE_COPY_FAILED;
    goto done;
  }
  service = ensure_service(manager, existing, image);
  if (service == NULL || !configure_recovery(service)) goto done;
  result = KEIKO_GATEWAY_SERVICE_START_FAILED;
  if ((StartServiceW(service, 0, NULL) || GetLastError() == ERROR_SERVICE_ALREADY_RUNNING) &&
      wait_for_state(service, SERVICE_RUNNING) &&
      keiko_gateway_service_status(pin) == KEIKO_GATEWAY_SERVICE_READY)
    result = KEIKO_GATEWAY_SERVICE_READY;
done:
  (void)DeleteFileW(stage);
  if (service != NULL && service != existing) CloseServiceHandle(service);
  if (existing != NULL) CloseServiceHandle(existing);
  if (manager != NULL) CloseServiceHandle(manager);
  return result;
}

int keiko_gateway_service_install(const wchar_t *pin) {
  wchar_t parameters[128];
  if (!keiko_gateway_pin_valid(pin)) return KEIKO_GATEWAY_SERVICE_INVALID_REQUEST;
  if (is_elevated()) return install_elevated(pin);
  if (_snwprintf_s(parameters, 128, _TRUNCATE, L"--gateway-service-install %ls", pin) <= 0)
    return KEIKO_GATEWAY_SERVICE_INVALID_REQUEST;
  return relaunch_elevated(parameters);
}

/* A durable deny outliving its broker may still protect a live tree. Removing it could widen that
 * tree's access, so removal refuses and the broker keeps serving. */
static BOOL no_guarded_trees(void) {
  PSID packages[GUARD_CAPACITY];
  DWORD count = 0;
  DWORD result = keiko_gateway_filters_guarded_packages(packages, GUARD_CAPACITY, &count);
  for (DWORD i = 0; i < count; i++) HeapFree(GetProcessHeap(), 0, packages[i]);
  return result == ERROR_SUCCESS && count == 0;
}

static BOOL path_absent(void) {
  DWORD error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

static BOOL remove_files(const wchar_t *directory, const wchar_t *image, const wchar_t *stage) {
  (void)DeleteFileW(stage);
  for (DWORD waited = 0; waited < REPLACE_WAIT_MS; waited += SERVICE_POLL_MS) {
    if (DeleteFileW(image) || path_absent()) return RemoveDirectoryW(directory) || path_absent();
    Sleep(SERVICE_POLL_MS);
  }
  return FALSE;
}

static int uninstall_elevated(void) {
  wchar_t directory[KEIKO_GATEWAY_INSTALL_PATH_CHARS], image[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  wchar_t stage[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  SC_HANDLE manager, service;
  int result = KEIKO_GATEWAY_SERVICE_SCM_FAILED;
  if (!keiko_gateway_install_paths(directory, image, stage)) return KEIKO_GATEWAY_SERVICE_TARGET_UNSAFE;
  manager = OpenSCManagerW(NULL, NULL, SC_MANAGER_CONNECT);
  if (manager == NULL) return result;
  service = OpenServiceW(manager, KEIKO_GATEWAY_SERVICE_NAME, SERVICE_ALL_ACCESS);
  if (service == NULL && GetLastError() != ERROR_SERVICE_DOES_NOT_EXIST) goto done;
  if (service != NULL && !stop_service(service)) goto done;
  if (!no_guarded_trees()) {
    result = KEIKO_GATEWAY_SERVICE_GUARDS_REMAIN;
    if (service != NULL) (void)StartServiceW(service, 0, NULL);
    goto done;
  }
  if (service != NULL && !DeleteService(service)) goto done;
  result = remove_files(directory, image, stage) ? KEIKO_GATEWAY_SERVICE_ABSENT
                                                 : KEIKO_GATEWAY_SERVICE_COPY_FAILED;
done:
  if (service != NULL) CloseServiceHandle(service);
  CloseServiceHandle(manager);
  return result;
}

int keiko_gateway_service_uninstall(void) {
  return is_elevated() ? uninstall_elevated() : relaunch_elevated(L"--gateway-service-uninstall");
}
