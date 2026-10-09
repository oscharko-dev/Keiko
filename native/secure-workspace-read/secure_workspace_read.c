/* KSR1/KSS1 one-shot helper. It deliberately has no diagnostics or logging. */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <float.h>

_Static_assert(sizeof(double) == 8 && DBL_MANT_DIG == 53 && DBL_MAX_EXP == 1024, "KSS2 requires IEEE-754 binary64");

#define KSR_VERSION 1u
#define KSR_MAX_ROOT 32768u
#define KSR_MAX_PATH 4096u
#define KSR_CAP 1048576u
#define KSR_NATIVE_CAP 67108864u
#define KSR_SAFE_INTEGER 9007199254740991ull
#define KSR_MAX_COMPONENTS 64u
#define KSR_SUPERSCRIPT_ONE_UTF8 "\xC2\xB9"
#define KSR_SUPERSCRIPT_TWO_UTF8 "\xC2\xB2"
#define KSR_SUPERSCRIPT_THREE_UTF8 "\xC2\xB3"

_Static_assert(sizeof(KSR_SUPERSCRIPT_ONE_UTF8) == 3, "superscript one must be two UTF-8 bytes");
_Static_assert(sizeof(KSR_SUPERSCRIPT_TWO_UTF8) == 3, "superscript two must be two UTF-8 bytes");
_Static_assert(sizeof(KSR_SUPERSCRIPT_THREE_UTF8) == 3, "superscript three must be two UTF-8 bytes");

enum ksr_status {
  KSR_OK = 0, KSR_MALFORMED_REQUEST = 1, KSR_UNSUPPORTED_PLATFORM = 2,
  KSR_INVALID_PATH = 3, KSR_ACCESS_DENIED = 4, KSR_NOT_REGULAR = 5,
  KSR_CONTENT_TOO_LARGE = 6, KSR_CONTENT_NOT_TEXT = 7,
  KSR_CHANGED_DURING_READ = 8, KSR_IO_FAILURE = 9, KSR_WRONG_KIND = 10
};

struct request { char *root; char *path; uint32_t cap; uint16_t version; uint16_t operation; uint64_t offset; uint64_t length; };
struct snapshot_info { uint64_t size; double mtime_ms; uint16_t type; };

static uint16_t le16(const unsigned char *p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }
static uint32_t le32(const unsigned char *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static void put16(unsigned char *p, uint16_t n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); }
static void put32(unsigned char *p, uint32_t n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); p[2] = (unsigned char)(n >> 16); p[3] = (unsigned char)(n >> 24); }

static uint64_t le64(const unsigned char *p) { uint64_t value = 0; for (unsigned int i = 0; i < 8; ++i) value |= (uint64_t)p[i] << (8u * i); return value; }

static void put64(unsigned char *p, uint64_t n) { for (unsigned int i = 0; i < 8; ++i) p[i] = (unsigned char)(n >> (8u * i)); }

static int valid_utf8_mode(const unsigned char *s, size_t n, int text) {
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
    if (cp == 0 || (text && (cp == 0x7f || (cp < 0x20 && cp != '\t' && cp != '\n' && cp != '\r') || (cp >= 0x80 && cp <= 0x9f)))) return 0;
  }
  return 1;
}

static int valid_utf8(const unsigned char *s, size_t n) { return valid_utf8_mode(s, n, 1); }

#if defined(_WIN32)
static int ascii_name_equals(const char *value, size_t length, const char *expected) {
  size_t i = 0;
  while (i < length && expected[i] != '\0') { char c = value[i]; if (c >= 'a' && c <= 'z') c = (char)(c - ('a' - 'A')); if (c != expected[i]) return 0; ++i; }
  return i == length && expected[i] == '\0';
}

static int windows_reserved_port_name(const char *name, size_t length) {
  const unsigned char *bytes = (const unsigned char *)name;
  if (length < 4 ||
      (!ascii_name_equals(name, 3, "COM") && !ascii_name_equals(name, 3, "LPT")))
    return 0;
  if (length == 4) return bytes[3] >= '1' && bytes[3] <= '9';
  return length == 5 && bytes[3] == 0xc2 &&
         (bytes[4] == 0xb9 || bytes[4] == 0xb2 || bytes[4] == 0xb3);
}
#endif

static int windows_reserved_component(const char *component, size_t length) {
#if defined(_WIN32)
  size_t name_length = 0;
  while (name_length < length && component[name_length] != '.') ++name_length;
  return ascii_name_equals(component, name_length, "CON") || ascii_name_equals(component, name_length, "PRN") || ascii_name_equals(component, name_length, "AUX") || ascii_name_equals(component, name_length, "NUL") || ascii_name_equals(component, name_length, "CONIN$") || ascii_name_equals(component, name_length, "CONOUT$") || ascii_name_equals(component, name_length, "CLOCK$") || windows_reserved_port_name(component, name_length) || ascii_name_equals(component, name_length, "GLOBALROOT") || ascii_name_equals(component, name_length, "DEVICE") || ascii_name_equals(component, name_length, "??");
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

static void reply(enum ksr_status status, const unsigned char *content, uint32_t length, uint16_t version, const struct snapshot_info *info) {
  unsigned char header[12] = { 'K', 'S', 'S', '1', 0, 0, 0, 0, 0, 0, 0, 0 };
  const int native = version == 3u, rich = version == 2u;
  const int metadata_present = (rich && status == KSR_OK) || (native && (status == KSR_OK || status == KSR_WRONG_KIND));
  const uint32_t metadata_length = native ? 20u : 16u;
  if (status != KSR_OK) { content = NULL; length = 0; }
  unsigned char metadata[20] = {0}; uint64_t mtime_bits = 0;
  if (rich || native) header[3] = native ? '3' : '2';
  if (metadata_present) {
    const unsigned int shift = native ? 4u : 0u;
    if (native) put16(metadata, info->type);
    put64(metadata + shift, info->size); memcpy(&mtime_bits, &info->mtime_ms, sizeof(mtime_bits)); put64(metadata + shift + 8, mtime_bits);
  }
  put16(header + 4, native ? 3u : rich ? 2u : KSR_VERSION); put16(header + 6, (uint16_t)status); put32(header + 8, length + (metadata_present ? metadata_length : 0u));
  (void)fwrite(header, 1, sizeof(header), stdout);
  if (metadata_present) (void)fwrite(metadata, 1, metadata_length, stdout);
  if (content != NULL && length != 0) (void)fwrite(content, 1, length, stdout);
  (void)fflush(stdout);
}

static enum ksr_status parse_request(struct request *out) {
  unsigned char header[36] = {0}; uint32_t root_len, path_len; size_t total;
  memset(out, 0, sizeof(*out)); out->version = KSR_VERSION;
  if (fread(header, 1, 20, stdin) != 20) return KSR_MALFORMED_REQUEST;
  if (memcmp(header, "KSR3", 4) == 0 && le16(header + 4) == 3u) {
    out->version = 3u; out->operation = le16(header + 6);
    if (fread(header + 20, 1, 16, stdin) != 16) return KSR_MALFORMED_REQUEST;
    out->offset = le64(header + 20); out->length = le64(header + 28);
    if (out->operation < 1u || out->operation > 4u || out->length > KSR_NATIVE_CAP || out->offset > KSR_SAFE_INTEGER || out->length > KSR_SAFE_INTEGER - out->offset || (out->operation != 2u && (out->offset != 0 || out->length != 0))) return KSR_MALFORMED_REQUEST;
  } else if (memcmp(header, "KSR2", 4) == 0 && le16(header + 4) == 2u) out->version = 2u;
  else if (memcmp(header, "KSR1", 4) != 0 || le16(header + 4) != KSR_VERSION) return KSR_MALFORMED_REQUEST;
  if (out->version != 3u && le16(header + 6) != 0) return KSR_MALFORMED_REQUEST;
  root_len = le32(header + 8); path_len = le32(header + 12); out->cap = le32(header + 16);
  if (root_len == 0 || root_len > KSR_MAX_ROOT || path_len > KSR_MAX_PATH || (path_len == 0 && out->version != 3u) || out->cap != (out->version == 3u ? KSR_NATIVE_CAP : KSR_CAP)) return KSR_MALFORMED_REQUEST;
  total = (size_t)root_len + (size_t)path_len; out->root = calloc(total + 2, 1);
  if (out->root == NULL) return KSR_IO_FAILURE;
  out->path = out->root + root_len + 1;
  if (fread(out->root, 1, root_len, stdin) != root_len || fread(out->path, 1, path_len, stdin) != path_len || fgetc(stdin) != EOF || memchr(out->root, 0, root_len) || memchr(out->path, 0, path_len) || !valid_utf8_mode((unsigned char *)out->root, root_len, out->version != 3u) || !valid_utf8_mode((unsigned char *)out->path, path_len, out->version != 3u)) return KSR_MALFORMED_REQUEST;
  if (!valid_root(out->root)) return KSR_MALFORMED_REQUEST;
  if (path_len != 0 && !valid_path(out->path)) return KSR_INVALID_PATH;
  return KSR_OK;
}

static void clear_request(struct request *request) {
  if (request->root != NULL) { size_t n = strlen(request->root) + strlen(request->path) + 2; memset(request->root, 0, n); free(request->root); }
}

#if defined(__APPLE__) || defined(__linux__)
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>

#if defined(__APPLE__)
#define KSR_MTIME(value) ((value)->st_mtimespec)
#define KSR_CTIME(value) ((value)->st_ctimespec)
#else
#define KSR_MTIME(value) ((value)->st_mtim)
#define KSR_CTIME(value) ((value)->st_ctim)
#endif

static int same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink && a->st_size == b->st_size && KSR_MTIME(a).tv_sec == KSR_MTIME(b).tv_sec && KSR_MTIME(a).tv_nsec == KSR_MTIME(b).tv_nsec && KSR_CTIME(a).tv_sec == KSR_CTIME(b).tv_sec && KSR_CTIME(a).tv_nsec == KSR_CTIME(b).tv_nsec;
}

#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
/* Test binary only: signal the harness after the final fd baseline, then wait. */
static void pause_after_final_open(void) {
  unsigned char byte = 1;
  if (write(3, &byte, 1) != 1 || read(4, &byte, 1) != 1) _exit(127);
}
#endif

struct rooted_file {
  int fds[KSR_MAX_COMPONENTS + 1], fd, count;
  struct stat dirs[KSR_MAX_COMPONENTS + 1], before;
};

static void close_rooted(struct rooted_file *opened) {
  if (opened->fd >= 0) close(opened->fd);
  while (opened->count) close(opened->fds[--opened->count]);
}

/* Shared rooted acquisition for both unchanged text lanes and private native primitives. */
static enum ksr_status open_rooted(const struct request *request, struct rooted_file *opened, int metadata) {
  char *copy, *part, *next; int fd, flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  memset(opened, 0, sizeof(*opened)); opened->fd = -1;
  fd = open(request->root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return KSR_ACCESS_DENIED;
  opened->fds[opened->count++] = fd;
  if (fstat(fd, &opened->dirs[0]) != 0 || !S_ISDIR(opened->dirs[0].st_mode)) return KSR_ACCESS_DENIED;
  copy = strdup(request->path); if (copy == NULL) return KSR_IO_FAILURE;
  part = copy;
  while ((next = strchr(part, '/')) != NULL) {
    *next++ = '\0'; fd = openat(opened->fds[opened->count - 1], part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) { free(copy); return KSR_ACCESS_DENIED; }
    if (fstat(fd, &opened->dirs[opened->count]) != 0 || !S_ISDIR(opened->dirs[opened->count].st_mode) || opened->dirs[opened->count].st_dev != opened->dirs[0].st_dev) { close(fd); free(copy); return KSR_ACCESS_DENIED; }
    opened->fds[opened->count++] = fd; part = next;
  }
  if (metadata) {
#if defined(__linux__)
    flags = O_PATH | O_CLOEXEC | O_NOFOLLOW;
#else
    /* O_SYMLINK opens the link itself; combining O_NOFOLLOW fails with ELOOP on macOS. */
    flags = O_RDONLY | O_CLOEXEC | O_SYMLINK | O_NONBLOCK;
#endif
  }
  if (*part == '\0' && !(request->version == 3u && request->path[0] == '\0')) { free(copy); return KSR_INVALID_PATH; }
  opened->fd = openat(opened->fds[opened->count - 1], *part == '\0' ? "." : part, flags); free(copy);
  if (opened->fd < 0) return KSR_ACCESS_DENIED;
  if (fstat(opened->fd, &opened->before) != 0) return KSR_IO_FAILURE;
  if (opened->before.st_nlink == 0) return KSR_CHANGED_DURING_READ;
  if (opened->before.st_dev != opened->dirs[0].st_dev || opened->before.st_size < 0 || (S_ISREG(opened->before.st_mode) && opened->before.st_nlink != 1)) return KSR_NOT_REGULAR;
  return KSR_OK;
}

static int rooted_current(struct rooted_file *opened, struct stat *after) {
  if (fstat(opened->fd, after) != 0 || !same_identity(&opened->before, after)) return 0;
  for (int i = 0; i < opened->count; ++i) {
    struct stat now; if (fstat(opened->fds[i], &now) != 0 || !same_identity(&opened->dirs[i], &now)) return 0;
  }
  return 1;
}

static uint16_t native_kind(mode_t mode) {
  return S_ISREG(mode) ? 1u : S_ISDIR(mode) ? 2u : S_ISLNK(mode) ? 3u : 4u;
}

static int native_info(const struct stat *value, struct snapshot_info *info) {
  if (value->st_size < 0 || (uintmax_t)value->st_size > KSR_SAFE_INTEGER) return 0;
  info->type = native_kind(value->st_mode); info->size = (uint64_t)value->st_size;
  info->mtime_ms = (double)KSR_MTIME(value).tv_sec * 1000.0 + (double)KSR_MTIME(value).tv_nsec / 1000000.0;
  return isfinite(info->mtime_ms);
}

static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length, struct snapshot_info *info) {
  struct rooted_file opened; struct stat after; size_t got = 0, capacity; ssize_t chunk; unsigned char *buffer;
  enum ksr_status status = open_rooted(request, &opened, 0); *content = NULL; *length = 0;
  if (status != KSR_OK) { close_rooted(&opened); return status; }
  if (!S_ISREG(opened.before.st_mode)) { close_rooted(&opened); return KSR_NOT_REGULAR; }
  if ((uintmax_t)opened.before.st_size > request->cap) { close_rooted(&opened); return KSR_CONTENT_TOO_LARGE; }
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
  pause_after_final_open();
#endif
  capacity = (size_t)opened.before.st_size + 1; buffer = calloc(capacity, 1);
  if (buffer == NULL) { close_rooted(&opened); return KSR_IO_FAILURE; }
  while (got < capacity) {
    chunk = read(opened.fd, buffer + got, capacity - got);
    if (chunk < 0 && errno == EINTR) continue;
    if (chunk < 0) { status = KSR_IO_FAILURE; break; }
    if (chunk == 0) break;
    got += (size_t)chunk;
  }
  if (status == KSR_OK && got > request->cap) status = KSR_CONTENT_TOO_LARGE;
  if (status == KSR_OK && (!rooted_current(&opened, &after) || got != (size_t)opened.before.st_size)) status = KSR_CHANGED_DURING_READ;
  if (status == KSR_OK && !valid_utf8(buffer, got)) status = KSR_CONTENT_NOT_TEXT;
  if (status == KSR_OK && !native_info(&after, info)) status = KSR_IO_FAILURE;
  close_rooted(&opened);
  if (status != KSR_OK) { memset(buffer, 0, capacity); free(buffer); return status; }
  *content = buffer; *length = (uint32_t)got; return KSR_OK;
}

static enum ksr_status native_bytes(const struct request *request, struct rooted_file *opened, unsigned char **content, uint32_t *length) {
  const uint64_t size = (uint64_t)opened->before.st_size;
  const uint64_t offset = request->operation == 2u ? request->offset : 0;
  const uint64_t available = offset >= size ? 0 : size - offset;
  const uint64_t wanted = request->operation == 2u && request->length < available ? request->length : available;
  if (wanted > request->cap) return KSR_CONTENT_TOO_LARGE;
  unsigned char *buffer = calloc((size_t)wanted + 1, 1); size_t got = 0;
  if (buffer == NULL) return KSR_IO_FAILURE;
  while (got < wanted) {
    ssize_t chunk = pread(opened->fd, buffer + got, (size_t)wanted - got, (off_t)(offset + got));
    if (chunk < 0 && errno == EINTR) continue;
    if (chunk <= 0) { memset(buffer, 0, (size_t)wanted + 1); free(buffer); return chunk < 0 ? KSR_IO_FAILURE : KSR_CHANGED_DURING_READ; }
    got += (size_t)chunk;
  }
  *content = buffer; *length = (uint32_t)got; return KSR_OK;
}

static enum ksr_status append_native_entry(unsigned char **buffer, uint32_t *length, size_t *capacity, const char *name, uint16_t type, uint32_t cap) {
  const size_t size = strlen(name), required = (size_t)*length + size + 5u;
  if (!valid_utf8_mode((const unsigned char *)name, size, 0)) return KSR_INVALID_PATH;
  if (required > cap) return KSR_CONTENT_TOO_LARGE;
  if (required >= *capacity) {
    size_t next = *capacity * 2u; if (next <= required) next = required + 1u;
    if (next > (size_t)cap + 1u) next = (size_t)cap + 1u;
    unsigned char *grown = realloc(*buffer, next); if (grown == NULL) return KSR_IO_FAILURE;
    *buffer = grown; *capacity = next;
  }
  (*buffer)[*length] = (unsigned char)type; put32(*buffer + *length + 1, (uint32_t)size);
  memcpy(*buffer + *length + 5, name, size); *length = (uint32_t)required; return KSR_OK;
}

static enum ksr_status native_list(const struct request *request, struct rooted_file *opened, unsigned char **content, uint32_t *length) {
  int copy = dup(opened->fd); if (copy < 0) return KSR_IO_FAILURE;
  DIR *directory = fdopendir(copy); if (directory == NULL) { close(copy); return KSR_IO_FAILURE; }
  size_t capacity = 256; unsigned char *buffer = calloc(capacity, 1); uint32_t count = 0;
  enum ksr_status status = buffer == NULL ? KSR_IO_FAILURE : KSR_OK; *length = 4;
  while (status == KSR_OK) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (entry == NULL) { if (errno != 0) status = KSR_IO_FAILURE; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat info;
    if (fstatat(opened->fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) { status = KSR_CHANGED_DURING_READ; break; }
    status = append_native_entry(&buffer, length, &capacity, entry->d_name, native_kind(info.st_mode), request->cap);
    if (status == KSR_OK) count++;
  }
  closedir(directory);
  if (status != KSR_OK) { if (buffer != NULL) { memset(buffer, 0, capacity); free(buffer); } *length = 0; return status; }
  put32(buffer, count); *content = buffer; return KSR_OK;
}

static enum ksr_status secure_native(const struct request *request, unsigned char **content, uint32_t *length, struct snapshot_info *info) {
  struct rooted_file opened; struct stat after; enum ksr_status status = open_rooted(request, &opened, request->operation == 3u);
  *content = NULL; *length = 0;
  if (status != KSR_OK) { close_rooted(&opened); return status; }
  if (!native_info(&opened.before, info)) { close_rooted(&opened); return KSR_IO_FAILURE; }
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
  pause_after_final_open();
#endif
  if ((request->operation < 3u && info->type != 1u) || (request->operation == 4u && info->type != 2u)) status = KSR_WRONG_KIND;
  else if (request->operation < 3u) status = native_bytes(request, &opened, content, length);
  else if (request->operation == 4u) status = native_list(request, &opened, content, length);
  if ((status == KSR_OK || status == KSR_WRONG_KIND) && !rooted_current(&opened, &after)) status = KSR_CHANGED_DURING_READ;
  if ((status == KSR_OK || status == KSR_WRONG_KIND) && !native_info(&after, info)) status = KSR_IO_FAILURE;
  close_rooted(&opened);
  if (status != KSR_OK && *content != NULL) { memset(*content, 0, (size_t)*length + 1); free(*content); *content = NULL; *length = 0; }
  return status;
}
#elif defined(_WIN32)
#include <windows.h>
#include <winternl.h>
#include <fcntl.h>
#include <io.h>
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
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

static int binary_standard_io(void) {
  return _setmode(_fileno(stdin), _O_BINARY) != -1 && _setmode(_fileno(stdout), _O_BINARY) != -1;
}

#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
/* Test binary only: Node maps its extra stdio pipes to CRT descriptors 3 and 4. */
static void pause_after_final_open(void) {
  unsigned char byte = 1;
  if (_write(3, &byte, 1) != 1 || _read(4, &byte, 1) != 1) _exit(127);
}
#endif

static int canonical_path_matches_resolved(HANDLE root, HANDLE file, const wchar_t *requested, wchar_t *root_path, wchar_t *file_path, wchar_t *expected) {
  DWORD root_length, file_length; size_t expected_length, prefix_length; const wchar_t *suffix;
  root_length = GetFinalPathNameByHandleW(root, root_path, (DWORD)(KSR_MAX_ROOT + 8u), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  file_length = GetFinalPathNameByHandleW(file, file_path, (DWORD)(KSR_MAX_ROOT + KSR_MAX_PATH + 8u), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (root_length == 0 || root_length >= KSR_MAX_ROOT + 8u || file_length == 0 || file_length >= KSR_MAX_ROOT + KSR_MAX_PATH + 8u) return 0;
  prefix_length = (size_t)root_length;
  if (_wcsnicmp(root_path, file_path, prefix_length) != 0) return 0;
  if (root_path[prefix_length - 1] == L'\\') suffix = file_path + prefix_length;
  else { if (file_path[prefix_length] != L'\\') return 0; suffix = file_path + prefix_length + 1; }
  expected_length = wcslen(requested);
  if (expected_length == 0 || expected_length > KSR_MAX_PATH) return 0;
  for (size_t i = 0; i <= expected_length; ++i) expected[i] = requested[i] == L'/' ? L'\\' : requested[i];
  return _wcsicmp(suffix, expected) == 0;
}

/* Canonical-path buffers live on the heap: the three wide-path scratch areas total ~144 KiB,
 * which overflows analyzer stack budgets (MSVC C6262). Allocation failure denies the match. */
static int canonical_path_matches(HANDLE root, HANDLE file, const wchar_t *requested) {
  wchar_t *root_path = calloc(KSR_MAX_ROOT + 8u, sizeof(*root_path));
  wchar_t *file_path = calloc(KSR_MAX_ROOT + KSR_MAX_PATH + 8u, sizeof(*file_path));
  wchar_t *expected = calloc(KSR_MAX_PATH + 1u, sizeof(*expected));
  int matches = root_path != NULL && file_path != NULL && expected != NULL &&
    canonical_path_matches_resolved(root, file, requested, root_path, file_path, expected);
  free(root_path); free(file_path); free(expected);
  return matches;
}

static HANDLE open_component(nt_create_file_fn nt_create, HANDLE parent, const wchar_t *name, USHORT length, int directory) {
  UNICODE_STRING u; OBJECT_ATTRIBUTES attributes; IO_STATUS_BLOCK ios; HANDLE handle = INVALID_HANDLE_VALUE; NTSTATUS status;
  u.Buffer = (PWSTR)name; u.Length = length; u.MaximumLength = length;
  InitializeObjectAttributes(&attributes, &u, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, parent, NULL);
  status = nt_create(&handle, (directory ? FILE_TRAVERSE : FILE_READ_DATA) | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes, &ios, NULL, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), NULL, 0);
  /* Normalize a null handle to the invalid sentinel so callers hold a single failure shape. */
  return status < 0 || handle == NULL ? INVALID_HANDLE_VALUE : handle;
}

/* Forward index closes keep the analyzer's bounds proof trivial (no decrement indexing). */
static void close_handles(HANDLE *handles, int count) {
  for (int i = 0; i < count; ++i) CloseHandle(handles[i]);
}

static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length, struct snapshot_info *info) {
  wchar_t *root = NULL, *path = NULL, *cursor, *slash; HANDLE handles[KSR_MAX_COMPONENTS + 1], file = INVALID_HANDLE_VALUE; int count = 0; DWORD chunk = 0, read = 0, capacity = 0; struct file_identity dirs[KSR_MAX_COMPONENTS + 1], before, after; unsigned char *buffer = NULL; nt_create_file_fn nt_create; HMODULE ntdll;
  *content = NULL; *length = 0;
  root = calloc(KSR_MAX_ROOT + 1, sizeof(*root)); path = calloc(KSR_MAX_PATH + 1, sizeof(*path));
  if (root == NULL || path == NULL || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, request->root, -1, root, KSR_MAX_ROOT) == 0 || MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, request->path, -1, path, KSR_MAX_PATH) == 0) { free(root); free(path); return KSR_IO_FAILURE; }
  ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_create = ntdll == NULL ? NULL : (nt_create_file_fn)GetProcAddress(ntdll, "NtCreateFile");
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
    if (file == NULL) file = INVALID_HANDLE_VALUE;
    if (file == INVALID_HANDLE_VALUE || is_reparse(file)) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); free(path); close_handles(handles, count); return KSR_ACCESS_DENIED; }
    /* parse_request already bounds components; keep the array-capacity proof local as well. */
    if (count >= (int)(KSR_MAX_COMPONENTS + 1u) || !identity(file, &dirs[count])) { CloseHandle(file); free(path); close_handles(handles, count); return KSR_ACCESS_DENIED; }
    handles[count++] = file; cursor = slash + 1;
  }
  file = open_component(nt_create, handles[count - 1], cursor, (USHORT)(wcslen(cursor) * sizeof(*cursor)), 0);
  if (file == NULL) file = INVALID_HANDLE_VALUE;
  if (file == INVALID_HANDLE_VALUE || is_reparse(file)) { if (file != INVALID_HANDLE_VALUE) CloseHandle(file); free(path); close_handles(handles, count); return KSR_ACCESS_DENIED; }
  if (GetFileType(file) != FILE_TYPE_DISK || !identity(file, &before) || before.id.VolumeSerialNumber != dirs[0].id.VolumeSerialNumber || before.standard.NumberOfLinks != 1 || before.standard.EndOfFile.QuadPart < 0) { free(path); CloseHandle(file); close_handles(handles, count); return KSR_NOT_REGULAR; }
  if ((uint64_t)before.standard.EndOfFile.QuadPart > request->cap) { free(path); CloseHandle(file); close_handles(handles, count); return KSR_CONTENT_TOO_LARGE; }
#if defined(KSR_TEST_PAUSE_AFTER_FINAL_OPEN)
  pause_after_final_open();
#endif
  capacity = (DWORD)before.standard.EndOfFile.QuadPart + 1;
  buffer = calloc(capacity, 1); if (buffer == NULL) { free(path); CloseHandle(file); close_handles(handles, count); return KSR_IO_FAILURE; }
  while (read < capacity) {
    if (!ReadFile(file, buffer + read, capacity - read, &chunk, NULL)) { memset(buffer, 0, capacity); free(buffer); free(path); CloseHandle(file); close_handles(handles, count); return KSR_IO_FAILURE; }
    if (chunk == 0) break;
    read += chunk;
  }
  if (read > request->cap) { memset(buffer, 0, capacity); free(buffer); free(path); CloseHandle(file); close_handles(handles, count); return KSR_CONTENT_TOO_LARGE; }
  if (!identity(file, &after) || !same_identity(&before, &after) || read != (DWORD)before.standard.EndOfFile.QuadPart) { memset(buffer, 0, capacity); free(buffer); free(path); CloseHandle(file); close_handles(handles, count); return KSR_CHANGED_DURING_READ; }
  if (!canonical_path_matches(handles[0], file, path)) { memset(buffer, 0, capacity); free(buffer); free(path); CloseHandle(file); close_handles(handles, count); return KSR_ACCESS_DENIED; }
  for (int i = 0; i < count; ++i) { struct file_identity now; if (!identity(handles[i], &now) || now.id.VolumeSerialNumber != dirs[0].id.VolumeSerialNumber || !same_identity(&dirs[i], &now)) { memset(buffer, 0, capacity); free(buffer); free(path); CloseHandle(file); close_handles(handles, count); return KSR_CHANGED_DURING_READ; } }
  free(path); CloseHandle(file); close_handles(handles, count);
  if (!valid_utf8(buffer, read)) { memset(buffer, 0, capacity); free(buffer); return KSR_CONTENT_NOT_TEXT; }
  info->size = (uint64_t)after.standard.EndOfFile.QuadPart;
  info->mtime_ms = (double)(after.basic.LastWriteTime.QuadPart / 10000) - 11644473600000.0 + (double)(after.basic.LastWriteTime.QuadPart % 10000) / 10000.0;
  if (!isfinite(info->mtime_ms)) { memset(buffer, 0, capacity); free(buffer); return KSR_IO_FAILURE; }
  *content = buffer; *length = read; return KSR_OK;
}
#else
static enum ksr_status secure_read(const struct request *request, unsigned char **content, uint32_t *length, struct snapshot_info *info) { (void)request; (void)content; (void)length; (void)info; return KSR_UNSUPPORTED_PLATFORM; }
#endif

#if !defined(__APPLE__) && !defined(__linux__)
static enum ksr_status secure_native(const struct request *request, unsigned char **content, uint32_t *length, struct snapshot_info *info) { (void)request; (void)content; (void)length; (void)info; return KSR_UNSUPPORTED_PLATFORM; }
#endif

int main(void) {
#if defined(_WIN32)
  /* /MT and /DEPENDENTLOADFLAG:0x800 protect implicit imports before main. This rejects a host
   * that cannot close the search path for any later dynamic dependency. */
  if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) || !SetDllDirectoryW(L"")) return 1;
  if (!binary_standard_io()) return 1;
#endif
  struct request request; struct snapshot_info info = {0}; unsigned char *content = NULL; uint32_t length = 0; enum ksr_status status = parse_request(&request);
  if (status == KSR_OK) status = request.version == 3u ? secure_native(&request, &content, &length, &info) : secure_read(&request, &content, &length, &info);
  reply(status, content, length, request.version, &info);
  if (content != NULL) { memset(content, 0, (size_t)length + 1); free(content); }
  clear_request(&request);
  return 0;
}
