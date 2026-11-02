#ifndef KEIKO_GATEWAY_INSTALL_H
#define KEIKO_GATEWAY_INSTALL_H
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#define KEIKO_GATEWAY_SERVICE_NAME L"KeikoRuntimeGateway"
#define KEIKO_GATEWAY_INSTALL_DIRECTORY L"KeikoRuntimeGateway"
#define KEIKO_GATEWAY_IMAGE_NAME L"keiko-runtime-supervisor.exe"
#define KEIKO_GATEWAY_STAGE_NAME L"keiko-runtime-supervisor.new.exe"
#define KEIKO_GATEWAY_INSTALL_PATH_CHARS 1024

/* Process exit codes of the --gateway-service-* commands. keiko-cli maps them to its closed
 * Activity Log vocabulary (gateway-service.ts); a change here changes that contract. */
enum keiko_gateway_service_result {
  KEIKO_GATEWAY_SERVICE_READY = 0,
  KEIKO_GATEWAY_SERVICE_ABSENT = 10,
  KEIKO_GATEWAY_SERVICE_STOPPED = 11,
  KEIKO_GATEWAY_SERVICE_IMAGE_MISMATCH = 12,
  KEIKO_GATEWAY_SERVICE_STATE_UNKNOWN = 13,
  KEIKO_GATEWAY_SERVICE_ELEVATION_DECLINED = 20,
  KEIKO_GATEWAY_SERVICE_SOURCE_MISMATCH = 21,
  KEIKO_GATEWAY_SERVICE_TARGET_UNSAFE = 22,
  KEIKO_GATEWAY_SERVICE_COPY_FAILED = 23,
  KEIKO_GATEWAY_SERVICE_SCM_FAILED = 24,
  KEIKO_GATEWAY_SERVICE_START_FAILED = 25,
  KEIKO_GATEWAY_SERVICE_GUARDS_REMAIN = 26,
  KEIKO_GATEWAY_SERVICE_INVALID_REQUEST = 27
};

/* Exactly 64 lowercase hex characters. The pin reaches a UAC relaunch as a parameter, so this
 * also keeps every quoting and injection character out of that command line. */
BOOL keiko_gateway_pin_valid(const wchar_t *pin);
/* Compose the protected installation paths; each buffer holds KEIKO_GATEWAY_INSTALL_PATH_CHARS. */
BOOL keiko_gateway_install_paths(wchar_t *directory, wchar_t *image, wchar_t *stage);

BOOL keiko_gateway_image_matches(HANDLE image, const wchar_t *pin);
BOOL keiko_gateway_protected_image_path(const wchar_t *path);
BOOL keiko_gateway_running_image(wchar_t *path, DWORD length);

/* Read-only; needs no administrator rights. */
int keiko_gateway_service_status(const wchar_t *pin);
/* Install and repair are one idempotent operation. Both commands relaunch through UAC when the
 * caller is not elevated, and return the elevated process's result. */
int keiko_gateway_service_install(const wchar_t *pin);
int keiko_gateway_service_uninstall(void);
#endif
