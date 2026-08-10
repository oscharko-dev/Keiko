#ifndef KEIKO_PORTABLE_TARGET
#error "KEIKO_PORTABLE_TARGET must be defined by the portable artifact build"
#endif

#if defined(_WIN32)
#define UNICODE
#define _UNICODE
#include <stdarg.h>
#include <wchar.h>
#include <windows.h>

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

static int append_path(wchar_t *out, size_t cap, const wchar_t *base, const wchar_t *suffix) {
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"%ls%ls", base, suffix);
  return written > 0 && (size_t)written < cap;
}

static int quote_arg(wchar_t *out, size_t cap, const wchar_t *value) {
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"\"%ls\"", value);
  return written > 0 && (size_t)written < cap;
}

static DWORD creation_flags_for_console_state(int has_console) {
  return has_console ? 0 : CREATE_NO_WINDOW;
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

static int run_launcher(keiko_launcher_buffers *buffers) {
  DWORD len = GetModuleFileNameW(NULL, buffers->root, KEIKO_PATH_CAP);
  if (len == 0 || len >= (DWORD)KEIKO_PATH_CAP) {
    return 1;
  }
  if (!dirname_in_place(buffers->root)) {
    return 1;
  }

  if (!append_path(
        buffers->node,
        KEIKO_PATH_CAP,
        buffers->root,
        L"\\runtime\\node\\node.exe"
      )) {
    return 1;
  }
  if (!append_path(
        buffers->cli,
        KEIKO_PATH_CAP,
        buffers->root,
        L"\\app\\dist\\cli\\index.js"
      )) {
    return 1;
  }

  if (!quote_arg(buffers->quoted_node, KEIKO_PATH_CAP, buffers->node)) {
    return 1;
  }
  if (!quote_arg(buffers->quoted_cli, KEIKO_PATH_CAP, buffers->cli)) {
    return 1;
  }
  if (!quote_arg(buffers->quoted_root, KEIKO_PATH_CAP, buffers->root)) {
    return 1;
  }

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

  /* Same double-click marker as the macOS launcher: the portable CLI surfaces launch failures
   * visibly only when a human started the app through this binary, and the marker's contract must
   * hold on every platform. A shell invocation owns a console window; an Explorer double-click of
   * a windowed launcher does not. */
  int has_console = GetConsoleWindow() != NULL;
  if (!has_console) {
    SetEnvironmentVariableW(L"KEIKO_PORTABLE_UI_LAUNCH", L"1");
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
    return 1;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return (int)exit_code;
}

int wmain(void) {
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
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

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

int main(void) {
  char raw[PATH_MAX];
  uint32_t raw_size = sizeof(raw);
  if (_NSGetExecutablePath(raw, &raw_size) != 0) {
    return 1;
  }
  char executable[PATH_MAX];
  if (realpath(raw, executable) == NULL) {
    return 1;
  }

  char macos_dir[PATH_MAX];
  char contents_dir[PATH_MAX];
  char app_root[PATH_MAX];
  if (!dirname_copy(macos_dir, sizeof(macos_dir), executable)) {
    return 1;
  }
  if (!dirname_copy(contents_dir, sizeof(contents_dir), macos_dir)) {
    return 1;
  }
  if (!dirname_copy(app_root, sizeof(app_root), contents_dir)) {
    return 1;
  }

  char node[PATH_MAX];
  char cli[PATH_MAX];
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
