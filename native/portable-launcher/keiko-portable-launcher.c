#ifndef KEIKO_PORTABLE_TARGET
#error "KEIKO_PORTABLE_TARGET must be defined by the portable artifact build"
#endif

#if defined(_WIN32)
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <stdarg.h>
#include <stdio.h>
#include <wchar.h>
#include <windows.h>

#if defined(KEIKO_PORTABLE_GENERATION_ID)
#include "keiko-portable-tree-hash.h"
#endif

#if defined(_MSC_VER)
/* MessageBoxW lives in user32, which neither cl invocation links by default. */
#pragma comment(lib, "user32.lib")
#endif

#define KEIKO_WIDEN2(value) L##value
#define KEIKO_WIDEN(value) KEIKO_WIDEN2(value)

#ifndef _MSC_VER
#ifndef _TRUNCATE
#define _TRUNCATE ((size_t)-1)
#endif
static int keiko_snwprintf_s(wchar_t *out, size_t cap, size_t truncate, const wchar_t *fmt, ...) {
  (void)truncate;
  va_list args;
  va_start(args, fmt);
  int written = vswprintf(out, cap, fmt, args);
  va_end(args);
  if (written < 0 || (size_t)written >= cap) {
    if (cap > 0) {
      out[cap - 1] = L'\0';
    }
    return -1;
  }
  return written;
}
#define _snwprintf_s keiko_snwprintf_s
#endif

#include "keiko-portable-update-coordinator.h"
#include "keiko-portable-recovery-control.h"

static int dirname_in_place(wchar_t *path) {
  wchar_t *last = NULL;
  for (wchar_t *cursor = path; *cursor != L'\0'; cursor++) {
    if (*cursor == L'\\' || *cursor == L'/') {
      last = cursor;
    }
  }
  if (last == NULL) {
    return 0;
  }
  *last = L'\0';
  return 1;
}

#if !defined(KEIKO_PORTABLE_GENERATION_ID) || defined(KEIKO_PORTABLE_LAUNCHER_TEST)
static int append_path(wchar_t *out, size_t cap, const wchar_t *base, const wchar_t *suffix) {
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"%ls%ls", base, suffix);
  return written > 0 && (size_t)written < cap;
}
#endif

static int quote_arg(wchar_t *out, size_t cap, const wchar_t *value) {
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"\"%ls\"", value);
  return written > 0 && (size_t)written < cap;
}

static DWORD creation_flags_for_console_state(int has_console) {
  return has_console ? 0 : CREATE_NO_WINDOW;
}

static int bootstrap_artifact_unusable(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  /* Missing, unreadable, or a directory wearing the artifact's name: none of these can
   * possibly boot the runtime, and CreateProcess would fail after the console is hidden. */
  return attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static void report_bootstrap_failure(int has_console, const wchar_t *console_line,
                                     const wchar_t *dialog_text) {
  if (has_console) {
    fwprintf(stderr, L"%ls", console_line);
  } else {
    MessageBoxW(NULL, dialog_text, L"Keiko", MB_OK | MB_ICONERROR);
  }
}

static int run_hidden_and_wait(const wchar_t *application, wchar_t *command,
                               const wchar_t *workdir, DWORD *exit_code) {
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(
        application, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, workdir, &startup,
        &process
      )) {
    return 0;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  *exit_code = 1;
  GetExitCodeProcess(process.hProcess, exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 1;
}

enum { KEIKO_PATH_CAP = 32768, KEIKO_COMMAND_CAP = 98304 };

typedef struct {
  wchar_t root[KEIKO_PATH_CAP];
  wchar_t node[KEIKO_PATH_CAP];
  wchar_t cli[KEIKO_PATH_CAP];
  wchar_t quoted_node[KEIKO_PATH_CAP];
  wchar_t quoted_cli[KEIKO_PATH_CAP];
  wchar_t quoted_root[KEIKO_PATH_CAP];
  wchar_t command[KEIKO_COMMAND_CAP];
} keiko_launcher_buffers;

#if defined(KEIKO_PORTABLE_GENERATION_ID)

#include "keiko-portable-generation-windows.h"

#else

static int select_legacy_resources(keiko_launcher_buffers *buffers) {
  return append_path(buffers->node, KEIKO_PATH_CAP, buffers->root,
                     L"\\runtime\\node\\node.exe") &&
         append_path(buffers->cli, KEIKO_PATH_CAP, buffers->root,
                     L"\\app\\dist\\cli\\index.js");
}

#endif

static keiko_launcher_buffers *allocate_launcher_buffers(void) {
  HANDLE heap = GetProcessHeap();
  if (heap == NULL) {
    return NULL;
  }
  return HeapAlloc(heap, HEAP_ZERO_MEMORY, sizeof(keiko_launcher_buffers));
}

static void free_launcher_buffers(keiko_launcher_buffers *buffers) {
  HANDLE heap = GetProcessHeap();
  if (heap != NULL && buffers != NULL) {
    (void)HeapFree(heap, 0, buffers);
  }
}

static int run_selected_launcher(keiko_launcher_buffers *buffers, int has_console) {
  if (!quote_arg(buffers->quoted_node, KEIKO_PATH_CAP, buffers->node)) {
    return 1;
  }
  if (!quote_arg(buffers->quoted_cli, KEIKO_PATH_CAP, buffers->cli)) {
    return 1;
  }
  if (!quote_arg(buffers->quoted_root, KEIKO_PATH_CAP, buffers->root)) {
    return 1;
  }

  /* The CLI's own failure dialog cannot load when the Node runtime or the app bundle itself is
   * gone, and with CREATE_NO_WINDOW the child's stderr would be invisible — the exact broken
   * install would fail with no signal at all. Only this pre-flight class gets a native dialog
   * here: any later failure is the CLI notifier's job, and a second generic dialog on a nonzero
   * exit would double-report it. */
  if (bootstrap_artifact_unusable(buffers->node) || bootstrap_artifact_unusable(buffers->cli)) {
    report_bootstrap_failure(
      has_console,
      L"keiko portable launch: the installation is incomplete\n",
      L"Keiko could not start: the installation is incomplete.\r\n"
      L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
    );
    return 1;
  }

  /* Explorer starts pre-parse the CLI bundle: `node --check` refuses a truncated or
   * syntax-broken app/dist/cli/index.js WITHOUT executing it — the class where Node would die
   * during module load, before the notifier exists, with CREATE_NO_WINDOW hiding the only
   * output. Shell starts skip the extra spawn: their stderr is visible and the real start
   * reports precisely. A runtime import of a missing module still belongs to the terminal
   * diagnostic path — parsing cannot see it, and the notifier owns everything after boot. */
  if (!has_console) {
    int check_written = _snwprintf_s(
      buffers->command,
      KEIKO_COMMAND_CAP,
      _TRUNCATE,
      L"%ls --check %ls",
      buffers->quoted_node,
      buffers->quoted_cli
    );
    DWORD check_exit = 1;
    if (check_written <= 0 || (size_t)check_written >= KEIKO_COMMAND_CAP ||
        !run_hidden_and_wait(buffers->node, buffers->command, buffers->root, &check_exit) ||
        check_exit != 0) {
      report_bootstrap_failure(
        has_console,
        L"keiko portable launch: the application bundle is damaged\n",
        L"Keiko could not start: the application bundle is damaged.\r\n"
        L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
      );
      return 1;
    }
  }

  if (!has_console && !SetEnvironmentVariableW(L"KEIKO_PORTABLE_UI_LAUNCH", L"1")) {
    /* Without the marker the CLI notifier stays silent, and with CREATE_NO_WINDOW the child's
     * stderr is invisible — starting Node in that state would fail without any signal. */
    report_bootstrap_failure(
      has_console,
      L"keiko portable launch: the launch environment could not be prepared\n",
      L"Keiko could not prepare its launch environment.\r\n"
      L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
    );
    return 1;
  }

  /* Built AFTER the pre-parse: the check reuses the same command buffer. */
  int written = _snwprintf_s(
    buffers->command,
    KEIKO_COMMAND_CAP,
    _TRUNCATE,
    L"%ls %ls portable launch --target %ls --portable-root %ls",
    buffers->quoted_node,
    buffers->quoted_cli,
    KEIKO_WIDEN(KEIKO_PORTABLE_TARGET),
    buffers->quoted_root
  );
  if (written <= 0 || (size_t)written >= KEIKO_COMMAND_CAP) {
    return 1;
  }
  DWORD creation_flags = creation_flags_for_console_state(has_console);
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(
        buffers->node,
        buffers->command,
        NULL,
        NULL,
        FALSE,
        creation_flags,
        NULL,
        buffers->root,
        &startup,
        &process
      )) {
    /* The child never ran, so the CLI notifier cannot have reported anything — this is the one
     * post-preflight failure the launcher itself must surface (corrupt PE, access denied). */
    report_bootstrap_failure(
      has_console,
      L"keiko portable launch: the bundled runtime could not be started\n",
      L"Keiko could not start its bundled runtime.\r\n"
      L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
    );
    return 1;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return (int)exit_code;
}

static int launcher_has_console(void) {
  /* Same double-click marker as the macOS launcher: the portable CLI surfaces launch failures
   * visibly only when a human started the app through this binary, and the marker's contract must
   * hold on every platform. A /SUBSYSTEM:WINDOWS binary never owns a console of its own, so
   * GetConsoleWindow() alone cannot tell a cmd/PowerShell start from an Explorer double-click —
   * both report NULL. Attaching to the parent's console distinguishes them: it succeeds for a
   * shell start (keep console semantics, keep Node output visible) and fails for Explorer
   * (set the UI-launch marker and suppress the child console window). */
  int has_console = GetConsoleWindow() != NULL;
  if (!has_console && AttachConsole(ATTACH_PARENT_PROCESS)) has_console = 1;
  return has_console;
}

static int run_launcher(keiko_launcher_buffers *buffers) {
  DWORD length = GetModuleFileNameW(NULL, buffers->root, KEIKO_PATH_CAP);
  int has_console = launcher_has_console();
  if (length == 0 || length >= (DWORD)KEIKO_PATH_CAP || !dirname_in_place(buffers->root)) return 1;
#if defined(KEIKO_PORTABLE_GENERATION_ID)
  {
    keiko_generation_pins pins;
    int result;
    if (!select_generation_resources(buffers, &pins)) {
      report_bootstrap_failure(
        has_console,
        L"keiko portable launch: the selected installation generation is unavailable or damaged\n",
        L"Keiko could not start: the selected installation generation is unavailable or damaged.\r\n"
        L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
      );
      return 1;
    }
    result = run_selected_launcher(buffers, has_console);
    close_generation_pins(&pins);
    return result;
  }
#else
  if (!select_legacy_resources(buffers)) return 1;
  return run_selected_launcher(buffers, has_console);
#endif
}

static int update_activation_argument(const wchar_t *value, char activation_id[33]) {
  size_t index;
  if (value == NULL || wcslen(value) != 32u) return 0;
  for (index = 0; index < 32u; ++index) {
    wchar_t byte = value[index];
    if (!((byte >= L'0' && byte <= L'9') || (byte >= L'a' && byte <= L'f'))) return 0;
    activation_id[index] = (char)byte;
  }
  activation_id[32] = '\0';
  return 1;
}

#if defined(KEIKO_PORTABLE_GENERATION_ID)
static int build_resume_command_windows(
    keiko_launcher_buffers *buffers,
    const wchar_t *port,
    const wchar_t *launch_id
) {
  int written = _snwprintf_s(
      buffers->command,
      KEIKO_COMMAND_CAP,
      _TRUNCATE,
      L"%ls %ls ui --host 127.0.0.1 --port %ls --launch-id %ls",
      buffers->quoted_node,
      buffers->quoted_cli,
      port,
      launch_id
  );
  return written > 0 && (size_t)written < KEIKO_COMMAND_CAP;
}
#endif

static int resume_update_windows(
    keiko_coordinator_context *coordinator,
    const wchar_t *executable,
    int restoring
) {
#if defined(KEIKO_PORTABLE_GENERATION_ID)
  keiko_launcher_buffers *buffers = allocate_launcher_buffers();
  keiko_generation_pins pins;
  wchar_t *port = NULL;
  wchar_t *launch_id = NULL;
  DWORD exit_code = 1;
  size_t executable_length = wcslen(executable);
  int result = 1;
  memset(&pins, 0, sizeof(pins));
  if (buffers == NULL || executable_length >= KEIKO_PATH_CAP) goto cleanup;
  memcpy(
      buffers->root,
      executable,
      (executable_length + 1u) * sizeof(wchar_t)
  );
  if (!dirname_in_place(buffers->root) ||
      !select_generation_resources(buffers, &pins) ||
      !quote_arg(buffers->quoted_node, KEIKO_PATH_CAP, buffers->node) ||
      !quote_arg(buffers->quoted_cli, KEIKO_PATH_CAP, buffers->cli)) goto cleanup;
  port = keiko_coordinator_windows_wide_utf8(
      coordinator->plan.field[KEIKO_KHP_OLD_PORT]
  );
  launch_id = keiko_coordinator_windows_wide_utf8(
      coordinator->plan.field[restoring ? KEIKO_KHP_RESTORE_LAUNCH_ID
                                        : KEIKO_KHP_NEW_LAUNCH_ID]
  );
  if (port == NULL || launch_id == NULL ||
      !SetEnvironmentVariableW(L"KEIKO_STATE_DIR", coordinator->state_dir)) goto cleanup;
  if (!build_resume_command_windows(buffers, port, launch_id) ||
      !run_hidden_and_wait(
          buffers->node,
          buffers->command,
          buffers->root,
          &exit_code
      )) goto cleanup;
  result = (int)exit_code;
cleanup:
  free(launch_id);
  free(port);
  close_generation_pins(&pins);
  free_launcher_buffers(buffers);
  return result;
#else
  (void)coordinator;
  (void)executable;
  (void)restoring;
  return 74;
#endif
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 3 && wcscmp(argv[1], L"--coordinate-update") == 0) {
    wchar_t *executable = (wchar_t *)calloc(KEIKO_PATH_CAP, sizeof(wchar_t));
    char activation_id[33];
    keiko_coordinator_context *coordinator =
        (keiko_coordinator_context *)calloc(1u, sizeof(*coordinator));
    DWORD length = executable == NULL ? 0 :
        GetModuleFileNameW(NULL, executable, KEIKO_PATH_CAP);
    if (coordinator == NULL || length == 0 || length >= KEIKO_PATH_CAP ||
        !update_activation_argument(argv[2], activation_id) ||
        !keiko_coordinator_prepare_windows(coordinator, activation_id, executable)) {
      free(coordinator);
      free(executable);
      return 74;
    }
    int result = keiko_coordinator_execute_windows(coordinator) ? 0 : 74;
    keiko_coordinator_clear(coordinator);
    free(coordinator);
    free(executable);
    return result;
  }
  if (argc == 3 && wcscmp(argv[1], L"--recover-update") == 0) {
    wchar_t *executable = (wchar_t *)calloc(KEIKO_PATH_CAP, sizeof(wchar_t));
    char activation_id[33];
    DWORD length = executable == NULL ? 0 :
        GetModuleFileNameW(NULL, executable, KEIKO_PATH_CAP);
    if (length == 0 || length >= KEIKO_PATH_CAP ||
        !update_activation_argument(argv[2], activation_id) ||
        !keiko_recovery_control_windows(activation_id, executable)) {
      free(executable);
      return 74;
    }
    free(executable);
    return 0;
  }
  if (argc == 3 &&
      (wcscmp(argv[1], L"--resume-update") == 0 ||
       wcscmp(argv[1], L"--resume-restored-update") == 0)) {
    wchar_t *executable = (wchar_t *)calloc(KEIKO_PATH_CAP, sizeof(wchar_t));
    char activation_id[33];
    keiko_coordinator_context *coordinator =
        (keiko_coordinator_context *)calloc(1u, sizeof(*coordinator));
    DWORD length = executable == NULL ? 0 :
        GetModuleFileNameW(NULL, executable, KEIKO_PATH_CAP);
    int restoring = wcscmp(argv[1], L"--resume-restored-update") == 0;
    int result;
    if (coordinator == NULL || length == 0 || length >= KEIKO_PATH_CAP ||
        !update_activation_argument(argv[2], activation_id) ||
        !keiko_coordinator_prepare_resume_windows(
            coordinator,
            activation_id,
            executable,
            restoring
        )) {
      free(coordinator);
      free(executable);
      return 74;
    }
    result = resume_update_windows(coordinator, executable, restoring);
    keiko_coordinator_clear(coordinator);
    free(coordinator);
    free(executable);
    return result;
  }
  if (argc != 1) return 1;
  keiko_launcher_buffers *buffers = allocate_launcher_buffers();
  if (buffers == NULL) {
    return 1;
  }
  int exit_code = run_launcher(buffers);
  free_launcher_buffers(buffers);
  return exit_code;
}

#else
#include <limits.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "keiko-portable-update-coordinator.h"
#include "keiko-portable-recovery-control.h"

static int dirname_copy(char *out, size_t cap, const char *path) {
  if (strlen(path) >= cap) {
    return 0;
  }
  strcpy(out, path);
  char *last = strrchr(out, '/');
  if (last == NULL) {
    return 0;
  }
  *last = '\0';
  return 1;
}

static int join_path(char *out, size_t cap, const char *base, const char *suffix) {
  int written = snprintf(out, cap, "%s%s", base, suffix);
  return written > 0 && (size_t)written < cap;
}

static int current_executable_path(char *out, size_t cap) {
#if defined(__APPLE__)
  (void)cap;
  char raw[PATH_MAX];
  uint32_t raw_size = sizeof(raw);
  if (_NSGetExecutablePath(raw, &raw_size) != 0) return 0;
  return realpath(raw, out) != NULL;
#elif defined(__linux__)
  ssize_t length;
  if (cap < 2) return 0;
  length = readlink("/proc/self/exe", out, cap - 1);
  if (length <= 0 || (size_t)length >= cap - 1) return 0;
  out[length] = '\0';
  return 1;
#else
  (void)out;
  (void)cap;
  return 0;
#endif
}

static int portable_root(char *out, size_t cap, const char *executable) {
#if defined(__APPLE__)
  char macos_dir[PATH_MAX];
  char contents_dir[PATH_MAX];
  if (!dirname_copy(macos_dir, sizeof(macos_dir), executable) ||
      !dirname_copy(contents_dir, sizeof(contents_dir), macos_dir)) return 0;
  return dirname_copy(out, cap, contents_dir);
#else
  return dirname_copy(out, cap, executable);
#endif
}

static int resume_update(keiko_coordinator_context *coordinator, const char *executable,
                         int restoring) {
  char app_root[PATH_MAX];
  char node[PATH_MAX];
  char cli[PATH_MAX];
  if (!portable_root(app_root, sizeof(app_root), executable) ||
#if defined(__APPLE__)
      !join_path(node, sizeof(node), app_root, "/Contents/Resources/runtime/node/bin/node") ||
      !join_path(cli, sizeof(cli), app_root, "/Contents/Resources/app/dist/cli/index.js") ||
#else
      !join_path(node, sizeof(node), app_root, "/runtime/node/bin/node") ||
      !join_path(cli, sizeof(cli), app_root, "/app/dist/cli/index.js") ||
#endif
      setenv("KEIKO_STATE_DIR", coordinator->state_dir, 1) != 0) return 1;
  execl(node, node, cli, "ui", "--host", "127.0.0.1", "--port",
        coordinator->plan.field[KEIKO_KHP_OLD_PORT], "--launch-id",
        coordinator->plan.field[restoring ? KEIKO_KHP_RESTORE_LAUNCH_ID
                                          : KEIKO_KHP_NEW_LAUNCH_ID],
        (char *)NULL);
  return 1;
}

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  if (!current_executable_path(executable, sizeof(executable))) return 1;

  if (argc == 3 && strcmp(argv[1], "--coordinate-update") == 0) {
    keiko_coordinator_context coordinator;
    int result;
    if (!keiko_khp_is_lower_hex(argv[2], 32u) ||
        !keiko_coordinator_prepare_posix(&coordinator, argv[2], executable)) return 74;
    result = keiko_coordinator_execute_posix(&coordinator) ? 0 : 74;
    keiko_coordinator_clear(&coordinator);
    return result;
  }
  if (argc == 3 && strcmp(argv[1], "--recover-update") == 0) {
    if (!keiko_khp_is_lower_hex(argv[2], 32u) ||
        !keiko_recovery_control_posix(argv[2], executable))
      return 74;
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "--resume-update") == 0) {
    keiko_coordinator_context coordinator;
    if (!keiko_khp_is_lower_hex(argv[2], 32u) ||
        !keiko_coordinator_prepare_resume_posix(&coordinator, argv[2], executable, 0)) return 74;
    return resume_update(&coordinator, executable, 0);
  }
  if (argc == 3 && strcmp(argv[1], "--resume-restored-update") == 0) {
    keiko_coordinator_context coordinator;
    if (!keiko_khp_is_lower_hex(argv[2], 32u) ||
        !keiko_coordinator_prepare_resume_posix(&coordinator, argv[2], executable, 1)) return 74;
    return resume_update(&coordinator, executable, 1);
  }
  if (argc != 1) return 1;

  char app_root[PATH_MAX];
  if (!portable_root(app_root, sizeof(app_root), executable)) return 1;

  char node[PATH_MAX];
  char cli[PATH_MAX];
#if defined(__APPLE__)
  if (!join_path(node, sizeof(node), app_root, "/Contents/Resources/runtime/node/bin/node")) {
    return 1;
  }
  if (!join_path(cli, sizeof(cli), app_root, "/Contents/Resources/app/dist/cli/index.js")) {
    return 1;
  }
  /* The one signal that a human double-clicked the app: only with it set does the portable CLI
   * surface a launch failure as a native alert. A Finder launch has no controlling terminal, so
   * stderr is not a tty; running this same binary from a shell (the troubleshooting runbook's
   * diagnostic step) keeps a tty and stays dialog-free — stderr already carries the reason there.
   * CI and test runners never exec this binary at all. The marker is inherited by the whole
   * launched tree, which is harmless — it asserts how the process was started, not what it may
   * do. */
  if (!isatty(STDERR_FILENO)) {
    setenv("KEIKO_PORTABLE_UI_LAUNCH", "1", 1);
  }
#else
  if (!join_path(node, sizeof(node), app_root, "/runtime/node/bin/node")) return 1;
  if (!join_path(cli, sizeof(cli), app_root, "/app/dist/cli/index.js")) return 1;
#endif
  execl(
    node,
    node,
    cli,
    "portable",
    "launch",
    "--target",
    KEIKO_PORTABLE_TARGET,
    "--portable-root",
    app_root,
    (char *)NULL
  );
  return 1;
}
#endif
