/* Actual Windows resume/deadline/read functions are compiled unchanged below. Win32, CRT,
 * filesystem, identity and validated-plan ports are inert; this is not native Windows proof. */
#define KEIKO_PORTABLE_TARGET "windows-x64"
#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "keiko-portable-update-protocol.h"

#define KEIKO_COORDINATOR_MAX_CONTROL_MS (15u * 60u * 1000u)
#define KEIKO_WINDOWS_UPDATE_PATH_CAP 32768u
#define KEIKO_WINDOWS_PREFIX_INVALID 0
#define KEIKO_WINDOWS_PREFIX_PREVIOUS 1
#define KEIKO_WINDOWS_PREFIX_REGISTRATION 2
typedef uint32_t DWORD;
typedef void *HANDLE;
typedef int keiko_windows_local_volume_pin;
typedef int keiko_windows_atomic_file_fact;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#include "context-under-test.h"

static uint64_t wall_now, monotonic_now;
static int restoring_mode, fault;
static unsigned int gate_reads, image_checks, parent_checks;
static char digest[65];
static uint64_t gate_ready_at;
static unsigned int gate_offset;

static void advance_clock(uint64_t milliseconds) {
  monotonic_now += milliseconds;
  wall_now += milliseconds;
}

static uint64_t GetTickCount64(void) { return monotonic_now; }
static uint64_t keiko_coordinator_windows_wall_ms(void) { return wall_now; }

static wchar_t *copy_wide(const wchar_t *value) {
  wchar_t *copy = (wchar_t *)calloc(wcslen(value) + 1u, sizeof(*copy));
  assert(copy != NULL);
  wcscpy(copy, value);
  return copy;
}

static DWORD GetEnvironmentVariableW(const wchar_t *name, wchar_t *output, DWORD capacity) {
  const wchar_t *value = L"C:\\fixture\\state";
  DWORD length = (DWORD)wcslen(value);
  (void)name;
  if (output == NULL) return length + 1u;
  assert(capacity > length);
  wcscpy(output, value);
  return length;
}

static wchar_t *keiko_windows_update_path_join(const wchar_t *base, const wchar_t *suffix) {
  wchar_t *path = (wchar_t *)calloc(wcslen(base) + wcslen(suffix) + 1u, sizeof(*path));
  assert(path != NULL);
  wcscpy(path, base);
  wcscat(path, suffix);
  return path;
}

static wchar_t *keiko_coordinator_windows_ascii_path(
    const wchar_t *base, const wchar_t *suffix, const char *id) {
  (void)id;
  return keiko_windows_update_path_join(base, suffix);
}

static char *keiko_coordinator_windows_utf8_wide(const wchar_t *value) {
  (void)value;
  return strdup("fixture");
}

static int keiko_coordinator_windows_load_plan(
    keiko_coordinator_context *context, const char *id, uint64_t deadline) {
  (void)id;
  (void)deadline;
  if (fault == 6) return 0;
  context->plan.field[KEIKO_KHP_START_AT] = "1000";
  context->plan.field[KEIKO_KHP_VERIFY_AT] = "2000";
  context->plan.field[KEIKO_KHP_CLEANUP_AT] = "3000";
  context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256] = digest;
  context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256] = digest;
  context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256] = digest;
  memcpy(context->plan_sha256, digest, sizeof(digest));
  return 1;
}

static int keiko_coordinator_windows_paths_build(
    const keiko_coordinator_context *context, keiko_coordinator_windows_paths *paths) {
  (void)context;
  paths->launcher = copy_wide(L"C:\\fixture\\Keiko.exe");
  return 1;
}

static void keiko_coordinator_windows_paths_clear(keiko_coordinator_windows_paths *paths) {
  free(paths->launcher);
}

static int _wcsicmp(const wchar_t *left, const wchar_t *right) { return wcscmp(left, right); }

static int keiko_windows_update_file_digest_matches(
    const wchar_t *path, const char *hash, uint64_t deadline) {
  (void)path;
  assert(strcmp(hash, digest) == 0);
  image_checks += 1u;
  return fault != 1 && monotonic_now <= deadline;
}

static int keiko_coordinator_windows_parent_image_matches(
    const wchar_t *path, const char *hash, uint64_t deadline) {
  (void)path;
  assert(strcmp(hash, digest) == 0);
  parent_checks += 1u;
  return fault != 3 && monotonic_now <= deadline;
}

static int keiko_coordinator_windows_roots_same_volume(const keiko_coordinator_context *context) {
  (void)context;
  return fault != 5;
}

static int keiko_coordinator_windows_classify(
    const keiko_coordinator_context *context, uint64_t deadline, int *prefix) {
  (void)context;
  *prefix = fault == 4 ? KEIKO_WINDOWS_PREFIX_INVALID : restoring_mode
      ? KEIKO_WINDOWS_PREFIX_PREVIOUS : KEIKO_WINDOWS_PREFIX_REGISTRATION;
  return monotonic_now <= deadline;
}

static intptr_t _get_osfhandle(int descriptor) { assert(descriptor == 10); return 1; }

static int PeekNamedPipe(HANDLE handle, void *buffer, DWORD length, DWORD *read,
                         DWORD *available, DWORD *remaining) {
  (void)handle; (void)buffer; (void)length; (void)read; (void)remaining;
  if (fault == 9) advance_clock(10u);
  if (fault == 11) advance_clock(11u);
  *available = fault == 7 || monotonic_now < gate_ready_at ? 0u : 65u;
  if (fault == 13) *available = gate_offset == 0u ? 32u : 65u - gate_offset;
  return 1;
}

static void Sleep(DWORD milliseconds) {
  advance_clock(milliseconds);
}

static int _read(int descriptor, void *output, unsigned int length) {
  char gate[65];
  assert(descriptor == 10 && length > 0u && gate_offset + length <= 65u);
  if (fault == 10) advance_clock(10u);
  if (fault == 12) advance_clock(11u);
  if (fault == 13) advance_clock(6u);
  memcpy(gate, digest, 64u);
  gate[64] = '\n';
  if (fault == 2) gate[0] = 'z';
  memcpy(output, gate + gate_offset, length);
  gate_offset += length;
  gate_reads += 1u;
  return (int)length;
}

static int fixture_fileno(FILE *file) { (void)file; return 10; }
#define _fileno fixture_fileno
static int _close(int descriptor) { assert(descriptor == 10); return 0; }
#define SecureZeroMemory(output, length) memset(output, 0, length)

static void keiko_coordinator_clear(keiko_coordinator_context *context) {
  free(context->state_dir);
  free(context->capsule);
  free(context->state_dir_utf8);
}

#include "resume-under-test.h"

int main(int argc, char **argv) {
  keiko_coordinator_context context;
  int admitted;
  uint64_t started;
  assert(argc == 5);
  memset(digest, 'b', 64u);
  digest[64] = 0;
  wall_now = strtoull(argv[1], NULL, 10);
  restoring_mode = strcmp(argv[2], "restore") == 0;
  fault = atoi(argv[3]);
  monotonic_now = strtoull(argv[4], NULL, 10);
  started = monotonic_now;
  gate_ready_at = fault == 8 ? started + 10u : 0u;
  admitted = keiko_coordinator_prepare_resume_windows(
      &context, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", L"C:\\fixture\\Keiko.exe", restoring_mode);
  if (admitted) keiko_coordinator_clear(&context);
  printf("{\"admitted\":%d,\"gateReads\":%u,\"imageChecks\":%u,\"parentChecks\":%u,"
         "\"elapsedMs\":%llu}\n", admitted, gate_reads, image_checks, parent_checks,
         (unsigned long long)(monotonic_now - started));
  return 0;
}
