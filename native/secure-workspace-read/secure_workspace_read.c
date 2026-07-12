/* KSR1/KSS1 one-shot helper. It deliberately has no diagnostics or logging. */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define KSR_VERSION 1u
#define KSR_MAX_ROOT 32768u
#define KSR_MAX_PATH 4096u
#define KSR_CAP 65536u
#define KSR_MAX_COMPONENTS 64u

enum ksr_status {
  KSR_OK = 0, KSR_MALFORMED_REQUEST = 1, KSR_UNSUPPORTED_PLATFORM = 2,
  KSR_INVALID_PATH = 3, KSR_ACCESS_DENIED = 4, KSR_NOT_REGULAR = 5,
  KSR_CONTENT_TOO_LARGE = 6, KSR_CONTENT_NOT_TEXT = 7,
  KSR_CHANGED_DURING_READ = 8, KSR_IO_FAILURE = 9
};

struct request { char *root; char *path; uint32_t cap; };

static uint16_t le16(const unsigned char *p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }
static uint32_t le32(const unsigned char *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static void put16(unsigned char *p, uint16_t n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); }
static void put32(unsigned char *p, uint32_t n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); p[2] = (unsigned char)(n >> 16); p[3] = (unsigned char)(n >> 24); }

static int valid_utf8(const unsigned char *s, size_t n) {
  size_t i = 0;
  while (i < n) {
    uint32_t cp; unsigned char c = s[i++];
    if (c < 0x80) { cp = c; }
    else if (c >= 0xc2 && c <= 0xdf && i < n && (s[i] & 0xc0) == 0x80) { cp = ((uint32_t)(c & 0x1f) << 6) | (s[i++] & 0x3f); }
    else if (c >= 0xe0 && c <= 0xef && i + 1 < n && (s[i] & 0xc0) == 0x80 && (s[i + 1] & 0xc0) == 0x80) {
      cp = ((uint32_t)(c & 0x0f) << 12) | ((uint32_t)(s[i] & 0x3f) << 6) | (s[i + 1] & 0x3f); i += 2;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
    } else if (c >= 0xf0 && c <= 0xf4 && i + 2 < n && (s[i] & 0xc0) == 0x80 && (s[i + 1] & 0xc0) == 0x80 && (s[i + 2] & 0xc0) == 0x80) {
      cp = ((uint32_t)(c & 7) << 18) | ((uint32_t)(s[i] & 0x3f) << 12) | ((uint32_t)(s[i + 1] & 0x3f) << 6) | (s[i + 2] & 0x3f); i += 3;
      if (cp < 0x10000 || cp > 0x10ffff) return 0;
    } else return 0;
    if (cp == 0 || cp == 0x7f || (cp < 0x20 && cp != '\t' && cp != '\n' && cp != '\r') || (cp >= 0x80 && cp <= 0x9f)) return 0;
  }
  return 1;
}

static int windows_reserved_component(const char *component, size_t length) {
#if defined(_WIN32)
  char name[10]; size_t n = 0;
  while (n < length && component[n] != '.' && n + 1 < sizeof(name)) { char c = component[n]; name[n] = (c >= 'a' && c <= 'z') ? (char)(c - ('a' - 'A')) : c; ++n; }
  name[n] = '\0';
  return strcmp(name, "CON") == 0 || strcmp(name, "PRN") == 0 || strcmp(name, "AUX") == 0 || strcmp(name, "NUL") == 0 || strcmp(name, "CLOCK$") == 0 || ((strncmp(name, "COM", 3) == 0 || strncmp(name, "LPT", 3) == 0) && n == 4 && name[3] >= '1' && name[3] <= '9') || strcmp(name, "GLOBALROOT") == 0 || strcmp(name, "DEVICE") == 0 || strcmp(name, "??") == 0;
#else
  (void)component; (void)length; return 0;
#endif
}

static int valid_path(const char *path) {
  const char *p = path; unsigned int components = 0;
  if (*p == '\0' || *p == '/' || *p == '\\') return 0;
  while (*p) {
    const char *component = p;
    while (*p && *p != '/') { if (*p == '\\') return 0; ++p; }
    if (++components > KSR_MAX_COMPONENTS || p == component || (p - component == 1 && component[0] == '.') || (p - component == 2 && component[0] == '.' && component[1] == '.') || windows_reserved_component(component, (size_t)(p - component))) return 0;
#if defined(_WIN32)
    if (component[p - component - 1] == '.' || component[p - component - 1] == ' ') return 0;
    for (const char *q = component; q < p; ++q) if (*q == ':' || *q == '?' || *q == '~') return 0;
#endif
    if (*p == '/') ++p;
  }
  return 1;
}

static int valid_root(const char *root) {
#if defined(_WIN32)
  return ((root[0] >= 'A' && root[0] <= 'Z') || (root[0] >= 'a' && root[0] <= 'z')) && root[1] == ':' && (root[2] == '/' || root[2] == '\\');
#else
  return root[0] == '/';
#endif
}

static void reply(enum ksr_status status, const unsigned char *content, uint32_t length) {
  unsigned char header[12] = { 'K', 'S', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0 };
  if (status != KSR_OK) { content = NULL; length = 0; }
  put16(header + 4, KSR_VERSION); put16(header + 6, (uint16_t)status); put32(header + 8, length);
  (void)fwrite(header, 1, sizeof(header), stdout);
  if (content != NULL && length != 0) (void)fwrite(content, 1, length, stdout);
  (void)fflush(stdout);
}

static enum ksr_status parse_request(struct request *out) {
  unsigned char header[20]; uint32_t root_len, path_len; size_t total;
  memset(out, 0, sizeof(*out));
  if (fread(header, 1, sizeof(header), stdin) != sizeof(header) || memcmp(header, "KSR1", 4) != 0 || le16(header + 4) != KSR_VERSION || le16(header + 6) != 0) return KSR_MALFORMED_REQUEST;
  root_len = le32(header + 8); path_len = le32(header + 12); out->cap = le32(header + 16);
  if (root_len == 0 || root_len > KSR_MAX_ROOT || path_len == 0 || path_len > KSR_MAX_PATH || out->cap != KSR_CAP) return KSR_MALFORMED_REQUEST;
  total = (size_t)root_len + (size_t)path_len;
  out->root = calloc(total + 2, 1);
  if (out->root == NULL) return KSR_IO_FAILURE;
  out->path = out->root + root_len + 1;
  if (fread(out->root, 1, root_len, stdin) != root_len || fread(out->path, 1, path_len, stdin) != path_len || fgetc(stdin) != EOF || memchr(out->root, 0, root_len) || memchr(out->path, 0, path_len) || !valid_utf8((unsigned char *)out->root, root_len) || !valid_utf8((unsigned char *)out->path, path_len)) return KSR_MALFORMED_REQUEST;
  if (!valid_root(out->root)) return KSR_MALFORMED_REQUEST;
  if (!valid_path(out->path)) return KSR_INVALID_PATH;
  return KSR_OK;
}

static void clear_request(struct request *request) {
  if (request->root != NULL) { size_t n = strlen(request->root) + strlen(request->path) + 2; memset(request->root, 0, n); free(request->root); }
}

#if defined(__APPLE__)
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

static int same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink && a->st_size == b->st_size && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
/* Test binary only: signal the harness after the final fd baseline, then wait. */
static void pause_after_final_open(void) {
  unsigned char byte = 1;
  if (write(3, &byte, 1) != 1 || read(4, &byte, 1) != 1) _exit(127);
}
#endif

static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length) {
  int fds[KSR_MAX_COMPONENTS + 1], fd = -1, count = 0; char *copy = NULL, *part, *next; struct stat root_st, dirs[KSR_MAX_COMPONENTS + 1], before, after; unsigned char *buffer = NULL; ssize_t chunk; size_t got = 0; int changed = 0;
  *content = NULL; *length = 0;
  fd = open(request->root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return KSR_ACCESS_DENIED;
  fds[count] = fd;
  if (fstat(fd, &root_st) != 0 || !S_ISDIR(root_st.st_mode)) { close(fd); return KSR_ACCESS_DENIED; }
  dirs[count++] = root_st;
  copy = strdup(request->path); if (copy == NULL) { close(fd); return KSR_IO_FAILURE; }
  part = copy;
  while ((next = strchr(part, '/')) != NULL) {
    *next++ = '\0'; fd = openat(fds[count - 1], part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) { free(copy); while (count) close(fds[--count]); return KSR_ACCESS_DENIED; }
    if (fstat(fd, &dirs[count]) != 0 || !S_ISDIR(dirs[count].st_mode) || dirs[count].st_dev != root_st.st_dev) { close(fd); free(copy); while (count) close(fds[--count]); return KSR_ACCESS_DENIED; }
    fds[count++] = fd; part = next;
  }
  fd = openat(fds[count - 1], part, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  free(copy);
  if (fd < 0) { while (count) close(fds[--count]); return KSR_ACCESS_DENIED; }
  if (fstat(fd, &before) != 0) { close(fd); while (count) close(fds[--count]); return KSR_IO_FAILURE; }
  if (before.st_nlink == 0) { close(fd); while (count) close(fds[--count]); return KSR_CHANGED_DURING_READ; }
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_dev != root_st.st_dev || before.st_size < 0) { close(fd); while (count) close(fds[--count]); return KSR_NOT_REGULAR; }
  if ((uintmax_t)before.st_size > request->cap) { close(fd); while (count) close(fds[--count]); return KSR_CONTENT_TOO_LARGE; }
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
  pause_after_final_open();
#endif
  buffer = calloc((size_t)request->cap + 1, 1); if (buffer == NULL) { close(fd); while (count) close(fds[--count]); return KSR_IO_FAILURE; }
  while (got < (size_t)request->cap + 1) {
    chunk = read(fd, buffer + got, (size_t)request->cap + 1 - got);
    if (chunk < 0 && errno == EINTR) continue;
    if (chunk < 0) { memset(buffer, 0, request->cap + 1); free(buffer); close(fd); while (count) close(fds[--count]); return KSR_IO_FAILURE; }
    if (chunk == 0) break;
    got += (size_t)chunk;
  }
  if (got > request->cap) { memset(buffer, 0, request->cap + 1); free(buffer); close(fd); while (count) close(fds[--count]); return KSR_CONTENT_TOO_LARGE; }
  if (fstat(fd, &after) != 0 || !same_identity(&before, &after) || got != (size_t)before.st_size) changed = 1;
  for (int i = 0; i < count; ++i) { struct stat now; if (fstat(fds[i], &now) != 0 || !same_identity(&dirs[i], &now)) changed = 1; }
  if (changed) { memset(buffer, 0, request->cap + 1); free(buffer); close(fd); while (count) close(fds[--count]); return KSR_CHANGED_DURING_READ; }
  close(fd); while (count) close(fds[--count]);
  if (!valid_utf8(buffer, got)) { memset(buffer, 0, request->cap + 1); free(buffer); return KSR_CONTENT_NOT_TEXT; }
  *content = buffer; *length = (uint32_t)got; return KSR_OK;
}
#elif defined(_WIN32)
#include <windows.h>
#include <winternl.h>
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
#include <io.h>
#include <process.h>
#endif

#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif

typedef NTSTATUS (NTAPI *nt_create_file_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
struct file_identity { FILE_ID_INFO id; FILE_STANDARD_INFO standard; FILE_BASIC_INFO basic; };

static int is_reparse(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) || (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

static int identity(HANDLE handle, struct file_identity *out) {
  return GetFileInformationByHandleEx(handle, FileIdInfo, &out->id, sizeof(out->id)) && GetFileInformationByHandleEx(handle, FileStandardInfo, &out->standard, sizeof(out->standard)) && GetFileInformationByHandleEx(handle, FileBasicInfo, &out->basic, sizeof(out->basic));
}

static int same_identity(const struct file_identity *a, const struct file_identity *b) {
  return a->id.VolumeSerialNumber == b->id.VolumeSerialNumber && memcmp(a->id.FileId.Identifier, b->id.FileId.Identifier, sizeof(a->id.FileId.Identifier)) == 0 && a->standard.NumberOfLinks == b->standard.NumberOfLinks && a->standard.EndOfFile.QuadPart == b->standard.EndOfFile.QuadPart && a->basic.LastWriteTime.QuadPart == b->basic.LastWriteTime.QuadPart && a->basic.ChangeTime.QuadPart == b->basic.ChangeTime.QuadPart;
}

#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
/* Test binary only: Node maps its extra stdio pipes to CRT descriptors 3 and 4. */
static void pause_after_final_open(void) {
  unsigned char byte = 1;
  if (_write(3, &byte, 1) != 1 || _read(4, &byte, 1) != 1) _exit(127);
}
#endif

static int canonical_path_matches(HANDLE root, HANDLE file, const wchar_t *requested) {
  wchar_t root_path[KSR_MAX_ROOT + 8], file_path[KSR_MAX_ROOT + KSR_MAX_PATH + 8], expected[KSR_MAX_PATH + 1]; DWORD root_length, file_length; size_t expected_length, prefix_length; const wchar_t *suffix;
  root_length = GetFinalPathNameByHandleW(root, root_path, (DWORD)(sizeof(root_path) / sizeof(root_path[0])), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  file_length = GetFinalPathNameByHandleW(file, file_path, (DWORD)(sizeof(file_path) / sizeof(file_path[0])), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (root_length == 0 || root_length >= sizeof(root_path) / sizeof(root_path[0]) || file_length == 0 || file_length >= sizeof(file_path) / sizeof(file_path[0])) return 0;
  prefix_length = (size_t)root_length;
  if (_wcsnicmp(root_path, file_path, prefix_length) != 0) return 0;
  if (root_path[prefix_length - 1] == L'\\') suffix = file_path + prefix_length;
  else { if (file_path[prefix_length] != L'\\') return 0; suffix = file_path + prefix_length + 1; }
  expected_length = wcslen(requested);
  if (expected_length == 0 || expected_length > KSR_MAX_PATH) return 0;
  for (size_t i = 0; i <= expected_length; ++i) expected[i] = requested[i] == L'/' ? L'\\' : requested[i];
  return _wcsicmp(suffix, expected) == 0;
}

static HANDLE open_component(nt_create_file_fn nt_create, HANDLE parent, const wchar_t *name, USHORT length, int directory) {
  UNICODE_STRING u; OBJECT_ATTRIBUTES attributes; IO_STATUS_BLOCK ios; HANDLE handle = INVALID_HANDLE_VALUE; NTSTATUS status;
  u.Buffer = (PWSTR)name; u.Length = length; u.MaximumLength = length;
  InitializeObjectAttributes(&attributes, &u, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, NULL);
  status = nt_create(&handle, (directory ? FILE_TRAVERSE : FILE_READ_DATA) | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes, &ios, NULL, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), NULL, 0);
  return status < 0 ? INVALID_HANDLE_VALUE : handle;
}

static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length) {
  wchar_t *root = NULL, *path = NULL, *cursor, *slash; HANDLE handles[KSR_MAX_COMPONENTS + 1], file = INVALID_HANDLE_VALUE; int count = 0; DWORD chunk = 0, read = 0; struct file_identity dirs[KSR_MAX_COMPONENTS + 1], before, after; unsigned char *buffer = NULL; nt_create_file_fn nt_create;
  *content = NULL; *length = 0;
  root = calloc(KSR_MAX_ROOT + 1, sizeof(*root)); path = calloc(KSR_MAX_PATH + 1, sizeof(*path));
  if (root == NULL || path == NULL || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, request->root, -1, root, KSR_MAX_ROOT) == 0 || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, request->path, -1, path, KSR_MAX_PATH) == 0) { free(root); free(path); return KSR_IO_FAILURE; }
  nt_create = (nt_create_file_fn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile");
  if (nt_create == NULL) { free(root); free(path); return KSR_UNSUPPORTED_PLATFORM; }
  file = CreateFileW(root, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(root);
  if (file == INVALID_HANDLE_VALUE || is_reparse(file)) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); free(path); return KSR_ACCESS_DENIED; }
  if (!identity(file, &dirs[count])) { CloseHandle(file); free(path); return KSR_ACCESS_DENIED; }
  handles[count++] = file;
  cursor = path;
  while ((slash = wcschr(cursor, L'/')) != NULL) {
    *slash = L'\0'; file = open_component(nt_create, handles[count - 1], cursor, (USHORT)(wcslen(cursor) * sizeof(*cursor)), 1);
    *slash = L'/';
    if (file == INVALID_HANDLE_VALUE || is_reparse(file)) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); free(path); while (count) CloseHandle(handles[--count]); return KSR_ACCESS_DENIED; }
    if (!identity(file, &dirs[count])) { CloseHandle(file); free(path); while (count) CloseHandle(handles[--count]); return KSR_ACCESS_DENIED; }
    handles[count++] = file; cursor = slash + 1;
  }
  file = open_component(nt_create, handles[count - 1], cursor, (USHORT)(wcslen(cursor) * sizeof(*cursor)), 0);
  if (file == INVALID_HANDLE_VALUE || is_reparse(file)) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); free(path); while (count) CloseHandle(handles[--count]); return KSR_ACCESS_DENIED; }
  if (GetFileType(file) != FILE_TYPE_DISK || !identity(file, &before) || before.id.VolumeSerialNumber != dirs[0].id.VolumeSerialNumber || before.standard.NumberOfLinks != 1 || before.standard.EndOfFile.QuadPart < 0) { free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_NOT_REGULAR; }
  if ((uint64_t)before.standard.EndOfFile.QuadPart > request->cap) { free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_CONTENT_TOO_LARGE; }
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
  pause_after_final_open();
#endif
  buffer = calloc((size_t)request->cap + 1, 1); if (buffer == NULL) { free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_IO_FAILURE; }
  while (read < request->cap + 1) {
    if (!ReadFile(file, buffer + read, request->cap + 1 - read, &chunk, NULL)) { memset(buffer, 0, request->cap + 1); free(buffer); free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_IO_FAILURE; }
    if (chunk == 0) break;
    read += chunk;
  }
  if (read > request->cap) { memset(buffer, 0, request->cap + 1); free(buffer); free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_CONTENT_TOO_LARGE; }
  if (!identity(file, &after) || !same_identity(&before, &after) || read != (DWORD)before.standard.EndOfFile.QuadPart) { memset(buffer, 0, request->cap + 1); free(buffer); free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_CHANGED_DURING_READ; }
  if (!canonical_path_matches(handles[0], file, path)) { memset(buffer, 0, request->cap + 1); free(buffer); free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_ACCESS_DENIED; }
  for (int i = 0; i < count; ++i) { struct file_identity now; if (!identity(handles[i], &now) || now.id.VolumeSerialNumber != dirs[0].id.VolumeSerialNumber || !same_identity(&dirs[i], &now)) { memset(buffer, 0, request->cap + 1); free(buffer); free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]); return KSR_CHANGED_DURING_READ; } }
  free(path); CloseHandle(file); while (count) CloseHandle(handles[--count]);
  if (!valid_utf8(buffer, read)) { memset(buffer, 0, request->cap + 1); free(buffer); return KSR_CONTENT_NOT_TEXT; }
  *content = buffer; *length = read; return KSR_OK;
}
#else
static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length) { (void)request; (void)content; (void)length; return KSR_UNSUPPORTED_PLATFORM; }
#endif

int main(void) {
  struct request request; unsigned char *content = NULL; uint32_t length = 0; enum ksr_status status = parse_request(&request);
  if (status == KSR_OK) status = secure_read(&request, &content, &length);
  reply(status, content, length);
  if (content != NULL) { memset(content, 0, (size_t)KSR_CAP + 1); free(content); }
  clear_request(&request);
  return 0;
}
