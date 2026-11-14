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
#include <string.h>
#include <wchar.h>
#include <wctype.h>
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

/* Every message box of the launcher goes through show_box (#4358): a start without a console AND
 * without a visible desktop (a scheduled task, a service, an automation step) has nobody to close a
 * box, so MessageBoxW would block for ever and the exit code would never be returned. A box is shown
 * only when the process's window station is visible (WSF_VISIBLE; the interactive WinSta0) and the
 * session is not shutting down (a logoff ends the child on purpose and must not look like a failed
 * start). Otherwise nothing is shown and the caller goes on at once: the exit code is returned, and
 * the activity-log line and the failure note stay. */
static int desktop_is_interactive(void) {
  HWINSTA station = GetProcessWindowStation();
  USEROBJECTFLAGS flags;
  DWORD needed = 0;
  if (station == NULL) return 0;
  ZeroMemory(&flags, sizeof(flags));
  if (!GetUserObjectInformationW(station, UOI_FLAGS, &flags, (DWORD)sizeof(flags), &needed)) {
    return 0;
  }
  return (flags.dwFlags & WSF_VISIBLE) != 0 && GetSystemMetrics(SM_SHUTTINGDOWN) == 0;
}

static void show_box(const wchar_t *text, UINT icon) {
  if (!desktop_is_interactive()) return;
  (void)MessageBoxW(NULL, text, L"Keiko", MB_OK | icon);
}

static void report_bootstrap_failure(int has_console, const wchar_t *console_line,
                                     const wchar_t *dialog_text) {
  if (has_console) {
    fwprintf(stderr, L"%ls", console_line);
  } else {
    show_box(dialog_text, MB_ICONERROR);
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

enum { KEIKO_PATH_CAP = 32768, KEIKO_COMMAND_CAP = 98304, KEIKO_NOTE_CAP = 320 };

typedef struct {
  wchar_t failure_note[KEIKO_NOTE_CAP]; /* where the CLI leaves the reason of a failed start */
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

/* First feedback of a double-click start (#4358). Before this, the launcher was silent until the CLI
 * had loaded under the virus scanner and started a whole PowerShell for its notice, which took
 * minutes on a slow machine. The launcher itself, a native program with no runtime to start, now
 * shows one message when a start is still running after two seconds, and closes it when the
 * `portable launch` child has ended. A second start of the same executable brings that message to
 * the front and starts nothing. Both apply only to a start without a console: a terminal start
 * already shows the CLI's output. */
enum { KEIKO_FEEDBACK_DELAY_MS = 2000, KEIKO_FEEDBACK_JOIN_MS = 3000 };

/* The wording of the first-start message: the former CLI setup notice plus one sentence that the
 * message may be closed. packages/keiko-cli/src/portable-launcher-feedback.test.ts matches the text
 * of this source against fixed strings; it proves the wording and the order of the calls, not the
 * behavior, which is measured on Windows.
 * Wide escapes end their string literal so that no hex digit that follows is read into them. */
#define KEIKO_FEEDBACK_TEXT_EN \
  L"Keiko is being set up. The first start can take several minutes. " \
  L"Your browser opens when Keiko is ready.\r\n\r\n" \
  L"You can close this message; Keiko keeps starting and your browser opens when it is ready."
#define KEIKO_FEEDBACK_TEXT_DE \
  L"Keiko wird eingerichtet. Der erste Start kann einige Minuten dauern. " \
  L"Dein Browser \x00f6" L"ffnet sich, sobald Keiko bereit ist.\r\n\r\n" \
  L"Du kannst diese Meldung schlie\x00df" L"en; Keiko startet weiter und dein Browser " \
  L"\x00f6" L"ffnet sich, sobald Keiko bereit ist."

/* What a second start shows when it finds no first-start message to bring forward: the first
 * launcher is still starting (or hangs) and this one starts nothing, so it says so rather than
 * leaving a double-click without any answer. */
#define KEIKO_ALREADY_STARTING_TEXT_EN \
  L"Keiko is already starting. Your browser opens when it is ready."
#define KEIKO_ALREADY_STARTING_TEXT_DE \
  L"Keiko startet bereits. Dein Browser \x00f6" L"ffnet sich, sobald Keiko bereit ist."

typedef struct {
  HANDLE done; /* manual-reset event: set by the main thread when the child has ended */
  HANDLE thread;
  DWORD thread_id;
} keiko_feedback;

static int ui_language_is_german(void) {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_GERMAN;
}

static const wchar_t *feedback_text(void) {
  return ui_language_is_german() ? KEIKO_FEEDBACK_TEXT_DE : KEIKO_FEEDBACK_TEXT_EN;
}

static const wchar_t *already_starting_text(void) {
  return ui_language_is_german() ? KEIKO_ALREADY_STARTING_TEXT_DE : KEIKO_ALREADY_STARTING_TEXT_EN;
}

static DWORD WINAPI feedback_thread(LPVOID context) {
  const keiko_feedback *feedback = (const keiko_feedback *)context;
  /* Only a start that is still running after the delay shows anything: a fast one never flashes. */
  if (WaitForSingleObject(feedback->done, KEIKO_FEEDBACK_DELAY_MS) != WAIT_TIMEOUT) return 0;
  /* The box is the person's to close; it is shown once and never again. A failure to show it is
   * not a failure to start Keiko. */
  show_box(feedback_text(), MB_ICONINFORMATION);
  return 0;
}

static void feedback_start(keiko_feedback *feedback) {
  feedback->done = NULL;
  feedback->thread = NULL;
  feedback->thread_id = 0;
  if (!desktop_is_interactive()) return; /* nobody to read it: no thread, no wait */
  feedback->done = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (feedback->done == NULL) return; /* no feedback, the start itself goes on */
  feedback->thread = CreateThread(NULL, 0, feedback_thread, feedback, 0, &feedback->thread_id);
}

static BOOL CALLBACK close_feedback_window(HWND window, LPARAM unused) {
  (void)unused;
  (void)PostMessageW(window, WM_CLOSE, 0, 0);
  return TRUE;
}

static void feedback_stop(keiko_feedback *feedback) {
  if (feedback->done != NULL) (void)SetEvent(feedback->done);
  if (feedback->thread != NULL) {
    /* A box that is showing is closed. A box whose delay ran out just before this stop is not yet a
     * window and is not found; it shows late and ends with this process, which waits for the thread
     * at most the bounded join below (three seconds) and then returns, so the launcher is never kept
     * alive by it. Known and accepted: in that narrow race at the two-second boundary the first-start
     * box can appear at the moment the start ended, and for a child that failed it can be on screen
     * together with the failure box; the join bounds it. */
    (void)EnumThreadWindows(feedback->thread_id, close_feedback_window, 0);
    (void)WaitForSingleObject(feedback->thread, KEIKO_FEEDBACK_JOIN_MS);
    (void)CloseHandle(feedback->thread);
  }
  if (feedback->done != NULL) (void)CloseHandle(feedback->done);
  feedback->done = NULL;
  feedback->thread = NULL;
}

typedef struct {
  DWORD self;
  HWND found;
} keiko_window_search;

/* The message of another launcher process: a dialog titled "Keiko". */
static BOOL CALLBACK find_feedback_window(HWND window, LPARAM parameter) {
  keiko_window_search *search = (keiko_window_search *)parameter;
  wchar_t title[8];
  wchar_t class_name[16];
  DWORD process_id = 0;
  if (GetWindowTextW(window, title, 8) <= 0 || wcscmp(title, L"Keiko") != 0) return TRUE;
  if (GetClassNameW(window, class_name, 16) <= 0 || wcscmp(class_name, L"#32770") != 0) return TRUE;
  if (GetWindowThreadProcessId(window, &process_id) == 0 || process_id == search->self) return TRUE;
  search->found = window;
  return FALSE;
}

/* Returns 1 when another launcher's message was found and brought to the front, 0 when none is
 * showing (not yet shown, closed by the person, or the first launcher hangs). */
static int bring_feedback_forward(void) {
  keiko_window_search search;
  search.self = GetCurrentProcessId();
  search.found = NULL;
  (void)EnumWindows(find_feedback_window, (LPARAM)&search);
  if (search.found == NULL) return 0;
  if (IsIconic(search.found)) (void)ShowWindow(search.found, SW_RESTORE);
  (void)SetForegroundWindow(search.found);
  return 1;
}

/* One launcher per installation root at a time. Returns 0 when another one runs: its message was
 * brought forward, or, when none shows, this start says that Keiko is already starting; nothing else
 * is started either way. When the guard cannot be created the start goes on without it. */
static int claim_launcher_instance(const wchar_t *root, HANDLE *instance) {
  wchar_t name[64];
  unsigned long long hash = 14695981039346656037ULL; /* FNV-1a 64-bit offset basis */
  for (const wchar_t *cursor = root; *cursor != L'\0'; ++cursor) {
    hash ^= (unsigned long long)towlower(*cursor);
    hash *= 1099511628211ULL;
  }
  if (_snwprintf_s(name, 64, _TRUNCATE, L"Local\\KeikoPortableLauncher-%016llx", hash) <= 0) {
    return 1;
  }
  *instance = CreateMutexW(NULL, FALSE, name);
  if (*instance == NULL) return 1;
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (!bring_feedback_forward()) show_box(already_starting_text(), MB_ICONINFORMATION);
    (void)CloseHandle(*instance);
    *instance = NULL;
    return 0;
  }
  return 1;
}

/* The failure box of a start without a console (#4358). The CLI used to start a PowerShell for it,
 * which a slow machine could not finish before the CLI ended (the process and its attached children
 * end together), so the person saw nothing. The launcher outlives its child and is a native program:
 * when the `portable launch` child ended with a non-zero code, the launcher itself shows one message,
 * after it has released the one-launcher-per-installation mutex, so a box left open never blocks a
 * later start. The CLI leaves only a closed reason token in a file whose path it gets in
 * KEIKO_PORTABLE_FAILURE_NOTE; the launcher shows its own fixed text for it, never the file's text,
 * and a child that left nothing (crashed, was killed) gets the generic text. Wide escapes end their
 * string literal so that no hex digit that follows is read into them. */
#define KEIKO_FAILURE_GENERIC_EN \
  L"Keiko could not start.\r\n\r\n" \
  L"Start Keiko again. If this happens again, contact support and tell them the time of the start."
#define KEIKO_FAILURE_GENERIC_DE \
  L"Keiko konnte nicht starten.\r\n\r\n" \
  L"Starte Keiko neu. Tritt der Fehler wieder auf, wende dich an den Support und nenne die Uhrzeit des Starts."

typedef struct {
  const char *reason;
  const wchar_t *english;
  const wchar_t *german;
} keiko_failure_text;

#define KEIKO_FAILURE_HEALTH_TIMEOUT_EN \
  L"Keiko is still starting or took too long to start.\r\n\r\n" \
  L"Wait a moment and open Keiko again. If it happens again, contact support and tell them the time of the start."
#define KEIKO_FAILURE_HEALTH_TIMEOUT_DE \
  L"Keiko startet noch oder hat zu lange gebraucht.\r\n\r\n" \
  L"Warte einen Moment und \x00f6" L"ffne Keiko erneut. Tritt es wieder auf, wende dich an den Support und nenne die Uhrzeit des Starts."
#define KEIKO_FAILURE_PORT_IN_USE_EN \
  L"Keiko could not start because its port is already in use.\r\n\r\n" \
  L"Close the other Keiko or program that uses it and start Keiko again."
#define KEIKO_FAILURE_PORT_IN_USE_DE \
  L"Keiko konnte nicht starten, weil sein Port schon belegt ist.\r\n\r\n" \
  L"Schlie\x00df" L"e das andere Keiko oder Programm, das ihn nutzt, und starte Keiko neu."
#define KEIKO_FAILURE_SETUP_BUSY_EN \
  L"Keiko is already being set up or updated.\r\n\r\n" \
  L"Wait until that has finished, then open Keiko again."
#define KEIKO_FAILURE_SETUP_BUSY_DE \
  L"Keiko wird gerade eingerichtet oder aktualisiert.\r\n\r\n" \
  L"Warte, bis das fertig ist, und \x00f6" L"ffne Keiko dann erneut."

/* A start that met another start, stop or update of the same Keiko (the lifecycle guard is held):
 * not a failure of this start, so it does not say that Keiko could not start. */
#define KEIKO_FAILURE_LIFECYCLE_BUSY_EN \
  L"Keiko is just being started, stopped or updated.\r\n\r\n" \
  L"Wait a moment and open Keiko again."
#define KEIKO_FAILURE_LIFECYCLE_BUSY_DE \
  L"Keiko wird gerade gestartet, beendet oder aktualisiert.\r\n\r\n" \
  L"Warte einen Moment und \x00f6" L"ffne Keiko erneut."

static const keiko_failure_text KEIKO_FAILURE_TEXTS[] = {
  {"health-timeout", KEIKO_FAILURE_HEALTH_TIMEOUT_EN, KEIKO_FAILURE_HEALTH_TIMEOUT_DE},
  {"port-in-use", KEIKO_FAILURE_PORT_IN_USE_EN, KEIKO_FAILURE_PORT_IN_USE_DE},
  {"setup-busy", KEIKO_FAILURE_SETUP_BUSY_EN, KEIKO_FAILURE_SETUP_BUSY_DE},
  {"lifecycle-busy", KEIKO_FAILURE_LIFECYCLE_BUSY_EN, KEIKO_FAILURE_LIFECYCLE_BUSY_DE},
};

/* The exit code a console child gets from Ctrl+C or a logoff (STATUS_CONTROL_C_EXIT): the child was
 * ended on purpose, so it gets no failure box. A kill by the person (taskkill) is an ordinary
 * non-zero code and may show the generic box. */
#define KEIKO_STATUS_CONTROL_C_EXIT 0xC000013AUL

/* Called before the child starts: a stale note of an earlier launcher with the same process id must
 * not be shown, and a launcher that cannot name the file simply shows the generic text. The variable
 * is cleared first, so that on every error path below, and for a start WITH a console too, an
 * externally set value is never inherited by the child: the CLI honors only a path the launcher
 * itself named, and a start with a console names none. */
static void prepare_failure_note(keiko_launcher_buffers *buffers, int has_console) {
  wchar_t directory[KEIKO_NOTE_CAP];
  DWORD length;
  buffers->failure_note[0] = L'\0';
  (void)SetEnvironmentVariableW(L"KEIKO_PORTABLE_FAILURE_NOTE", NULL);
  if (has_console) return;
  length = GetTempPathW((DWORD)KEIKO_NOTE_CAP, directory);
  if (length == 0 || length >= (DWORD)KEIKO_NOTE_CAP) return;
  if (_snwprintf_s(buffers->failure_note, KEIKO_NOTE_CAP, _TRUNCATE, L"%lskeiko-launch-note-%lu.txt",
                   directory, (unsigned long)GetCurrentProcessId()) <= 0) {
    buffers->failure_note[0] = L'\0';
    return;
  }
  (void)DeleteFileW(buffers->failure_note);
  if (!SetEnvironmentVariableW(L"KEIKO_PORTABLE_FAILURE_NOTE", buffers->failure_note)) {
    buffers->failure_note[0] = L'\0';
  }
}

/* The reason token the CLI wrote: lowercase letters and hyphens up to the first other byte, at most
 * 31 of them. Anything else, or no file, is an empty reason. The file is removed once read. */
static void read_failure_reason(const wchar_t *path, char reason[32]) {
  char text[32];
  DWORD bytes_read = 0;
  DWORD index;
  HANDLE file;
  ZeroMemory(text, sizeof(text));
  reason[0] = '\0';
  if (path[0] == L'\0') return;
  file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                     OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return;
  if (!ReadFile(file, text, (DWORD)(sizeof(text) - 1u), &bytes_read, NULL)) bytes_read = 0;
  (void)CloseHandle(file);
  (void)DeleteFileW(path);
  for (index = 0; index < bytes_read && index < 31u; ++index) {
    if (!((text[index] >= 'a' && text[index] <= 'z') || text[index] == '-')) break;
    reason[index] = text[index];
  }
  reason[index] = '\0';
}

static const wchar_t *failure_text(const char *reason) {
  const int german = ui_language_is_german();
  size_t index;
  for (index = 0; index < sizeof(KEIKO_FAILURE_TEXTS) / sizeof(KEIKO_FAILURE_TEXTS[0]); ++index) {
    if (strcmp(KEIKO_FAILURE_TEXTS[index].reason, reason) == 0) {
      return german ? KEIKO_FAILURE_TEXTS[index].german : KEIKO_FAILURE_TEXTS[index].english;
    }
  }
  return german ? KEIKO_FAILURE_GENERIC_DE : KEIKO_FAILURE_GENERIC_EN;
}

static void show_failure_box(const keiko_launcher_buffers *buffers) {
  char reason[32];
  read_failure_reason(buffers->failure_note, reason);
  show_box(failure_text(reason), MB_ICONERROR);
}

static int launch_after_preflight(keiko_launcher_buffers *buffers, int has_console,
                                  int *child_ended);

static int run_with_feedback(keiko_launcher_buffers *buffers, int has_console) {
  HANDLE instance = NULL;
  keiko_feedback feedback = {NULL, NULL, 0};
  int child_ended = 0;
  int result;
  if (!has_console && !claim_launcher_instance(buffers->root, &instance)) return 0;
  if (!has_console) feedback_start(&feedback);
  result = launch_after_preflight(buffers, has_console, &child_ended);
  feedback_stop(&feedback);
  if (instance != NULL) (void)CloseHandle(instance);
  /* After the mutex is released: a box the person leaves open never blocks a later start. */
  if (!has_console && child_ended && result != 0 &&
      (DWORD)result != KEIKO_STATUS_CONTROL_C_EXIT) {
    show_failure_box(buffers);
  }
  return result;
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
   * here: a `portable launch` child that ended non-zero is reported by the failure box in
   * run_with_feedback (the CLI no longer starts a notifier of its own on Windows), never by both. */
  if (bootstrap_artifact_unusable(buffers->node) || bootstrap_artifact_unusable(buffers->cli)) {
    report_bootstrap_failure(
      has_console,
      L"keiko portable launch: the installation is incomplete\n",
      L"Keiko could not start: the installation is incomplete.\r\n"
      L"Reinstall Keiko, or run Keiko.exe from a terminal for details."
    );
    return 1;
  }

  return run_with_feedback(buffers, has_console);
}

static int launch_after_preflight(keiko_launcher_buffers *buffers, int has_console,
                                  int *child_ended) {
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

  prepare_failure_note(buffers, has_console);

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
  *child_ended = 1;
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
#if defined(__linux__) || defined(__APPLE__)
#include "keiko-portable-runtime-owner-linux.h"
#endif


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
  const char *runtime_owner = NULL;
#if defined(__linux__)
  const char *selected_launch = getenv("KEIKO_UI_LAUNCH_ID");
  if (selected_launch != NULL) {
    int metadata_type, control_type;
    socklen_t metadata_length = sizeof(metadata_type), control_length = sizeof(control_type);
    if (strcmp(selected_launch, coordinator->plan.field[restoring ? KEIKO_KHP_RESTORE_LAUNCH_ID
                                                                 : KEIKO_KHP_NEW_LAUNCH_ID]) != 0 ||
        getsockopt(7, SOL_SOCKET, SO_TYPE, &metadata_type, &metadata_length) != 0 ||
        metadata_type != SOCK_SEQPACKET ||
        getsockopt(8, SOL_SOCKET, SO_TYPE, &control_type, &control_length) != 0 ||
        control_type != SOCK_STREAM) return 1;
    runtime_owner = "--runtime-owner";
  }
#elif defined(__APPLE__)
  const char *selected_launch = getenv("KEIKO_UI_LAUNCH_ID");
  int control_type;
  socklen_t length = sizeof(control_type);
  if (selected_launch == NULL || strcmp(selected_launch,
          coordinator->plan.field[restoring ? KEIKO_KHP_RESTORE_LAUNCH_ID : KEIKO_KHP_NEW_LAUNCH_ID]) != 0 ||
      getsockopt(8, SOL_SOCKET, SO_TYPE, &control_type, &length) != 0 || control_type != SOCK_STREAM)
    return 1;
  runtime_owner = "--runtime-owner";
#endif
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
        runtime_owner,
        (char *)NULL);
  return 1;
}

int main(int argc, char **argv) {
#if defined(__linux__)
  if (argc == 4 && strcmp(argv[1], "--own-runtime") == 0)
    return keiko_runtime_owner_linux(argv[2], argv[3], 0);
  if (argc == 4 && strcmp(argv[1], "--own-app-runtime") == 0)
    return keiko_runtime_owner_linux(argv[2], argv[3], 1);
#endif
#if defined(__APPLE__)
  if (argc == 4 && strcmp(argv[1], "--own-app-runtime") == 0)
    return keiko_runtime_owner_linux(argv[2], argv[3], 1);
#endif
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
