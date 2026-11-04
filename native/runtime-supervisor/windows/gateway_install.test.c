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

int main(void) {
  if (!pin_rules()) { puts("gateway-install-pin: failed"); return 1; }
  if (!path_rules()) { puts("gateway-install-paths: failed"); return 1; }
  if (!status_rules()) { puts("gateway-install-status: failed"); return 1; }
  puts("gateway-install-rules: passed");
  return 0;
}
