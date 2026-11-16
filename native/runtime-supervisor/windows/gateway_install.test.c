/* Install rules that need no administrator rights: a pin never carries a command-line character,
 * the paths stay in the protected folder, and status stays inside its closed vocabulary. */
#include "gateway_install.h"
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static const wchar_t VALID_PIN[] = L"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static int pin_rules(void) {
  wchar_t pin[65];
  static const wchar_t refused[] = L"A \"&%^g\\/";
  if (!keiko_gateway_pin_valid(VALID_PIN) || keiko_gateway_pin_valid(NULL) ||
      keiko_gateway_pin_valid(L"") || keiko_gateway_pin_valid(L"0123"))
    return 0;
  for (size_t i = 0; i < wcslen(refused); i++) {
    wcscpy_s(pin, 65, VALID_PIN);
    pin[10] = refused[i];
    if (keiko_gateway_pin_valid(pin)) return 0;
  }
  return 1;
}

static int path_rules(void) {
  wchar_t directory[KEIKO_GATEWAY_INSTALL_PATH_CHARS], image[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  wchar_t stage[KEIKO_GATEWAY_INSTALL_PATH_CHARS];
  return keiko_gateway_install_paths(directory, image, stage) &&
      keiko_gateway_protected_image_path(image) && keiko_gateway_protected_image_path(stage) &&
      wcsncmp(image, directory, wcslen(directory)) == 0 &&
      !keiko_gateway_protected_image_path(L"C:\\Users\\x\\keiko-runtime-supervisor.exe");
}

static int status_rules(void) {
  int state = keiko_gateway_service_status(VALID_PIN);
  return keiko_gateway_service_status(L"not-a-pin") == KEIKO_GATEWAY_SERVICE_INVALID_REQUEST &&
      keiko_gateway_service_install(L"not-a-pin") == KEIKO_GATEWAY_SERVICE_INVALID_REQUEST &&
      (state == KEIKO_GATEWAY_SERVICE_ABSENT || state == KEIKO_GATEWAY_SERVICE_STOPPED ||
       state == KEIKO_GATEWAY_SERVICE_IMAGE_MISMATCH || state == KEIKO_GATEWAY_SERVICE_STATE_UNKNOWN);
}

/* #4068: the running image is read from the service command line install writes, because a
 * standard user cannot query the LocalSystem service process itself. Only that exact shape counts. */
static int command_image_rules(void) {
  wchar_t path[64];
  wchar_t small[8];
  static const wchar_t *refused[] = {
      L"C:\\P\\keiko-runtime-supervisor.exe --gateway-service",
      L"\"C:\\P\\keiko-runtime-supervisor.exe\"",
      L"\"C:\\P\\keiko-runtime-supervisor.exe\" --gateway-service --extra",
      L"\"C:\\P\\keiko-runtime-supervisor.exe\" --gateway-supervised",
      L"\"C:\\P\\keiko-runtime-supervisor.exe\"  --gateway-service",
      L"\"\" --gateway-service",
      L"\"C:\\P\\keiko-runtime-supervisor.exe",
      L""};
  if (!keiko_gateway_service_command_image(
          L"\"C:\\P\\keiko-runtime-supervisor.exe\" --gateway-service", path, 64) ||
      wcscmp(path, L"C:\\P\\keiko-runtime-supervisor.exe") != 0)
    return 0;
  for (size_t i = 0; i < sizeof(refused) / sizeof(*refused); i++)
    if (keiko_gateway_service_command_image(refused[i], path, 64)) return 0;
  return !keiko_gateway_service_command_image(NULL, path, 64) &&
      !keiko_gateway_service_command_image(
          L"\"C:\\P\\keiko-runtime-supervisor.exe\" --gateway-service", small, 8);
}

/* #4242: a squatted pipe or repeated crash must never leave the broker permanently stopped. */
static int recovery_rules(void) {
  SC_ACTION actions[KEIKO_GATEWAY_RECOVERY_ACTIONS];
  keiko_gateway_recovery_actions(actions);
  for (int i = 0; i < KEIKO_GATEWAY_RECOVERY_ACTIONS; i++)
    if (actions[i].Type != SC_ACTION_RESTART || actions[i].Delay == 0) return 0;
  return 1;
}

int main(void) {
  if (!recovery_rules()) { puts("gateway-install-recovery: failed"); return 1; }
  if (!pin_rules()) { puts("gateway-install-pin: failed"); return 1; }
  if (!path_rules()) { puts("gateway-install-paths: failed"); return 1; }
  if (!command_image_rules()) { puts("gateway-install-command-image: failed"); return 1; }
  if (!status_rules()) { puts("gateway-install-status: failed"); return 1; }
  puts("gateway-install-rules: passed");
  return 0;
}
