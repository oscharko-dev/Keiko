#ifndef KEIKO_PORTABLE_TARGET
#error "KEIKO_PORTABLE_TARGET must be defined by the portable artifact build"
#endif

#if defined(_WIN32)
#define UNICODE
#define _UNICODE
#include <windows.h>

#define KEIKO_WIDEN2(value) L##value
#define KEIKO_WIDEN(value) KEIKO_WIDEN2(value)

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

int wmain(void) {
  wchar_t root[32768];
  DWORD len = GetModuleFileNameW(NULL, root, (DWORD)(sizeof(root) / sizeof(root[0])));
  if (len == 0 || len >= (DWORD)(sizeof(root) / sizeof(root[0]))) {
    return 1;
  }
  if (!dirname_in_place(root)) {
    return 1;
  }

  wchar_t node[32768];
  wchar_t cli[32768];
  if (!append_path(node, sizeof(node) / sizeof(node[0]), root, L"\\runtime\\node\\node.exe")) {
    return 1;
  }
  if (!append_path(cli, sizeof(cli) / sizeof(cli[0]), root, L"\\app\\dist\\cli\\index.js")) {
    return 1;
  }

  wchar_t qnode[32768];
  wchar_t qcli[32768];
  wchar_t qroot[32768];
  if (!quote_arg(qnode, sizeof(qnode) / sizeof(qnode[0]), node)) {
    return 1;
  }
  if (!quote_arg(qcli, sizeof(qcli) / sizeof(qcli[0]), cli)) {
    return 1;
  }
  if (!quote_arg(qroot, sizeof(qroot) / sizeof(qroot[0]), root)) {
    return 1;
  }

  wchar_t command[98304];
  int written = _snwprintf_s(
    command,
    sizeof(command) / sizeof(command[0]),
    _TRUNCATE,
    L"%ls %ls portable launch --target %ls --portable-root %ls",
    qnode,
    qcli,
    KEIKO_WIDEN(KEIKO_PORTABLE_TARGET),
    qroot
  );
  if (written <= 0 || (size_t)written >= sizeof(command) / sizeof(command[0])) {
    return 1;
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(node, command, NULL, NULL, FALSE, 0, NULL, root, &startup, &process)) {
    return 1;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return (int)exit_code;
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
