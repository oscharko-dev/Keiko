/* #4068 W1: real OS boundaries of a per-tree AppContainer root, without administrator rights and
 * without WFP. The same probe runs unconfined first: a denial only counts when the identical
 * operation succeeds outside the container. Output is body-free: probe names and Win32 codes. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <shlobj.h>
#include <userenv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "gateway_grants.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "ws2_32.lib")

#define PATH_CHARS 1024
#define COMMAND_CHARS 8192
#define OUTPUT_BYTES 8192
#define PROBE_ARG_COUNT 12
#define GRANTS_PROBE_ARG_COUNT 9

static void report(const char *name, DWORD code) {
  char line[96];
  DWORD written = 0;
  int length = _snprintf_s(line, sizeof(line), _TRUNCATE, "%s=%lu\n", name, code);
  if (length > 0) (void)WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line, (DWORD)length, &written, NULL);
}

static DWORD open_process_code(DWORD pid, DWORD access) {
  HANDLE process = OpenProcess(access, FALSE, pid);
  DWORD code = process == NULL ? GetLastError() : ERROR_SUCCESS;
  if (process != NULL) CloseHandle(process);
  return code;
}

static DWORD read_file_code(const wchar_t *path) {
  char byte;
  DWORD count = 0, code = ERROR_SUCCESS;
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  if (!ReadFile(file, &byte, 1, &count, NULL) || count != 1) code = GetLastError();
  CloseHandle(file);
  return code;
}

static DWORD list_directory_code(const wchar_t *directory) {
  wchar_t pattern[PATH_CHARS];
  WIN32_FIND_DATAW entry;
  HANDLE find;
  if (_snwprintf_s(pattern, PATH_CHARS, _TRUNCATE, L"%ls\\*", directory) < 0) return ERROR_BUFFER_OVERFLOW;
  find = FindFirstFileW(pattern, &entry);
  if (find == INVALID_HANDLE_VALUE) return GetLastError();
  FindClose(find);
  return ERROR_SUCCESS;
}

static DWORD create_file_code(const wchar_t *directory) {
  wchar_t path[PATH_CHARS];
  HANDLE file;
  if (_snwprintf_s(path, PATH_CHARS, _TRUNCATE, L"%ls\\written-%lu.txt", directory,
                   GetCurrentProcessId()) < 0) return ERROR_BUFFER_OVERFLOW;
  file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_FLAG_DELETE_ON_CLOSE, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  CloseHandle(file);
  return ERROR_SUCCESS;
}

static DWORD connect_loopback_code(USHORT port) {
  struct sockaddr_in target = {0};
  WSAPOLLFD poll = {0};
  u_long nonblocking = 1;
  int error = 0, size = sizeof(error), ready;
  SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (client == INVALID_SOCKET) return (DWORD)WSAGetLastError();
  target.sin_family = AF_INET;
  target.sin_port = htons(port);
  target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (ioctlsocket(client, FIONBIO, &nonblocking) != 0) {
    closesocket(client);
    return ERROR_INVALID_PARAMETER;
  }
  if (connect(client, (const struct sockaddr *)&target, sizeof(target)) == 0) {
    closesocket(client);
    return ERROR_SUCCESS;
  }
  error = WSAGetLastError();
  if (error == WSAEWOULDBLOCK) {
    poll.fd = client;
    poll.events = POLLWRNORM;
    ready = WSAPoll(&poll, 1, 1500);
    if (ready == 0) error = WSAETIMEDOUT;
    else if (ready < 0) error = WSAGetLastError();
    else if (getsockopt(client, SOL_SOCKET, SO_ERROR, (char *)&error, &size) != 0) error = WSAGetLastError();
  }
  closesocket(client);
  return (DWORD)error;
}

/* TEMP exists in every interactive and service profile, so the unconfined control can read it. */
static DWORD user_environment_code(void) {
  DWORD size = 0;
  return (DWORD)RegGetValueW(HKEY_CURRENT_USER, L"Environment", L"TEMP", RRF_RT_ANY, NULL, NULL, &size);
}

/* A production root receives exactly the variables of its launch request. Winsock provider loading
 * depends on the environment, so measure sockets under a block with no inherited variable. */
static int run_socket_probe(const wchar_t *port) {
  WSADATA winsock;
  SOCKET handle;
  int started = WSAStartup(MAKEWORD(2, 2), &winsock);
  report("hermetic-winsock", (DWORD)started);
  if (started != 0) return 0;
  handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  report("hermetic-socket", handle == INVALID_SOCKET ? (DWORD)WSAGetLastError() : ERROR_SUCCESS);
  if (handle != INVALID_SOCKET) closesocket(handle);
  report("hermetic-connect", connect_loopback_code((USHORT)wcstoul(port, NULL, 10)));
  (void)WSACleanup();
  return 0;
}

static int run_probe(int argc, wchar_t **argv) {
  WSADATA winsock;
  DWORD foreign, peer;
  USHORT port;
  if (argc != PROBE_ARG_COUNT || WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return 2;
  foreign = (DWORD)wcstoul(argv[2], NULL, 10);
  peer = (DWORD)wcstoul(argv[3], NULL, 10);
  port = (USHORT)wcstoul(argv[4], NULL, 10);
  report("open-foreign-terminate", open_process_code(foreign, PROCESS_TERMINATE));
  report("open-foreign-vm-read", open_process_code(foreign, PROCESS_VM_READ));
  report("open-foreign-query", open_process_code(foreign, PROCESS_QUERY_INFORMATION));
  report("open-foreign-duplicate", open_process_code(foreign, PROCESS_DUP_HANDLE));
  report("open-peer-terminate", open_process_code(peer, PROCESS_TERMINATE));
  report("read-env-file", read_file_code(argv[5]));
  report("read-key-file", read_file_code(argv[6]));
  report("read-workspace-ungranted", read_file_code(argv[7]));
  report("read-granted", read_file_code(argv[8]));
  report("list-user-profile", list_directory_code(argv[9]));
  report("list-credential-store", list_directory_code(argv[10]));
  report("write-ungranted", create_file_code(argv[11]));
  report("registry-user-environment", user_environment_code());
  report("connect-host-loopback", connect_loopback_code(port));
  (void)WSACleanup();
  return 0;
}

/* B1: what a confined tree reaches through the production grants (gateway_grants.c), not through a
 * hand-made entry. Paths: runtime file, runtime directory, state directory, own worktree file, own
 * worktree directory, another run's worktree file, the user's own checkout file. */
static int run_grants_probe(int argc, wchar_t **argv) {
  if (argc != GRANTS_PROBE_ARG_COUNT) return 2;
  report("grants-read-runtime", read_file_code(argv[2]));
  report("grants-write-runtime", create_file_code(argv[3]));
  report("grants-write-state", create_file_code(argv[4]));
  report("grants-read-own-worktree", read_file_code(argv[5]));
  report("grants-write-own-worktree", create_file_code(argv[6]));
  report("grants-read-other-worktree", read_file_code(argv[7]));
  report("grants-read-user-checkout", read_file_code(argv[8]));
  return 0;
}

static DWORD write_sentinel(const wchar_t *path) {
  const char body[] = "W1-SENTINEL";
  DWORD written = 0, code = ERROR_SUCCESS;
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
  if (file == INVALID_HANDLE_VALUE) return GetLastError();
  if (!WriteFile(file, body, (DWORD)strlen(body), &written, NULL)) code = GetLastError();
  CloseHandle(file);
  return code;
}

static DWORD grant_read(wchar_t *path, PSID sid, DWORD access) {
  PACL before = NULL, after = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  EXPLICIT_ACCESSW entry = {0};
  DWORD result = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                                       &before, NULL, &descriptor);
  if (result != ERROR_SUCCESS) return result;
  entry.grfAccessPermissions = access;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.ptstrName = sid;
  result = SetEntriesInAclW(1, &entry, before, &after);
  if (result == ERROR_SUCCESS)
    result = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, after, NULL);
  if (after != NULL) LocalFree(after);
  LocalFree(descriptor);
  return result;
}

/* The capabilities a confined probe's token carries, as the supervisor passes a tree's grants. */
struct probe_capabilities {
  SID_AND_ATTRIBUTES *entries;
  DWORD count;
};

static const struct probe_capabilities NO_CAPABILITIES = {NULL, 0};

/* Only an AppContainer SID and its capabilities, stdin-less, with exactly the output pipe inherited. */
static DWORD launch(PSID sid, struct probe_capabilities held, wchar_t *executable,
                    const wchar_t *arguments, void *environment, HANDLE output, HANDLE job,
                    PROCESS_INFORMATION *process) {
  STARTUPINFOEXW startup = {0};
  SECURITY_CAPABILITIES capabilities = {0};
  HANDLE inherited[1];
  wchar_t *command = calloc(COMMAND_CHARS, sizeof(wchar_t));
  SIZE_T bytes = 0;
  DWORD attributes = sid == NULL ? 1 : 2, result = ERROR_SUCCESS;
  int ready = 0;
  inherited[0] = output;
  if (command == NULL) return ERROR_OUTOFMEMORY;
  if (_snwprintf_s(command, COMMAND_CHARS, _TRUNCATE, L"\"%ls\" %ls", executable, arguments) < 0) {
    result = ERROR_BUFFER_OVERFLOW;
    goto done;
  }
  capabilities.AppContainerSid = sid;
  capabilities.Capabilities = held.entries;
  capabilities.CapabilityCount = held.count;
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdOutput = output;
  startup.StartupInfo.hStdError = output;
  (void)InitializeProcThreadAttributeList(NULL, attributes, 0, &bytes);
  startup.lpAttributeList = calloc(1, bytes);
  if (startup.lpAttributeList == NULL) {
    result = ERROR_OUTOFMEMORY;
    goto done;
  }
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, attributes, 0, &bytes)) {
    result = GetLastError();
    goto done;
  }
  ready = 1;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inherited, sizeof(inherited), NULL, NULL) ||
      (sid != NULL && !UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                                 PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                                 &capabilities, sizeof(capabilities), NULL, NULL))) {
    result = GetLastError();
    goto done;
  }
  if (!CreateProcessW(executable, command, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW |
                          CREATE_UNICODE_ENVIRONMENT,
                      environment, NULL, &startup.StartupInfo, process)) {
    result = GetLastError();
    goto done;
  }
  if (!AssignProcessToJobObject(job, process->hProcess) || ResumeThread(process->hThread) == (DWORD)-1) {
    result = GetLastError();
    (void)TerminateProcess(process->hProcess, 90);
  }
done:
  if (ready) DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  free(command);
  return result;
}

static HANDLE kill_on_close_job(void) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  HANDLE job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job != NULL && !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    return NULL;
  }
  return job;
}

struct probe_output {
  char text[OUTPUT_BYTES];
  DWORD exit_code;
  DWORD launch_error;
};

static void run_and_capture(PSID sid, struct probe_capabilities held, wchar_t *executable,
                            const wchar_t *arguments, void *environment, struct probe_output *out) {
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  PROCESS_INFORMATION process = {0};
  HANDLE read_end = NULL, write_end = NULL;
  HANDLE job = kill_on_close_job();
  DWORD used = 0, count = 0;
  memset(out, 0, sizeof(*out));
  out->exit_code = (DWORD)-1;
  if (job == NULL || !CreatePipe(&read_end, &write_end, &inherit, 0) ||
      !SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0)) {
    out->launch_error = GetLastError();
    goto done;
  }
  out->launch_error = launch(sid, held, executable, arguments, environment, write_end, job, &process);
  CloseHandle(write_end);
  write_end = NULL;
  if (out->launch_error != ERROR_SUCCESS || process.hProcess == NULL) goto done;
  while (used < OUTPUT_BYTES - 1 && ReadFile(read_end, out->text + used, OUTPUT_BYTES - 1 - used, &count, NULL) && count)
    used += count;
  if (WaitForSingleObject(process.hProcess, 15000) == WAIT_OBJECT_0)
    (void)GetExitCodeProcess(process.hProcess, &out->exit_code);
done:
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (write_end != NULL) CloseHandle(write_end);
  if (read_end != NULL) CloseHandle(read_end);
  if (job != NULL) CloseHandle(job);
}

static long observed_code(const char *text, const char *name) {
  char key[64];
  const char *found;
  if (_snprintf_s(key, sizeof(key), _TRUNCATE, "%s=", name) < 0) return -1;
  found = strstr(text, key);
  return found == NULL ? -1 : strtol(found + strlen(key), NULL, 10);
}

static const char *const DENIED_ACCESS[] = {
    "open-foreign-terminate", "open-foreign-vm-read",     "open-foreign-query",
    "open-foreign-duplicate", "open-peer-terminate",      "read-env-file",
    "read-key-file",          "read-workspace-ungranted", "list-user-profile",
    "list-credential-store",  "write-ungranted",
};
/* The same operation must work outside the container, or its denial says nothing. */
static const char *const CONTROL_ALLOWED[] = {
    "open-foreign-terminate", "open-foreign-vm-read", "open-foreign-query", "open-foreign-duplicate",
    "read-env-file",          "read-key-file",        "read-workspace-ungranted", "read-granted",
    "list-user-profile",      "write-ungranted",      "registry-user-environment", "connect-host-loopback",
};

static int verify_control(const char *text) {
  size_t index;
  int failures = 0;
  for (index = 0; index < ARRAYSIZE(CONTROL_ALLOWED); ++index) {
    long code = observed_code(text, CONTROL_ALLOWED[index]);
    if (code != 0) {
      printf("FAIL unconfined control %s=%ld\n", CONTROL_ALLOWED[index], code);
      ++failures;
    }
  }
  return failures;
}

static int verify_confined(const char *text) {
  size_t index;
  int failures = 0;
  long code;
  for (index = 0; index < ARRAYSIZE(DENIED_ACCESS); ++index) {
    code = observed_code(text, DENIED_ACCESS[index]);
    if (code != ERROR_ACCESS_DENIED) {
      printf("FAIL confined %s=%ld (expected %d)\n", DENIED_ACCESS[index], code, ERROR_ACCESS_DENIED);
      ++failures;
    }
  }
  /* Open W1 blocker, never a pass: values stored with setx stay readable beside the env allowlist. */
  if (observed_code(text, "registry-user-environment") == 0)
    printf("OPEN W1 blocker: the confined root reads HKCU\\Environment\n");
  code = observed_code(text, "read-granted");
  if (code != 0) {
    printf("FAIL confined read-granted=%ld (expected 0)\n", code);
    ++failures;
  }
  code = observed_code(text, "connect-host-loopback");
  if (code <= 0) {
    printf("FAIL confined connect-host-loopback=%ld (expected a refusal)\n", code);
    ++failures;
  }
  return failures;
}

struct fixture {
  wchar_t root[PATH_CHARS], workspace[PATH_CHARS], secrets[PATH_CHARS], image[PATH_CHARS];
  wchar_t env_file[PATH_CHARS], key_file[PATH_CHARS], workspace_file[PATH_CHARS], granted[PATH_CHARS];
  wchar_t profile_dir[PATH_CHARS], credentials[PATH_CHARS];
  /* B1: a run's runtime root and state directory, its own and another run's managed worktree,
   * and the user's own checkout. */
  wchar_t runtime_dir[PATH_CHARS], runtime_file[PATH_CHARS], state_dir[PATH_CHARS];
  wchar_t own_dir[PATH_CHARS], own_file[PATH_CHARS], other_dir[PATH_CHARS], other_file[PATH_CHARS];
  wchar_t checkout_dir[PATH_CHARS], checkout_file[PATH_CHARS];
  wchar_t profile[64], peer_profile[64];
  PSID sid, peer_sid;
};

static int join_path(wchar_t *out, const wchar_t *directory, const wchar_t *leaf) {
  return _snwprintf_s(out, PATH_CHARS, _TRUNCATE, L"%ls\\%ls", directory, leaf) >= 0;
}

static DWORD fixture_paths(struct fixture *f) {
  wchar_t temp[PATH_CHARS];
  wchar_t *profile = NULL, *roaming = NULL;
  DWORD pid = GetCurrentProcessId();
  int ok;
  if (GetTempPathW(PATH_CHARS, temp) == 0) return GetLastError();
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_Profile, 0, NULL, &profile)) ||
      FAILED(SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, NULL, &roaming))) {
    CoTaskMemFree(profile);
    CoTaskMemFree(roaming);
    return ERROR_PATH_NOT_FOUND;
  }
  ok = _snwprintf_s(f->root, PATH_CHARS, _TRUNCATE, L"%lskeiko-w1-%lu", temp, pid) >= 0 &&
       join_path(f->workspace, f->root, L"workspace") && join_path(f->secrets, f->root, L"secrets") &&
       join_path(f->image, f->root, L"probe.exe") && join_path(f->env_file, f->secrets, L".env") &&
       join_path(f->key_file, f->secrets, L"id_rsa") &&
       join_path(f->workspace_file, f->workspace, L"inside.txt") &&
       join_path(f->granted, f->root, L"granted.txt") &&
       join_path(f->runtime_dir, f->root, L"runtime") &&
       join_path(f->runtime_file, f->runtime_dir, L"payload.txt") &&
       join_path(f->state_dir, f->root, L"state") && join_path(f->own_dir, f->root, L"own-worktree") &&
       join_path(f->own_file, f->own_dir, L"inside.txt") &&
       join_path(f->other_dir, f->root, L"other-worktree") &&
       join_path(f->other_file, f->other_dir, L"inside.txt") &&
       join_path(f->checkout_dir, f->root, L"user-checkout") &&
       join_path(f->checkout_file, f->checkout_dir, L"inside.txt") &&
       _snwprintf_s(f->profile_dir, PATH_CHARS, _TRUNCATE, L"%ls", profile) >= 0 &&
       _snwprintf_s(f->credentials, PATH_CHARS, _TRUNCATE, L"%ls\\Microsoft\\Credentials", roaming) >= 0 &&
       _snwprintf_s(f->profile, 64, _TRUNCATE, L"keiko.w1.%lu", pid) >= 0 &&
       _snwprintf_s(f->peer_profile, 64, _TRUNCATE, L"keiko.w1.peer.%lu", pid) >= 0;
  CoTaskMemFree(profile);
  CoTaskMemFree(roaming);
  return ok ? ERROR_SUCCESS : ERROR_BUFFER_OVERFLOW;
}

static DWORD fixture_create(struct fixture *f) {
  wchar_t self[PATH_CHARS];
  DWORD result = fixture_paths(f);
  HRESULT created;
  if (result != ERROR_SUCCESS) return result;
  if (!CreateDirectoryW(f->root, NULL) || !CreateDirectoryW(f->workspace, NULL) ||
      !CreateDirectoryW(f->secrets, NULL) || !CreateDirectoryW(f->runtime_dir, NULL) ||
      !CreateDirectoryW(f->state_dir, NULL) || !CreateDirectoryW(f->own_dir, NULL) ||
      !CreateDirectoryW(f->other_dir, NULL) || !CreateDirectoryW(f->checkout_dir, NULL))
    return GetLastError();
  if ((result = write_sentinel(f->env_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->key_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->workspace_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->granted)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->runtime_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->own_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->other_file)) != ERROR_SUCCESS ||
      (result = write_sentinel(f->checkout_file)) != ERROR_SUCCESS) return result;
  if (GetModuleFileNameW(NULL, self, PATH_CHARS) == 0 || !CopyFileW(self, f->image, TRUE)) return GetLastError();
  created = CreateAppContainerProfile(f->profile, f->profile, L"Disposable W1 boundary test", NULL, 0, &f->sid);
  if (FAILED(created)) return (DWORD)created;
  created = CreateAppContainerProfile(f->peer_profile, f->peer_profile, L"Disposable W1 peer", NULL, 0, &f->peer_sid);
  return FAILED(created) ? (DWORD)created : ERROR_SUCCESS;
}

static void fixture_remove(struct fixture *f) {
  const wchar_t *const files[] = {f->env_file,   f->key_file,      f->workspace_file,
                                  f->granted,    f->image,         f->runtime_file,
                                  f->own_file,   f->other_file,    f->checkout_file};
  const wchar_t *const directories[] = {f->workspace, f->secrets,   f->runtime_dir, f->state_dir,
                                        f->own_dir,   f->other_dir, f->checkout_dir, f->root};
  size_t index;
  for (index = 0; index < ARRAYSIZE(files); ++index) (void)DeleteFileW(files[index]);
  for (index = 0; index < ARRAYSIZE(directories); ++index) (void)RemoveDirectoryW(directories[index]);
  if (f->sid != NULL) {
    (void)DeleteAppContainerProfile(f->profile);
    FreeSid(f->sid);
  }
  if (f->peer_sid != NULL) {
    (void)DeleteAppContainerProfile(f->peer_profile);
    FreeSid(f->peer_sid);
  }
}

static DWORD start_hold(PSID sid, wchar_t *image, HANDLE job, PROCESS_INFORMATION *process) {
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  HANDLE null_out = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, NULL);
  DWORD result;
  if (null_out == INVALID_HANDLE_VALUE) return GetLastError();
  result = launch(sid, NO_CAPABILITIES, image, L"--hold", NULL, null_out, job, process);
  CloseHandle(null_out);
  return result;
}

/* One KGG1 frame as the host sends it: header, entry count, then (access, principal, path[, name]). */
struct grant_frame {
  unsigned char bytes[8192];
  size_t length;
  unsigned count;
};

static void put_u32(unsigned char *at, DWORD value) {
  at[0] = (unsigned char)value;
  at[1] = (unsigned char)(value >> 8);
  at[2] = (unsigned char)(value >> 16);
  at[3] = (unsigned char)(value >> 24);
}

static int frame_text(struct grant_frame *frame, const wchar_t *text) {
  char utf8[PATH_CHARS * 3];
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, (int)sizeof(utf8), NULL, NULL);
  if (bytes <= 1 || frame->length + 4 + (size_t)(bytes - 1) > sizeof(frame->bytes)) return 0;
  put_u32(frame->bytes + frame->length, (DWORD)(bytes - 1));
  memcpy(frame->bytes + frame->length + 4, utf8, (size_t)(bytes - 1));
  frame->length += 4 + (size_t)(bytes - 1);
  return 1;
}

static void frame_begin(struct grant_frame *frame) {
  memset(frame, 0, sizeof(*frame));
  memcpy(frame->bytes, "KGG1", 4);
  frame->bytes[4] = 1;
  frame->bytes[6] = 1;
  frame->length = 14;
}

static int frame_add(struct grant_frame *frame, int access, int principal, const wchar_t *path,
                     const wchar_t *capability) {
  if (frame->length + 2 > sizeof(frame->bytes)) return 0;
  frame->bytes[frame->length++] = (unsigned char)access;
  frame->bytes[frame->length++] = (unsigned char)principal;
  if (!frame_text(frame, path)) return 0;
  if (capability != NULL && !frame_text(frame, capability)) return 0;
  ++frame->count;
  return 1;
}

static int frame_parse(struct grant_frame *frame, struct keiko_gateway_grants *grants) {
  put_u32(frame->bytes + 8, (DWORD)(frame->length - 12));
  frame->bytes[12] = (unsigned char)frame->count;
  frame->bytes[13] = (unsigned char)(frame->count >> 8);
  return keiko_gateway_grants_parse(frame->bytes, frame->length, grants);
}

static const char *const GRANTS_CONTROL_ALLOWED[] = {
    "grants-read-runtime",        "grants-write-runtime",       "grants-write-state",
    "grants-read-own-worktree",   "grants-write-own-worktree",  "grants-read-other-worktree",
    "grants-read-user-checkout",
};
static const char *const GRANTS_CONFINED_ALLOWED[] = {
    "grants-read-runtime", "grants-write-state", "grants-read-own-worktree"};
static const char *const GRANTS_CONFINED_DENIED[] = {
    "grants-write-runtime", "grants-write-own-worktree", "grants-read-other-worktree",
    "grants-read-user-checkout"};

static int expect_codes(const char *text, const char *const *names, size_t count, long expected,
                        const char *label) {
  size_t index;
  int failures = 0;
  for (index = 0; index < count; ++index) {
    long code = observed_code(text, names[index]);
    if (code != expected) {
      printf("FAIL %s %s=%ld (expected %ld)\n", label, names[index], code, expected);
      ++failures;
    }
  }
  return failures;
}

/* The tree's own grants (runtime read, state modify, its worktree through its capability) and, as
 * another run would leave it, a second worktree's capability grant held by a different tree. */
static int build_grants(struct fixture *f, struct keiko_gateway_grants *own,
                        struct keiko_gateway_grants *other) {
  static const wchar_t OWN[] = L"keiko.workspace.0123456789abcdef0123456789abcdef";
  static const wchar_t OTHER[] = L"keiko.workspace.fedcba9876543210fedcba9876543210";
  struct grant_frame frame;
  frame_begin(&frame);
  if (!frame_add(&frame, KEIKO_GRANT_READ, KEIKO_GRANT_TREE, f->runtime_dir, NULL) ||
      !frame_add(&frame, KEIKO_GRANT_MODIFY, KEIKO_GRANT_TREE, f->state_dir, NULL) ||
      !frame_add(&frame, KEIKO_GRANT_READ, KEIKO_GRANT_CAPABILITY, f->own_dir, OWN) ||
      !frame_parse(&frame, own))
    return 0;
  frame_begin(&frame);
  return frame_add(&frame, KEIKO_GRANT_READ, KEIKO_GRANT_CAPABILITY, f->other_dir, OTHER) &&
         frame_parse(&frame, other);
}

static int run_grants_boundary(struct fixture *f) {
  struct keiko_gateway_grants own = {0}, other = {0};
  struct probe_output *control = calloc(2, sizeof(*control));
  struct probe_output *confined = control == NULL ? NULL : control + 1;
  wchar_t *arguments = calloc(COMMAND_CHARS, sizeof(wchar_t));
  struct probe_capabilities held;
  int failures = 0, applied_own = 0, applied_other = 0;
  if (control == NULL || arguments == NULL || !build_grants(f, &own, &other)) {
    printf("FAIL grants frame\n");
    failures = 1;
    goto done;
  }
  applied_own = keiko_gateway_grants_apply(&own, f->sid) == KEIKO_GRANTS_APPLIED;
  applied_other = keiko_gateway_grants_apply(&other, f->peer_sid) == KEIKO_GRANTS_APPLIED;
  if (!applied_own || !applied_other || own.capability_count != 1) {
    printf("FAIL grants apply own=%d other=%d capabilities=%lu\n", applied_own, applied_other,
           own.capability_count);
    failures = 1;
    goto done;
  }
  if (_snwprintf_s(arguments, COMMAND_CHARS, _TRUNCATE,
                   L"--grants-probe \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\"",
                   f->runtime_file, f->runtime_dir, f->state_dir, f->own_file, f->own_dir,
                   f->other_file, f->checkout_file) < 0) {
    failures = 1;
    goto done;
  }
  held.entries = own.capabilities;
  held.count = own.capability_count;
  run_and_capture(NULL, NO_CAPABILITIES, f->image, arguments, NULL, control);
  run_and_capture(f->sid, held, f->image, arguments, NULL, confined);
  printf("grants control launch=%lu exit=%lu\n%s", control->launch_error, control->exit_code,
         control->text);
  printf("grants confined launch=%lu exit=%lu\n%s", confined->launch_error, confined->exit_code,
         confined->text);
  failures += expect_codes(control->text, GRANTS_CONTROL_ALLOWED, ARRAYSIZE(GRANTS_CONTROL_ALLOWED),
                           0, "unconfined control");
  failures += expect_codes(confined->text, GRANTS_CONFINED_ALLOWED,
                           ARRAYSIZE(GRANTS_CONFINED_ALLOWED), 0, "confined");
  failures += expect_codes(confined->text, GRANTS_CONFINED_DENIED, ARRAYSIZE(GRANTS_CONFINED_DENIED),
                           ERROR_ACCESS_DENIED, "confined");
done:
  if (applied_own) keiko_gateway_grants_revoke(&own, f->sid);
  if (applied_other) keiko_gateway_grants_revoke(&other, f->peer_sid);
  keiko_gateway_grants_clear(&own);
  keiko_gateway_grants_clear(&other);
  free(control);
  free(arguments);
  printf(failures == 0 ? "B1 grants: PASS\n" : "B1 grants: FAIL\n");
  return failures;
}

static int run_boundary(struct fixture *f) {
  struct sockaddr_in local = {0};
  int local_size = sizeof(local), failures = 0;
  WSADATA winsock;
  SOCKET listener = INVALID_SOCKET;
  PROCESS_INFORMATION foreign = {0}, peer = {0};
  static wchar_t empty_environment[] = {L'K', L'=', L'1', L'\0', L'\0'};
  struct probe_output *control = calloc(3, sizeof(*control));
  struct probe_output *confined = control == NULL ? NULL : control + 1;
  struct probe_output *hermetic = control == NULL ? NULL : control + 2;
  wchar_t socket_arguments[64];
  wchar_t *arguments = calloc(COMMAND_CHARS, sizeof(wchar_t));
  HANDLE job = kill_on_close_job();
  DWORD result;
  if (control == NULL || arguments == NULL || job == NULL) {
    failures = 1;
    goto done;
  }
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
    failures = 1;
    goto done;
  }
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET || bind(listener, (struct sockaddr *)&local, sizeof(local)) != 0 ||
      listen(listener, 8) != 0 || getsockname(listener, (struct sockaddr *)&local, &local_size) != 0) {
    printf("FAIL listener=%d\n", WSAGetLastError());
    failures = 1;
    goto done;
  }
  /* The image needs an explicit grant for its own package only; the workspace and secrets get none. */
  if ((result = grant_read(f->image, f->sid, GENERIC_READ | GENERIC_EXECUTE)) != ERROR_SUCCESS ||
      (result = grant_read(f->image, f->peer_sid, GENERIC_READ | GENERIC_EXECUTE)) != ERROR_SUCCESS ||
      (result = grant_read(f->granted, f->sid, GENERIC_READ)) != ERROR_SUCCESS) {
    printf("FAIL grant=%lu\n", result);
    failures = 1;
    goto done;
  }
  if ((result = start_hold(NULL, f->image, job, &foreign)) != ERROR_SUCCESS ||
      (result = start_hold(f->peer_sid, f->image, job, &peer)) != ERROR_SUCCESS) {
    printf("FAIL hold=%lu\n", result);
    failures = 1;
    goto done;
  }
  if (_snwprintf_s(arguments, COMMAND_CHARS, _TRUNCATE,
                   L"--probe %lu %lu %u \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\" \"%ls\"",
                   foreign.dwProcessId, peer.dwProcessId, (unsigned)ntohs(local.sin_port), f->env_file,
                   f->key_file, f->workspace_file, f->granted, f->profile_dir, f->credentials,
                   f->workspace) < 0) {
    failures = 1;
    goto done;
  }
  run_and_capture(NULL, NO_CAPABILITIES, f->image, arguments, NULL, control);
  run_and_capture(f->sid, NO_CAPABILITIES, f->image, arguments, NULL, confined);
  if (_snwprintf_s(socket_arguments, 64, _TRUNCATE, L"--socket-probe %u", (unsigned)ntohs(local.sin_port)) < 0) {
    failures = 1;
    goto done;
  }
  run_and_capture(NULL, NO_CAPABILITIES, f->image, socket_arguments, empty_environment, hermetic);
  printf("hermetic launch=%lu exit=%lu\n%s", hermetic->launch_error, hermetic->exit_code, hermetic->text);
  printf("control launch=%lu exit=%lu\n%s", control->launch_error, control->exit_code, control->text);
  printf("confined launch=%lu exit=%lu\n%s", confined->launch_error, confined->exit_code, confined->text);
  failures += verify_control(control->text);
  failures += verify_confined(confined->text);
  failures += run_grants_boundary(f);
done:
  if (job != NULL) CloseHandle(job);
  if (foreign.hProcess != NULL) {
    (void)WaitForSingleObject(foreign.hProcess, 5000);
    CloseHandle(foreign.hProcess);
    CloseHandle(foreign.hThread);
  }
  if (peer.hProcess != NULL) {
    (void)WaitForSingleObject(peer.hProcess, 5000);
    CloseHandle(peer.hProcess);
    CloseHandle(peer.hThread);
  }
  if (listener != INVALID_SOCKET) closesocket(listener);
  (void)WSACleanup();
  free(control);
  free(arguments);
  return failures;
}

int wmain(int argc, wchar_t **argv) {
  struct fixture *f;
  DWORD setup;
  int failures;
  if (argc == 2 && wcscmp(argv[1], L"--hold") == 0) {
    Sleep(INFINITE);
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"--socket-probe") == 0) return run_socket_probe(argv[2]);
  if (argc > 1 && wcscmp(argv[1], L"--probe") == 0) return run_probe(argc, argv);
  if (argc > 1 && wcscmp(argv[1], L"--grants-probe") == 0) return run_grants_probe(argc, argv);
  f = calloc(1, sizeof(*f));
  if (f == NULL) return 2;
  setup = fixture_create(f);
  if (setup != ERROR_SUCCESS) {
    printf("FAIL fixture=%lu\n", setup);
    fixture_remove(f);
    free(f);
    return 2;
  }
  failures = run_boundary(f);
  fixture_remove(f);
  free(f);
  printf(failures == 0 ? "runtime boundary: PASS\n" : "runtime boundary: FAIL\n");
  return failures == 0 ? 0 : 1;
}
