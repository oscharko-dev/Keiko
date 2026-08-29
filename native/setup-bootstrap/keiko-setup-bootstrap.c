// Keiko Windows setup bootstrap (issue #2992).
//
// This is the promoted `keiko-windows-x64-setup.exe`. It replaces the previous IExpress/WExtract
// self-extractor, whose documented `/C:<command>` switch let a caller substitute the embedded
// install command and thereby front arbitrary local code under the Keiko Authenticode signature
// (a signature-laundering / LOLBin primitive). No SED field could disable that switch, so the
// construction surface is replaced entirely by this Keiko-authored native console program.
//
// SECURITY INVARIANTS — the entire reason this file exists (keep them true):
//   1. NO COMMAND SURFACE. The argument grammar is a CLOSED ALLOWLIST: either no arguments, or
//      every argument is `/quiet` or `/Q` (case-insensitive). Any other argument — a `/C:<command>`
//      override included — is rejected with exit code 87 BEFORE any staging directory, extraction,
//      or child process. This is an allowlist, never a denylist of known-bad switches, so an
//      unforeseen future switch cannot regress it.
//   2. A FIXED, VERIFIED EXECUTION SET. The only programs this bootstrap will ever run are
//      `System32\tar.exe` (resolved from GetSystemDirectoryW, never from PATH or the CWD) and the
//      bundled `node.exe` from the extracted payload — and only after the payload's SHA-256 matches
//      the digest baked into this (signed) binary at build time.
//   3. TAMPER-EVIDENT PAYLOAD. The expected payload digest and size are compile-time constants,
//      re-verified at run time by streaming the appended overlay through BCrypt SHA-256. The release
//      pipeline appends the overlay and signs the resulting file afterwards, so the payload IS
//      covered by the Authenticode signature (the digest spans the whole file except the checksum,
//      the certificate-table directory entry, and the certificate table itself). The baked digest is
//      not a substitute for that signature — it is what still holds when nothing verified it, since
//      Windows will happily execute an unsigned or invalidly-signed binary. Verified bytes and
//      EXECUTED bytes are not identical: the staged ZIP is re-verified and held write-/delete-denied
//      across extraction, but the unpacked files are only checked for existence before launch. That
//      residual is recorded in ADR-0121; it needs a process already running as this same user, and
//      the staging directory carries 128 CSPRNG bits.
//
// Exit-code contract (stable; the Windows smoke and the reproduction runbook depend on it):
//   0  success
//   11 self-open / PE-parse failure (cannot locate the overlay in the running image)
//   12 integrity failure (overlay header, payload size, or payload digest does not match baked)
//   13 staging failure (temp directory or payload extraction-copy could not be created)
//   14 extraction failure (System32 tar.exe did not unpack the payload)
//   15 payload-contents failure (the unpacked tree is missing Keiko.exe/node.exe/the CLI)
//   16 resolve-root failure (the portable CLI did not return a usable managed-root path)
//   17 setup failure (the governed `portable setup` step failed)
//   18 launch failure (the governed `portable launch` step reported the app unhealthy)
//   19 cleanup failure (the temporary staging tree could not be removed after a healthy launch)
//   87 unsupported argument (ERROR_INVALID_PARAMETER) — the argument allowlist rejected an input

#if !defined(_WIN32)
#error "keiko-setup-bootstrap.c targets Windows only"
#endif

#if !defined(KEIKO_SETUP_PAYLOAD_SHA256_HEX) || !defined(KEIKO_SETUP_PAYLOAD_SIZE_BYTES) || \
    !defined(KEIKO_SETUP_TARGET)
#error "the build must define KEIKO_SETUP_PAYLOAD_SHA256_HEX, KEIKO_SETUP_PAYLOAD_SIZE_BYTES and KEIKO_SETUP_TARGET"
#endif

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN

#include <windows.h>

#include <bcrypt.h>
#include <conio.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <wctype.h>

#if defined(_MSC_VER)
// BCrypt (payload hashing + CSPRNG) lives in bcrypt.lib; neither cl invocation links it by default.
#pragma comment(lib, "bcrypt.lib")
#endif

#define KEIKO_WIDEN2(value) L##value
#define KEIKO_WIDEN(value) KEIKO_WIDEN2(value)

enum {
  KEIKO_EXIT_OK = 0,
  KEIKO_EXIT_SELF_PARSE = 11,
  KEIKO_EXIT_INTEGRITY = 12,
  KEIKO_EXIT_STAGING = 13,
  KEIKO_EXIT_EXTRACTION = 14,
  KEIKO_EXIT_PAYLOAD_CONTENTS = 15,
  KEIKO_EXIT_RESOLVE_ROOT = 16,
  KEIKO_EXIT_SETUP = 17,
  KEIKO_EXIT_LAUNCH = 18,
  KEIKO_EXIT_CLEANUP = 19,
  KEIKO_EXIT_BAD_ARGUMENT = 87
};

enum {
  KEIKO_PATH_CAP = 32768,
  KEIKO_COMMAND_CAP = 98304,
  KEIKO_SHA256_BYTES = 32,
  KEIKO_SHA256_HEX_CHARS = 64,
  KEIKO_OVERLAY_HEADER_BYTES = 64,
  KEIKO_HEADER_SCAN_BYTES = 1048576, // 1 MiB window: covers any real PE's headers + section table
  KEIKO_HASH_CHUNK_BYTES = 1048576,  // 1 MiB streamed hash/copy chunk
  KEIKO_RESOLVE_OUTPUT_CAP = 65536,  // <= 64 KiB captured from `portable resolve-root` stdout
  KEIKO_MAX_TRAILING_PADDING = 7,    // signing may 8-byte-align the certificate table it appends
  KEIKO_CHILD_TIMEOUT_MS = 1200000,  // 20 min watchdog: far above any real step, bounds a hang
  KEIKO_DRAIN_POLL_MS = 50,          // slice the capture loop sleeps on the child handle per turn
  KEIKO_CHILD_EXIT_GRACE_MS = 5000   // how long a child gets to exit once its stdout has closed
};

// ---------------------------------------------------------------------------------------------
// Overlay + PE constants. Every offset below is the frozen SPEC v1 section 1 / Microsoft PE-COFF
// layout that scripts/lib/portable-setup-overlay.mjs writes; the two parsers MUST stay bit-for-bit
// compatible.
// ---------------------------------------------------------------------------------------------

static const unsigned char KEIKO_OVERLAY_MAGIC[8] = {'K', 'S', 'E', 'T', 'U', 'P', '0', '1'};

enum {
  OVERLAY_MAGIC_BYTES = 8,
  OVERLAY_SIZE_OFFSET = 8,
  OVERLAY_DIGEST_OFFSET = 16,
  OVERLAY_RESERVED_OFFSET = 48,

  DOS_E_LFANEW_OFFSET = 0x3c,
  DOS_HEADER_MIN_BYTES = DOS_E_LFANEW_OFFSET + 4,
  PE_SIGNATURE_BYTES = 4,
  COFF_HEADER_BYTES = 20,
  COFF_NUMBER_OF_SECTIONS_OFFSET = 2,
  COFF_SIZE_OF_OPTIONAL_HEADER_OFFSET = 16,
  OPTIONAL_HEADER_MAGIC_PE32 = 0x10b,
  OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b,
  OPTIONAL_HEADER_SIZE_OF_HEADERS_OFFSET = 60,
  OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET = 112,
  DATA_DIRECTORY_ENTRY_BYTES = 8,
  KEIKO_SECURITY_DIR_INDEX = 4,
  SECTION_HEADER_BYTES = 40,
  SECTION_SIZE_OF_RAW_DATA_OFFSET = 16,
  SECTION_POINTER_TO_RAW_DATA_OFFSET = 20
};

static const unsigned char KEIKO_PE_SIGNATURE[PE_SIGNATURE_BYTES] = {'P', 'E', 0x00, 0x00};
// The fixed PE32+ optional-header fields (112) plus the first five 8-byte data-directory slots
// (indices 0..4, so the Security directory at index 4 is physically present).
#define OPTIONAL_HEADER_MIN_BYTES_FOR_SECURITY_DIRECTORY \
  (OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET + (KEIKO_SECURITY_DIR_INDEX + 1) * DATA_DIRECTORY_ENTRY_BYTES)

typedef struct {
  uint64_t overlay_start;
  uint64_t overlay_end;
} keiko_overlay_bounds;

// ---------------------------------------------------------------------------------------------
// Pure, bounds-checked little-endian readers. Every caller passes the buffer length; a read that
// would run past it returns 0 (a parse rejection), never undefined behaviour. Offsets are compared
// as `available < needed` to avoid any addition that could wrap.
// ---------------------------------------------------------------------------------------------

static int keiko_read_u16(const unsigned char *buf, size_t len, size_t off, uint16_t *out) {
  if (off > len || len - off < (size_t)2) {
    return 0;
  }
  *out = (uint16_t)((uint16_t)buf[off] | (uint16_t)((uint16_t)buf[off + 1] << 8));
  return 1;
}

static int keiko_read_u32(const unsigned char *buf, size_t len, size_t off, uint32_t *out) {
  if (off > len || len - off < (size_t)4) {
    return 0;
  }
  *out = (uint32_t)buf[off] | ((uint32_t)buf[off + 1] << 8) | ((uint32_t)buf[off + 2] << 16) |
         ((uint32_t)buf[off + 3] << 24);
  return 1;
}

static int keiko_read_u64(const unsigned char *buf, size_t len, size_t off, uint64_t *out) {
  if (off > len || len - off < (size_t)8) {
    return 0;
  }
  uint64_t value = 0;
  for (size_t index = 0; index < (size_t)8; index++) {
    value |= (uint64_t)buf[off + index] << (8 * index);
  }
  *out = value;
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Argument allowlist (security invariant 1).
// ---------------------------------------------------------------------------------------------

// A single argument is accepted only when it is exactly `/quiet` or `/Q`, case-insensitively.
static int keiko_argument_allowed(const wchar_t *arg) {
  return _wcsicmp(arg, L"/quiet") == 0 || _wcsicmp(arg, L"/Q") == 0;
}

// Scans the whole argument vector. Returns 1 when argv[1..argc-1] are all accepted (and sets
// *out_quiet to whether any quiet flag was present); returns 0 and points *out_bad at the first
// rejected argument otherwise. argv[0] (the program path) is never inspected.
// Reports the 1-based POSITION of the first rejected argument, never a pointer to its text: the
// value may carry a credential, a customer path, an endpoint, PII, or a whole legacy `/C:` payload,
// and the diagnostic built from it lands in terminal transcripts and in the installation logs that
// /quiet deployment systems retain. A position is enough to locate the argument in the caller's own
// command line and is body-free (AGENTS.md §8). `*out_bad_index` is 0 when every argument passed.
static int keiko_scan_arguments(int argc, wchar_t **argv, int *out_quiet, int *out_bad_index) {
  *out_quiet = 0;
  *out_bad_index = 0;
  for (int index = 1; index < argc; index++) {
    if (!keiko_argument_allowed(argv[index])) {
      *out_bad_index = index;
      return 0;
    }
    *out_quiet = 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------------------------
// PE32+ overlay location (frozen SPEC v1 section 1; mirror of portable-setup-overlay.mjs).
// `scan`/`scan_len` are a prefix of the file large enough to hold every header and the section
// table; `file_size` is the true size of the whole file (used for overlay_end when the image
// carries no certificate table). Returns 1 on success.
// ---------------------------------------------------------------------------------------------

static int keiko_section_overlay_start(const unsigned char *scan, size_t scan_len,
                                       size_t section_table_offset, uint16_t number_of_sections,
                                       uint32_t size_of_headers, uint64_t *out_start) {
  uint64_t overlay_start = size_of_headers;
  for (uint16_t index = 0; index < number_of_sections; index++) {
    size_t section_offset = section_table_offset + (size_t)index * SECTION_HEADER_BYTES;
    uint32_t size_of_raw_data = 0;
    uint32_t pointer_to_raw_data = 0;
    if (!keiko_read_u32(scan, scan_len, section_offset + SECTION_SIZE_OF_RAW_DATA_OFFSET,
                        &size_of_raw_data) ||
        !keiko_read_u32(scan, scan_len, section_offset + SECTION_POINTER_TO_RAW_DATA_OFFSET,
                        &pointer_to_raw_data)) {
      return 0;
    }
    uint64_t section_end = (uint64_t)pointer_to_raw_data + (uint64_t)size_of_raw_data;
    if (section_end > overlay_start) {
      overlay_start = section_end;
    }
  }
  *out_start = overlay_start;
  return 1;
}

static int keiko_parse_overlay_bounds(const unsigned char *scan, size_t scan_len, uint64_t file_size,
                                      keiko_overlay_bounds *out) {
  if (scan_len < DOS_HEADER_MIN_BYTES || scan[0] != 'M' || scan[1] != 'Z') {
    return 0;
  }
  uint32_t pe_offset = 0;
  if (!keiko_read_u32(scan, scan_len, DOS_E_LFANEW_OFFSET, &pe_offset)) {
    return 0;
  }
  if ((size_t)pe_offset > scan_len ||
      scan_len - (size_t)pe_offset < (size_t)(PE_SIGNATURE_BYTES + COFF_HEADER_BYTES) ||
      memcmp(scan + pe_offset, KEIKO_PE_SIGNATURE, PE_SIGNATURE_BYTES) != 0) {
    return 0;
  }
  size_t coff_offset = (size_t)pe_offset + PE_SIGNATURE_BYTES;
  uint16_t number_of_sections = 0;
  uint16_t size_of_optional_header = 0;
  if (!keiko_read_u16(scan, scan_len, coff_offset + COFF_NUMBER_OF_SECTIONS_OFFSET, &number_of_sections) ||
      !keiko_read_u16(scan, scan_len, coff_offset + COFF_SIZE_OF_OPTIONAL_HEADER_OFFSET,
                      &size_of_optional_header)) {
    return 0;
  }
  size_t optional_header_offset = coff_offset + COFF_HEADER_BYTES;
  uint16_t magic = 0;
  if (!keiko_read_u16(scan, scan_len, optional_header_offset, &magic) ||
      magic != OPTIONAL_HEADER_MAGIC_PE32_PLUS ||
      size_of_optional_header < OPTIONAL_HEADER_MIN_BYTES_FOR_SECURITY_DIRECTORY) {
    return 0;
  }
  uint32_t size_of_headers = 0;
  uint32_t certificate_offset = 0;
  uint32_t certificate_size = 0;
  size_t directory_offset = optional_header_offset + OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET +
                            (size_t)KEIKO_SECURITY_DIR_INDEX * DATA_DIRECTORY_ENTRY_BYTES;
  if (!keiko_read_u32(scan, scan_len, optional_header_offset + OPTIONAL_HEADER_SIZE_OF_HEADERS_OFFSET,
                      &size_of_headers) ||
      !keiko_read_u32(scan, scan_len, directory_offset, &certificate_offset) ||
      !keiko_read_u32(scan, scan_len, directory_offset + 4, &certificate_size)) {
    return 0;
  }
  uint64_t overlay_start = 0;
  if (!keiko_section_overlay_start(scan, scan_len, optional_header_offset + size_of_optional_header,
                                   number_of_sections, size_of_headers, &overlay_start)) {
    return 0;
  }
  if (overlay_start > file_size) {
    return 0;
  }
  uint64_t overlay_end = file_size;
  if (certificate_size != 0) {
    if ((uint64_t)certificate_offset < overlay_start || (uint64_t)certificate_offset > file_size) {
      return 0;
    }
    overlay_end = certificate_offset;
  }
  out->overlay_start = overlay_start;
  out->overlay_end = overlay_end;
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Overlay header validation + hex helpers.
// ---------------------------------------------------------------------------------------------

static void keiko_bytes_to_hex(const unsigned char *bytes, size_t count, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < count; index++) {
    out[index * 2] = digits[(bytes[index] >> 4) & 0x0f];
    out[index * 2 + 1] = digits[bytes[index] & 0x0f];
  }
  out[count * 2] = '\0';
}

// Case-insensitive compare of two NUL-terminated 64-character hex strings.
static int keiko_hex_equal(const char *a, const char *b) {
  for (size_t index = 0; index < (size_t)KEIKO_SHA256_HEX_CHARS; index++) {
    unsigned char left = (unsigned char)a[index];
    unsigned char right = (unsigned char)b[index];
    if (left >= 'A' && left <= 'F') {
      left = (unsigned char)(left + ('a' - 'A'));
    }
    if (right >= 'A' && right <= 'F') {
      right = (unsigned char)(right + ('a' - 'A'));
    }
    if (left != right || left == '\0') {
      return 0;
    }
  }
  return a[KEIKO_SHA256_HEX_CHARS] == '\0' && b[KEIKO_SHA256_HEX_CHARS] == '\0';
}

// Validates the 64-byte overlay header: magic, reserved-zero, and returns the declared payload size
// and the declared digest as lowercase hex. Returns 1 on success.
static int keiko_validate_overlay_header(const unsigned char *header, uint64_t *out_payload_size,
                                         char *out_hex) {
  if (memcmp(header, KEIKO_OVERLAY_MAGIC, OVERLAY_MAGIC_BYTES) != 0) {
    return 0;
  }
  for (size_t index = (size_t)OVERLAY_RESERVED_OFFSET; index < (size_t)KEIKO_OVERLAY_HEADER_BYTES;
       index++) {
    if (header[index] != 0) {
      return 0;
    }
  }
  uint64_t payload_size = 0;
  if (!keiko_read_u64(header, KEIKO_OVERLAY_HEADER_BYTES, OVERLAY_SIZE_OFFSET, &payload_size)) {
    return 0;
  }
  *out_payload_size = payload_size;
  keiko_bytes_to_hex(header + OVERLAY_DIGEST_OFFSET, KEIKO_SHA256_BYTES, out_hex);
  return 1;
}

static int keiko_all_zero(const unsigned char *buffer, size_t length) {
  for (size_t index = 0; index < length; index++) {
    if (buffer[index] != 0) {
      return 0;
    }
  }
  return 1;
}

// Pure: given the located overlay bounds and the header's declared payload size, checks that the
// payload physically fits before the overlay end with only the <=7 trailing bytes signing may add
// for 8-byte certificate-table alignment. Overflow-guarded so a hostile header size cannot wrap the
// arithmetic. Returns 1 and reports the payload start + padding length on success.
static int keiko_payload_region(uint64_t overlay_start, uint64_t overlay_end, uint64_t payload_size,
                                uint64_t *out_payload_start, uint64_t *out_padding) {
  uint64_t payload_start = overlay_start + KEIKO_OVERLAY_HEADER_BYTES;
  if (payload_start < overlay_start) {
    return 0;
  }
  uint64_t payload_end = payload_start + payload_size;
  if (payload_end < payload_start || payload_end > overlay_end) {
    return 0;
  }
  uint64_t padding = overlay_end - payload_end;
  if (padding > (uint64_t)KEIKO_MAX_TRAILING_PADDING) {
    return 0;
  }
  *out_payload_start = payload_start;
  *out_padding = padding;
  return 1;
}

// ---------------------------------------------------------------------------------------------
// First-line UTF-8 path parse (the managed root returned by `portable resolve-root`). Decodes
// strict UTF-8, keeps the first line, strips CR/LF, and requires a drive-letter root with no
// control characters. Returns 1 on success.
// ---------------------------------------------------------------------------------------------

static int keiko_parse_managed_root(const char *utf8, int utf8_len, wchar_t *out, int out_cap) {
  int wide_len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, utf8_len, NULL, 0);
  if (wide_len <= 0 || wide_len >= out_cap) {
    return 0;
  }
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, utf8_len, out, out_cap) != wide_len) {
    return 0;
  }
  out[wide_len] = L'\0';
  for (int index = 0; index < wide_len; index++) {
    if (out[index] == L'\r' || out[index] == L'\n') {
      out[index] = L'\0';
      break;
    }
  }
  size_t length = wcslen(out);
  if (length < 3 || !iswalpha(out[0]) || out[1] != L':' || out[2] != L'\\') {
    return 0;
  }
  // The managed root is spliced into a double-quoted CreateProcessW slot (`--managed-root "%ls"`)
  // that is NOT at the end of the command line. By the MSVC-CRT argv rule a trailing backslash would
  // escape the following closing quote — desyncing every later argv token the trusted node/CLI
  // process receives — and an embedded quote would break the quoting outright. A canonical Windows
  // directory path contains neither, so reject both (defence in depth beyond the hash-verified CLI).
  if (out[length - 1] == L'\\') {
    return 0;
  }
  for (size_t index = 0; index < length; index++) {
    if (out[index] < 0x20 || out[index] == L'"') {
      return 0;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Staging directory name. `<temp>Keiko-install-<32 lowercase hex>`, where `<temp>` already carries
// its trailing separator (GetTempPathW guarantees it). Kept pure so the test can assert the shape.
// ---------------------------------------------------------------------------------------------

static int keiko_build_staging_name(wchar_t *out, size_t cap, const wchar_t *temp_dir,
                                    const unsigned char *random16) {
  char hex[33];
  keiko_bytes_to_hex(random16, 16, hex);
  wchar_t hex_wide[33];
  for (size_t index = 0; index < (size_t)33; index++) {
    hex_wide[index] = (wchar_t)hex[index];
  }
  int written = _snwprintf_s(out, cap, _TRUNCATE, L"%lsKeiko-install-%ls", temp_dir, hex_wide);
  return written > 0 && (size_t)written < cap;
}

// ---------------------------------------------------------------------------------------------
// Win32 I/O helpers (not unit-tested — exercised end to end by the Windows smoke).
// ---------------------------------------------------------------------------------------------

typedef struct {
  wchar_t self_path[KEIKO_PATH_CAP];
  wchar_t temp_dir[KEIKO_PATH_CAP];
  wchar_t staging_dir[KEIKO_PATH_CAP];
  wchar_t extract_dir[KEIKO_PATH_CAP];
  wchar_t zip_path[KEIKO_PATH_CAP];
  wchar_t node_path[KEIKO_PATH_CAP];
  wchar_t cli_path[KEIKO_PATH_CAP];
  wchar_t managed_root[KEIKO_PATH_CAP];
  wchar_t tar_path[KEIKO_PATH_CAP];
  wchar_t command[KEIKO_COMMAND_CAP];
} keiko_setup_buffers;

static keiko_setup_buffers *keiko_allocate_buffers(void) {
  HANDLE heap = GetProcessHeap();
  if (heap == NULL) {
    return NULL;
  }
  return (keiko_setup_buffers *)HeapAlloc(heap, HEAP_ZERO_MEMORY, sizeof(keiko_setup_buffers));
}

static void keiko_free_buffers(keiko_setup_buffers *buffers) {
  HANDLE heap = GetProcessHeap();
  if (heap != NULL && buffers != NULL) {
    (void)HeapFree(heap, 0, buffers);
  }
}

static int keiko_file_exists(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static int keiko_seek(HANDLE file, uint64_t offset) {
  LARGE_INTEGER position;
  position.QuadPart = (LONGLONG)offset;
  return SetFilePointerEx(file, position, NULL, FILE_BEGIN) != 0;
}

static int keiko_read_exact(HANDLE file, unsigned char *buffer, DWORD length) {
  DWORD read_bytes = 0;
  if (!ReadFile(file, buffer, length, &read_bytes, NULL) || read_bytes != length) {
    return 0;
  }
  return 1;
}

// Opens a directory as a NO-FOLLOW handle and proves — atomically, on the handle itself — that it
// is a real directory and not a reparse point. This is the anchor that closes the cleanup TOCTOU
// (review 3887021643): a name-based check (GetFileAttributesW) followed by a name-based descent
// (FindFirstFileW) leaves a window in which a same-user racer swaps the checked directory for a
// junction, and the descent then walks — and deletes under — the junction's TARGET.
//
// Two properties do the work:
//   1. FILE_FLAG_OPEN_REPARSE_POINT opens the link ITSELF, never its target, so
//      GetFileInformationByHandle reports what this handle actually is — no follow, no race.
//   2. The share mode grants READ/WRITE but NOT DELETE: while the handle is held, no other process
//      can delete or RENAME this directory (rename needs DELETE access), so the path underneath it
//      cannot be re-pointed for as long as the caller keeps enumerating and deleting by name.
// Returns INVALID_HANDLE_VALUE when the entry is missing, cannot be opened, or is not a plain
// directory — the caller fails closed (leaks staging) rather than descending into ambiguity.
static HANDLE keiko_open_plain_dir_no_follow(const wchar_t *path) {
  HANDLE dir = CreateFileW(path, FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                           NULL);
  if (dir == INVALID_HANDLE_VALUE) {
    return INVALID_HANDLE_VALUE;
  }
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(dir, &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    (void)CloseHandle(dir);
    return INVALID_HANDLE_VALUE;
  }
  return dir;
}

// Deletes ONE directory entry without ever following a link, based on the attributes the directory
// scan reported. The scan data can be STALE — a racer may have swapped the entry since — but every
// stale outcome fails CLOSED rather than following:
//   - reported reparse, now a real populated directory  -> RemoveDirectoryW fails (not empty).
//   - reported file, now a directory or junction        -> DeleteFileW fails (access denied).
//   - reported real directory, now a junction           -> the recursion re-verifies on ITS OWN
//     no-follow handle before enumerating and refuses to descend.
static int keiko_remove_tree(const wchar_t *path);

static int keiko_delete_entry(const wchar_t *child, DWORD attributes) {
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    (void)SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      // Unlinks the junction/symlink itself; the target and its contents are untouched.
      return RemoveDirectoryW(child) != 0;
    }
    return DeleteFileW(child) != 0;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return keiko_remove_tree(child);
  }
  (void)SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL);
  return DeleteFileW(child) != 0;
}

// Recursively deletes a directory tree the bootstrap created, anchored on a held no-follow handle
// per level (see keiko_open_plain_dir_no_follow): the staging tree is observable by any process
// running as the same user for the duration of a multi-step install, and a racer that swaps a
// directory for a junction must not be able to steer this cleanup outside the staging root — at
// ANY level, not only the root. Each level allocates its OWN heap path buffers, so the deeply
// nested extracted tree (node_modules) cannot overflow the stack the way 32 KiB per-level stack
// buffers would. A directory that cannot be OPENED or ENUMERATED is a failure, never silently
// "already empty" (except a genuinely empty listing, ERROR_FILE_NOT_FOUND): failing closed leaks
// staging for the operator to see, which is strictly safer than deleting through ambiguity.
static int keiko_remove_tree(const wchar_t *path) {
  // The handle pins identity AND existence: verified a real directory (no reparse), and — because
  // the share mode denies DELETE — it cannot be renamed or replaced while held, so the by-name
  // enumeration and child deletes below run against exactly the directory that was verified.
  HANDLE dir = keiko_open_plain_dir_no_follow(path);
  if (dir == INVALID_HANDLE_VALUE) {
    return 0;
  }
  HANDLE heap = GetProcessHeap();
  wchar_t *pattern = (wchar_t *)HeapAlloc(heap, 0, KEIKO_PATH_CAP * sizeof(wchar_t));
  wchar_t *child = (wchar_t *)HeapAlloc(heap, 0, KEIKO_PATH_CAP * sizeof(wchar_t));
  int ok = 0;
  if (pattern != NULL && child != NULL &&
      _snwprintf_s(pattern, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\*", path) > 0) {
    WIN32_FIND_DATAW entry;
    HANDLE find = FindFirstFileW(pattern, &entry);
    ok = find != INVALID_HANDLE_VALUE || GetLastError() == ERROR_FILE_NOT_FOUND;
    if (find != INVALID_HANDLE_VALUE) {
      do {
        if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) {
          continue;
        }
        if (_snwprintf_s(child, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\%ls", path, entry.cFileName) <= 0) {
          ok = 0;
          break;
        }
        // The recursion allocates its own buffers, so no level aliases another's.
        ok = keiko_delete_entry(child, entry.dwFileAttributes);
        if (!ok) {
          break;
        }
      } while (FindNextFileW(find, &entry));
      (void)FindClose(find);
    }
  }
  if (pattern != NULL) {
    (void)HeapFree(heap, 0, pattern);
  }
  if (child != NULL) {
    (void)HeapFree(heap, 0, child);
  }
  // The handle must be released before the directory itself can be removed (our own open denies
  // the DELETE that RemoveDirectoryW needs). The window between close and remove is benign: if a
  // racer swaps the now-empty directory for a junction here, RemoveDirectoryW unlinks the junction
  // itself — it never touches the target's contents.
  (void)CloseHandle(dir);
  return ok && RemoveDirectoryW(path) != 0;
}

// One spawned child plus the Job Object that binds its whole descendant tree to a single
// termination handle. Both governed runners below use it so a watchdog fire kills the WORK the
// child started, not only the child (review 3887021654): `portable setup`/`launch` run a Node CLI
// that spawns server/worker descendants, and TerminateProcess on the CLI alone left those running
// while the bootstrap reported failure and cleaned up under them.
typedef struct {
  PROCESS_INFORMATION process;
  // NULL when Job assignment was unavailable (then termination degrades to the single process —
  // the pre-fix behaviour — rather than failing the run). NEVER configured kill-on-close: on the
  // SUCCESS path of the launch step, the started Keiko app must outlive this installer, so the job
  // handle is simply closed; only the WATCHDOG path terminates the job.
  HANDLE job;
} keiko_child;

// Spawns suspended, assigns the process to a fresh Job Object, then resumes — the assign must win
// the race against the child spawning its first descendant, which is exactly what the suspended
// start guarantees. `inherit`/`startup` come from the caller (the capture runner passes a pipe).
static int keiko_spawn_in_job(const wchar_t *application, wchar_t *command_line,
                              STARTUPINFOW *startup, BOOL inherit_handles, keiko_child *out) {
  ZeroMemory(out, sizeof(*out));
  if (!CreateProcessW(application, command_line, NULL, NULL, inherit_handles, CREATE_SUSPENDED,
                      NULL, NULL, startup, &out->process)) {
    return 0;
  }
  out->job = CreateJobObjectW(NULL, NULL);
  if (out->job != NULL && !AssignProcessToJobObject(out->job, out->process.hProcess)) {
    // Assignment can fail inside an older nested-job-hostile container: degrade to single-process
    // termination instead of failing a run that would otherwise succeed.
    (void)CloseHandle(out->job);
    out->job = NULL;
  }
  if (ResumeThread(out->process.hThread) == (DWORD)-1) {
    // A child that cannot be resumed will never exit on its own: tear it (and its job) down now.
    if (out->job != NULL) {
      (void)TerminateJobObject(out->job, 1);
      (void)CloseHandle(out->job);
    }
    (void)TerminateProcess(out->process.hProcess, 1);
    (void)CloseHandle(out->process.hThread);
    (void)CloseHandle(out->process.hProcess);
    ZeroMemory(out, sizeof(*out));
    return 0;
  }
  return 1;
}

// Terminates the child's WHOLE tree (job-bound when available) and waits briefly for the process
// object to settle so the caller can rely on the pid being dead before touching shared state.
static void keiko_terminate_child_tree(keiko_child *child) {
  if (child->job != NULL) {
    (void)TerminateJobObject(child->job, 1);
  }
  (void)TerminateProcess(child->process.hProcess, 1);
  (void)WaitForSingleObject(child->process.hProcess, KEIKO_CHILD_EXIT_GRACE_MS);
}

static void keiko_close_child(keiko_child *child) {
  if (child->job != NULL) {
    (void)CloseHandle(child->job);
  }
  (void)CloseHandle(child->process.hThread);
  (void)CloseHandle(child->process.hProcess);
}

// Waits up to `timeout_ms` for the child to exit; on expiry the whole tree is terminated and the
// run reported failed. Split from keiko_run_and_wait so the behaviour test can drive it with a
// short deadline against a real descendant-spawning child.
static int keiko_wait_or_terminate(keiko_child *child, DWORD timeout_ms) {
  DWORD exit_code = 1;
  if (WaitForSingleObject(child->process.hProcess, timeout_ms) != WAIT_OBJECT_0) {
    keiko_terminate_child_tree(child);
  } else {
    (void)GetExitCodeProcess(child->process.hProcess, &exit_code);
  }
  return exit_code == 0;
}

// Runs an application by absolute path, waits for it, and reports whether it exited with code 0.
// The child inherits this process's console so its own output stays visible (no stdout capture).
// The wait is bounded by a deliberately generous watchdog: no legitimate step (tar extraction of the
// ~130 MB archive, the governed setup, or the launch health window) comes close to it, but a wedged
// child — INCLUDING every descendant it started, via the Job Object — is terminated and reported as
// a failure instead of hanging the installer forever.
static int keiko_run_and_wait(const wchar_t *application, wchar_t *command_line) {
  STARTUPINFOW startup;
  keiko_child child;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  if (!keiko_spawn_in_job(application, command_line, &startup, FALSE, &child)) {
    return 0;
  }
  int ok = keiko_wait_or_terminate(&child, (DWORD)KEIKO_CHILD_TIMEOUT_MS);
  keiko_close_child(&child);
  return ok;
}

// Drains a child's stdout pipe WITHOUT ever blocking indefinitely, and returns the number of bytes
// captured into `out` (always < cap, leaving room for the caller's NUL).
//
// A plain blocking ReadFile cannot be watchdogged: a child that wedges while holding stdout open
// produces no bytes and never closes the pipe, so the read never returns and the process deadline
// below it is unreachable — the installer hangs forever on a silently hung `portable resolve-root`.
// This loop instead MULTIPLEXES the three things that can end the capture: bytes becoming available
// (PeekNamedPipe), the child exiting (WaitForSingleObject with a short slice), and the deadline
// elapsing (a monotonic GetTickCount64 comparison that is immune to wall-clock changes).
//
// Output past the cap keeps being drained into a throwaway buffer instead of stopping the loop: a
// full pipe would block the child's next write until the deadline, turning a merely chatty child
// into a 20-minute stall. Draining costs nothing and lets a chatty-but-healthy child finish.
static int keiko_drain_pipe(HANDLE read_end, HANDLE child, char *out, int cap) {
  int total = 0;
  unsigned char discard[4096];
  ULONGLONG deadline = GetTickCount64() + (ULONGLONG)KEIKO_CHILD_TIMEOUT_MS;
  for (;;) {
    // Checked on EVERY turn, not only when the pipe is idle: a child that produces output without
    // end must hit the watchdog too, not just one that goes silent.
    if (GetTickCount64() >= deadline) {
      break; // Watchdog: the caller terminates the child and reports the step as failed.
    }
    DWORD available = 0;
    if (!PeekNamedPipe(read_end, NULL, 0, NULL, &available, NULL)) {
      break; // The write end is closed and the buffer is empty: EOF, the normal exit.
    }
    if (available == 0) {
      // Nothing to read right now. If the child is gone, one more Peek settles whether it left
      // buffered bytes behind; otherwise sleep on the process handle so a prompt exit is noticed
      // immediately rather than after a fixed poll interval.
      if (WaitForSingleObject(child, KEIKO_DRAIN_POLL_MS) == WAIT_OBJECT_0 &&
          PeekNamedPipe(read_end, NULL, 0, NULL, &available, NULL) && available == 0) {
        break;
      }
      continue;
    }
    DWORD read_bytes = 0;
    if (total < cap - 1) {
      DWORD want = (DWORD)(cap - 1 - total);
      if (!ReadFile(read_end, out + total, available < want ? available : want, &read_bytes, NULL) ||
          read_bytes == 0) {
        break;
      }
      total += (int)read_bytes;
    } else if (!ReadFile(read_end, discard, available < (DWORD)sizeof(discard) ? available
                                                                              : (DWORD)sizeof(discard),
                         &read_bytes, NULL) ||
               read_bytes == 0) {
      break;
    }
  }
  return total;
}

// Runs an application capturing up to KEIKO_RESOLVE_OUTPUT_CAP bytes of its stdout (stderr stays on
// this process's console). Returns 1 with the captured length only when the child exits 0.
static int keiko_run_capture(const wchar_t *application, wchar_t *command_line, char *out,
                             int cap, int *out_len) {
  SECURITY_ATTRIBUTES attributes;
  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  HANDLE read_end = NULL;
  HANDLE write_end = NULL;
  if (!CreatePipe(&read_end, &write_end, &attributes, 0)) {
    return 0;
  }
  if (!SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0)) {
    (void)CloseHandle(read_end);
    (void)CloseHandle(write_end);
    return 0;
  }
  STARTUPINFOW startup;
  keiko_child child;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.hStdOutput = write_end;
  if (!keiko_spawn_in_job(application, command_line, &startup, TRUE, &child)) {
    (void)CloseHandle(read_end);
    (void)CloseHandle(write_end);
    return 0;
  }
  (void)CloseHandle(write_end);
  int total = keiko_drain_pipe(read_end, child.process.hProcess, out, cap);
  (void)CloseHandle(read_end);
  DWORD exit_code = 1;
  // The drain loop above already observed the deadline, so this wait only collects a child that has
  // finished (or is finishing) — it is not the watchdog. A child still alive here has blown the
  // deadline or wedged after closing stdout: its whole tree is terminated (Job Object) rather than
  // waited on for 20 minutes — descendants of a wedged resolve-root must not outlive the verdict.
  if (WaitForSingleObject(child.process.hProcess, KEIKO_CHILD_EXIT_GRACE_MS) != WAIT_OBJECT_0) {
    keiko_terminate_child_tree(&child);
  } else {
    (void)GetExitCodeProcess(child.process.hProcess, &exit_code);
  }
  keiko_close_child(&child);
  out[total] = '\0';
  *out_len = total;
  return exit_code == 0;
}

// ---------------------------------------------------------------------------------------------
// Integrity: stream the payload region from the open self-handle through BCrypt SHA-256 while
// copying it to the staging ZIP, then compare the digest and size to the baked constants.
// ---------------------------------------------------------------------------------------------

// Copies the payload region to the staging ZIP while hashing it, and returns an EXIT CODE rather
// than a boolean so the caller can tell the two very different failure classes apart:
//
//   KEIKO_EXIT_INTEGRITY — the bytes are not the bytes we baked (size or digest mismatch), or the
//                          running image could not be read back. Remediation: download again.
//   KEIKO_EXIT_STAGING   — the DESTINATION or a local resource failed: %TEMP% full or unwritable,
//                          endpoint protection blocking the file, a write error, no memory, no
//                          crypto provider. Nothing here is evidence of tampering, and telling an
//                          operator to re-download a full disk sends them to the wrong fix.
typedef enum {
  KEIKO_STREAM_OK = 0,
  KEIKO_STREAM_SOURCE_FAILED = 1, // the read side or the hash failed: the bytes are not vouched for
  KEIKO_STREAM_SINK_FAILED = 2,   // the write side failed: a full or blocked destination volume
  KEIKO_STREAM_RESOURCE_FAILED = 3 // no memory / no crypto provider: a local fault, not tampering
} keiko_stream_status;

// Streams `length` bytes from the CURRENT position of `source` through SHA-256, copying each chunk
// to `sink` when one is supplied (INVALID_HANDLE_VALUE hashes without copying). Writes the lowercase
// hex digest to `out_hex` on success. The status names WHICH side failed so callers can keep the
// published exit-code contract honest instead of collapsing every fault into "package damaged".
static keiko_stream_status keiko_stream_sha256(HANDLE source, uint64_t length, HANDLE sink,
                                               char *out_hex) {
  BCRYPT_ALG_HANDLE algorithm = NULL;
  BCRYPT_HASH_HANDLE hash = NULL;
  unsigned char *chunk = NULL;
  keiko_stream_status status = KEIKO_STREAM_RESOURCE_FAILED;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) == 0 &&
      BCryptCreateHash(algorithm, &hash, NULL, 0, NULL, 0, 0) == 0) {
    chunk = (unsigned char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)KEIKO_HASH_CHUNK_BYTES);
  }
  if (chunk != NULL) {
    status = KEIKO_STREAM_OK;
    uint64_t remaining = length;
    while (remaining > 0 && status == KEIKO_STREAM_OK) {
      DWORD want = remaining < (uint64_t)KEIKO_HASH_CHUNK_BYTES ? (DWORD)remaining
                                                                : (DWORD)KEIKO_HASH_CHUNK_BYTES;
      DWORD read_bytes = 0;
      DWORD written = 0;
      if (!ReadFile(source, chunk, want, &read_bytes, NULL) || read_bytes != want ||
          BCryptHashData(hash, chunk, read_bytes, 0) != 0) {
        status = KEIKO_STREAM_SOURCE_FAILED;
      } else if (sink != INVALID_HANDLE_VALUE &&
                 (!WriteFile(sink, chunk, read_bytes, &written, NULL) || written != read_bytes)) {
        status = KEIKO_STREAM_SINK_FAILED;
      } else {
        remaining -= read_bytes;
      }
    }
  }
  unsigned char digest[KEIKO_SHA256_BYTES];
  if (status == KEIKO_STREAM_OK) {
    if (BCryptFinishHash(hash, digest, (ULONG)KEIKO_SHA256_BYTES, 0) == 0) {
      keiko_bytes_to_hex(digest, KEIKO_SHA256_BYTES, out_hex);
    } else {
      status = KEIKO_STREAM_RESOURCE_FAILED;
    }
  }
  if (chunk != NULL) {
    (void)HeapFree(GetProcessHeap(), 0, chunk);
  }
  if (hash != NULL) {
    (void)BCryptDestroyHash(hash);
  }
  if (algorithm != NULL) {
    (void)BCryptCloseAlgorithmProvider(algorithm, 0);
  }
  return status;
}

static int keiko_stage_verified_payload(HANDLE self, uint64_t payload_start, uint64_t payload_size,
                                        const wchar_t *zip_path) {
  if (payload_size != (uint64_t)KEIKO_SETUP_PAYLOAD_SIZE_BYTES) {
    return KEIKO_EXIT_INTEGRITY;
  }
  HANDLE zip = CreateFileW(zip_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                           NULL);
  if (zip == INVALID_HANDLE_VALUE) {
    return KEIKO_EXIT_STAGING;
  }
  int result = KEIKO_EXIT_INTEGRITY;
  char computed_hex[KEIKO_SHA256_HEX_CHARS + 1];
  if (keiko_seek(self, payload_start)) {
    switch (keiko_stream_sha256(self, payload_size, zip, computed_hex)) {
      case KEIKO_STREAM_OK:
        result = keiko_hex_equal(computed_hex, KEIKO_SETUP_PAYLOAD_SHA256_HEX) ? KEIKO_EXIT_OK
                                                                               : KEIKO_EXIT_INTEGRITY;
        break;
      case KEIKO_STREAM_SOURCE_FAILED:
        result = KEIKO_EXIT_INTEGRITY;
        break;
      // Both remaining causes are LOCAL faults, not tampering: a full/blocked destination volume,
      // or no memory / no crypto provider. Listed explicitly rather than folded into `default:` so
      // a future status added to keiko_stream_status cannot silently inherit "staging".
      case KEIKO_STREAM_SINK_FAILED:
      case KEIKO_STREAM_RESOURCE_FAILED:
      default:
        result = KEIKO_EXIT_STAGING;
        break;
    }
  }
  (void)CloseHandle(zip);
  return result;
}

// Reopens the staged ZIP for reading with write and delete DENIED to every other process, proves the
// bytes now on disk are still the bytes that were staged, and returns the handle STILL OPEN.
//
// keiko_stage_verified_payload hashes the payload as it streams out of the running image, so what it
// proves is a property of the SOURCE. Between that write and tar.exe opening the ZIP by name, another
// process running as the same user could replace the file, and the bootstrap would unpack bytes
// nobody hashed. Re-hashing through this handle proves the on-disk bytes, and keeping the handle open
// for the whole extraction closes the window behind it: replacing, renaming or deleting the file all
// require a sharing mode this handle refuses. tar.exe still opens it for reading, which is the only
// access it needs and the only one FILE_SHARE_READ grants.
static HANDLE keiko_open_staged_zip(const wchar_t *zip_path) {
  HANDLE zip = CreateFileW(zip_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
  if (zip == INVALID_HANDLE_VALUE) {
    return INVALID_HANDLE_VALUE;
  }
  LARGE_INTEGER size;
  char computed_hex[KEIKO_SHA256_HEX_CHARS + 1];
  if (GetFileSizeEx(zip, &size) &&
      (uint64_t)size.QuadPart == (uint64_t)KEIKO_SETUP_PAYLOAD_SIZE_BYTES && keiko_seek(zip, 0) &&
      keiko_stream_sha256(zip, (uint64_t)size.QuadPart, INVALID_HANDLE_VALUE, computed_hex) ==
          KEIKO_STREAM_OK &&
      keiko_hex_equal(computed_hex, KEIKO_SETUP_PAYLOAD_SHA256_HEX)) {
    return zip;
  }
  (void)CloseHandle(zip);
  return INVALID_HANDLE_VALUE;
}

// Locates + verifies the overlay in the running image and extracts the payload to the staging ZIP.
static int keiko_extract_verified_payload(keiko_setup_buffers *b) {
  HANDLE self = CreateFileW(b->self_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_ATTRIBUTE_NORMAL, NULL);
  if (self == INVALID_HANDLE_VALUE) {
    return KEIKO_EXIT_SELF_PARSE;
  }
  int result = KEIKO_EXIT_SELF_PARSE;
  unsigned char *scan = (unsigned char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)KEIKO_HEADER_SCAN_BYTES);
  LARGE_INTEGER file_size;
  if (scan != NULL && GetFileSizeEx(self, &file_size) && file_size.QuadPart > 0) {
    DWORD scan_len = file_size.QuadPart < (LONGLONG)KEIKO_HEADER_SCAN_BYTES
                         ? (DWORD)file_size.QuadPart
                         : (DWORD)KEIKO_HEADER_SCAN_BYTES;
    keiko_overlay_bounds bounds;
    unsigned char header[KEIKO_OVERLAY_HEADER_BYTES];
    uint64_t payload_size = 0;
    char header_hex[KEIKO_SHA256_HEX_CHARS + 1];
    uint64_t payload_start = 0;
    uint64_t padding = 0;
    if (keiko_read_exact(self, scan, scan_len) &&
        keiko_parse_overlay_bounds(scan, scan_len, (uint64_t)file_size.QuadPart, &bounds) &&
        keiko_seek(self, bounds.overlay_start) &&
        keiko_read_exact(self, header, (DWORD)KEIKO_OVERLAY_HEADER_BYTES) &&
        keiko_validate_overlay_header(header, &payload_size, header_hex)) {
      // Integrity gate: the overlay must physically fit before the certificate table with only the
      // <=7 ZERO alignment bytes signing may add, the header digest must equal the baked digest,
      // and (below) the streamed payload digest must equal it too. Any failure -> nothing extracts.
      unsigned char padding_bytes[KEIKO_MAX_TRAILING_PADDING];
      int region_ok =
          keiko_payload_region(bounds.overlay_start, bounds.overlay_end, payload_size,
                               &payload_start, &padding) &&
          keiko_hex_equal(header_hex, KEIKO_SETUP_PAYLOAD_SHA256_HEX) &&
          (padding == 0 || (keiko_seek(self, payload_start + payload_size) &&
                            keiko_read_exact(self, padding_bytes, (DWORD)padding) &&
                            keiko_all_zero(padding_bytes, (size_t)padding)));
      if (region_ok) {
        // Propagates the staged result verbatim: OK, INTEGRITY (the bytes are wrong) or STAGING
        // (the temp volume is), so the exit code names the failure the operator actually has.
        result = keiko_stage_verified_payload(self, payload_start, payload_size, b->zip_path);
      } else {
        result = KEIKO_EXIT_INTEGRITY;
      }
    }
  }
  if (scan != NULL) {
    (void)HeapFree(GetProcessHeap(), 0, scan);
  }
  (void)CloseHandle(self);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Governed lifecycle steps: tar extraction, then the portable CLI resolve-root / setup / launch.
// ---------------------------------------------------------------------------------------------

// A path-sized working buffer, on the HEAP. KEIKO_PATH_CAP is 32768 wchar_t = 64 KiB, which is far
// past the stack budget `/analyze` enforces (C6262) and past what this call chain can afford —
// keiko_setup_buffers is heap-allocated for exactly the same reason, as is each level of
// keiko_remove_tree. Returns NULL on exhaustion; every caller must check.
static wchar_t *keiko_alloc_path(void) {
  return (wchar_t *)HeapAlloc(GetProcessHeap(), 0, KEIKO_PATH_CAP * sizeof(wchar_t));
}

static void keiko_free_path(wchar_t *path) {
  if (path != NULL) {
    (void)HeapFree(GetProcessHeap(), 0, path);
  }
}

static int keiko_build_managed_paths(keiko_setup_buffers *b, const wchar_t *system_dir);

static int keiko_prepare_paths(keiko_setup_buffers *b) {
  wchar_t *system_dir = keiko_alloc_path();
  if (system_dir == NULL) {
    return 0;
  }
  int located = GetModuleFileNameW(NULL, b->self_path, KEIKO_PATH_CAP) != 0 &&
                GetTempPathW(KEIKO_PATH_CAP, b->temp_dir) != 0 &&
                GetSystemDirectoryW(system_dir, KEIKO_PATH_CAP) != 0;
  unsigned char random16[16];
  if (located) {
    located = BCryptGenRandom(NULL, random16, sizeof(random16), BCRYPT_USE_SYSTEM_PREFERRED_RNG) ==
                  0 &&
              keiko_build_staging_name(b->staging_dir, KEIKO_PATH_CAP, b->temp_dir, random16);
  }
  if (!located) {
    keiko_free_path(system_dir);
    return 0;
  }
  int ok = keiko_build_managed_paths(b, system_dir);
  keiko_free_path(system_dir);
  return ok;
}

static int keiko_build_managed_paths(keiko_setup_buffers *b, const wchar_t *system_dir) {
  return _snwprintf_s(b->tar_path, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\tar.exe", system_dir) > 0 &&
         _snwprintf_s(b->zip_path, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\keiko-windows-x64.zip",
                      b->staging_dir) > 0 &&
         _snwprintf_s(b->extract_dir, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\Keiko", b->staging_dir) > 0 &&
         _snwprintf_s(b->node_path, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\runtime\\node\\node.exe",
                      b->extract_dir) > 0 &&
         _snwprintf_s(b->cli_path, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\app\\dist\\cli\\index.js",
                      b->extract_dir) > 0;
}

static int keiko_extract_archive(keiko_setup_buffers *b) {
  if (_snwprintf_s(b->command, KEIKO_COMMAND_CAP, _TRUNCATE, L"\"%ls\" -xf \"%ls\" -C \"%ls\"",
                   b->tar_path, b->zip_path, b->staging_dir) <= 0) {
    return 0;
  }
  return keiko_run_and_wait(b->tar_path, b->command);
}

static int keiko_payload_contents_present(const keiko_setup_buffers *b) {
  wchar_t *keiko_exe = keiko_alloc_path();
  if (keiko_exe == NULL) {
    return 0;
  }
  int ok =
      _snwprintf_s(keiko_exe, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\Keiko.exe", b->extract_dir) > 0 &&
      keiko_file_exists(keiko_exe) && keiko_file_exists(b->node_path) &&
      keiko_file_exists(b->cli_path);
  keiko_free_path(keiko_exe);
  return ok;
}

static int keiko_resolve_managed_root(keiko_setup_buffers *b) {
  if (_snwprintf_s(b->command, KEIKO_COMMAND_CAP, _TRUNCATE,
                   L"\"%ls\" \"%ls\" portable resolve-root --target %ls --portable-root \"%ls\"",
                   b->node_path, b->cli_path, KEIKO_WIDEN(KEIKO_SETUP_TARGET), b->extract_dir) <= 0) {
    return 0;
  }
  // Heap, not stack: KEIKO_RESOLVE_OUTPUT_CAP is 64 KiB, the same reason every path buffer above is
  // heap-allocated (`/analyze` C6262, and a deep call chain cannot afford it).
  char *output = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)KEIKO_RESOLVE_OUTPUT_CAP);
  if (output == NULL) {
    return 0;
  }
  int output_len = 0;
  int ok = keiko_run_capture(b->node_path, b->command, output, KEIKO_RESOLVE_OUTPUT_CAP,
                             &output_len) &&
           keiko_parse_managed_root(output, output_len, b->managed_root, KEIKO_PATH_CAP);
  (void)HeapFree(GetProcessHeap(), 0, output);
  return ok;
}

static int keiko_run_setup_step(keiko_setup_buffers *b) {
  return _snwprintf_s(b->command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" \"%ls\" portable setup --target %ls --portable-root \"%ls\" "
                      L"--managed-root \"%ls\"",
                      b->node_path, b->cli_path, KEIKO_WIDEN(KEIKO_SETUP_TARGET), b->extract_dir,
                      b->managed_root) > 0 &&
         keiko_run_and_wait(b->node_path, b->command);
}

static int keiko_run_launch_step(keiko_setup_buffers *b) {
  wchar_t *managed_node = keiko_alloc_path();
  wchar_t *managed_cli = keiko_alloc_path();
  int ok = 0;
  if (managed_node != NULL && managed_cli != NULL &&
      _snwprintf_s(managed_node, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\runtime\\node\\node.exe",
                   b->managed_root) > 0 &&
      _snwprintf_s(managed_cli, KEIKO_PATH_CAP, _TRUNCATE, L"%ls\\app\\dist\\cli\\index.js",
                   b->managed_root) > 0) {
    // `portable launch` exits 0 only after the lifecycle CLI's own waitForHealth saw /api/health
    // answer with the installed version while the spawned process stayed alive. That exit code IS
    // the "Keiko is running" proof; a second poll here would re-attest weaker evidence.
    ok = _snwprintf_s(b->command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" \"%ls\" portable launch --target %ls --portable-root \"%ls\" "
                      L"--managed-root \"%ls\"",
                      managed_node, managed_cli, KEIKO_WIDEN(KEIKO_SETUP_TARGET), b->managed_root,
                      b->managed_root) > 0 &&
         keiko_run_and_wait(managed_node, b->command);
  }
  keiko_free_path(managed_node);
  keiko_free_path(managed_cli);
  return ok;
}

// Rewrites an absolute path into its extended-length (`\\?\`) form, which lifts the MAX_PATH limit
// on FindFirstFileW / DeleteFileW / RemoveDirectoryW without depending on the machine's
// LongPathsEnabled policy or an application manifest. The extracted tree is npm's `node_modules`,
// which nests far past 260 characters under a staging prefix that is already ~90 characters — and a
// cleanup that fails there turns a SUCCESSFUL install into exit 19, which every /quiet deployment
// records as a failed install. A UNC temp directory takes the `\\?\UNC\server\share` spelling. A
// path that is already prefixed, or too long to prefix, is copied through unchanged.
static int keiko_extended_path(const wchar_t *path, wchar_t *out, size_t cap) {
  if (wcsncmp(path, L"\\\\?\\", 4) == 0) {
    return _snwprintf_s(out, cap, _TRUNCATE, L"%ls", path) > 0;
  }
  if (wcsncmp(path, L"\\\\", 2) == 0) {
    return _snwprintf_s(out, cap, _TRUNCATE, L"\\\\?\\UNC\\%ls", path + 2) > 0;
  }
  return _snwprintf_s(out, cap, _TRUNCATE, L"\\\\?\\%ls", path) > 0;
}

// "Gone" means GONE, not "could not be looked at". GetFileAttributesW returns
// INVALID_FILE_ATTRIBUTES for ERROR_ACCESS_DENIED, ERROR_INVALID_NAME, and every I/O fault too —
// treating all of those as success made this cleanup fail OPEN (review 3887051414): the installer
// printed [6/6] and exited 0 while the ~130 MB extracted tree stayed in %TEMP% with no diagnostic.
// Only the two not-found codes prove the directory no longer exists; everything else is a failure
// the caller reports as exit 19, matching keiko_remove_tree's own "a directory that cannot be
// ENUMERATED is a failure" contract.
static int keiko_staging_verifiably_gone(const wchar_t *staging) {
  if (GetFileAttributesW(staging) != INVALID_FILE_ATTRIBUTES) {
    return 0;
  }
  DWORD reason = GetLastError();
  return reason == ERROR_FILE_NOT_FOUND || reason == ERROR_PATH_NOT_FOUND;
}

static int keiko_remove_staging_tree(const wchar_t *staging) {
  for (int attempt = 0; attempt < 10; attempt++) {
    if (keiko_staging_verifiably_gone(staging)) {
      return 1;
    }
    if (keiko_remove_tree(staging)) {
      return 1;
    }
    Sleep(1000);
  }
  return keiko_staging_verifiably_gone(staging);
}

static int keiko_cleanup_staging(const keiko_setup_buffers *b) {
  wchar_t *staging = keiko_alloc_path();
  if (staging == NULL) {
    return 0;
  }
  int ok = keiko_extended_path(b->staging_dir, staging, KEIKO_PATH_CAP) &&
           keiko_remove_staging_tree(staging);
  keiko_free_path(staging);
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------------------------

static int keiko_run_setup(keiko_setup_buffers *b) {
  fwprintf(stdout, L"Keiko setup\n===========\n\n");
  fwprintf(stdout, L"[1/6] Verifying the setup package...\n");
  if (!keiko_prepare_paths(b) || CreateDirectoryW(b->staging_dir, NULL) == 0) {
    fwprintf(stderr, L"Keiko setup could not create its temporary staging folder.\n");
    return KEIKO_EXIT_STAGING;
  }
  int integrity = keiko_extract_verified_payload(b);
  if (integrity == KEIKO_EXIT_STAGING) {
    // A full or blocked temp volume is not evidence of tampering: sending an operator to re-download
    // a ~130 MB installer because their disk is full is the wrong remediation entirely.
    fwprintf(stderr, L"Keiko setup could not write to its temporary folder. Free space in %%TEMP%% "
                     L"(or allow the installer in your endpoint protection) and run setup again.\n");
    return integrity;
  }
  if (integrity != KEIKO_EXIT_OK) {
    fwprintf(stderr, L"The setup package is damaged. Download keiko-windows-x64-setup.exe again.\n");
    return integrity;
  }

  fwprintf(stdout, L"[2/6] Extracting Keiko to a temporary staging folder...\n");
  // Hold the staged ZIP open, write- and delete-denied, for the whole extraction, so the bytes
  // tar.exe reads are provably the bytes that were just verified (see keiko_open_staged_zip).
  HANDLE zip_guard = keiko_open_staged_zip(b->zip_path);
  if (zip_guard == INVALID_HANDLE_VALUE) {
    fwprintf(stderr, L"The setup package is damaged. Download keiko-windows-x64-setup.exe again.\n");
    return KEIKO_EXIT_INTEGRITY;
  }
  int extracted = keiko_extract_archive(b);
  (void)CloseHandle(zip_guard);
  if (!extracted) {
    fwprintf(stderr, L"Keiko setup could not unpack the embedded package.\n");
    return KEIKO_EXIT_EXTRACTION;
  }

  fwprintf(stdout, L"[3/6] Verifying application files...\n");
  if (!keiko_payload_contents_present(b)) {
    fwprintf(stderr, L"Keiko setup payload did not contain the expected application files.\n");
    return KEIKO_EXIT_PAYLOAD_CONTENTS;
  }

  fwprintf(stdout, L"[4/6] Resolving the managed install location...\n");
  if (!keiko_resolve_managed_root(b)) {
    fwprintf(stderr, L"Keiko setup could not resolve the managed install root.\n");
    return KEIKO_EXIT_RESOLVE_ROOT;
  }

  fwprintf(stdout, L"[5/6] Installing and launching Keiko through the governed lifecycle...\n");
  if (!keiko_run_setup_step(b)) {
    fwprintf(stderr, L"Keiko setup could not complete the governed installation.\n");
    return KEIKO_EXIT_SETUP;
  }
  if (!keiko_run_launch_step(b)) {
    fwprintf(stderr, L"Keiko started but did not report healthy.\n");
    return KEIKO_EXIT_LAUNCH;
  }

  fwprintf(stdout, L"[6/6] Removing temporary application files...\n");
  if (!keiko_cleanup_staging(b)) {
    fwprintf(stderr, L"Keiko is running, but its temporary files could not be removed.\n");
    return KEIKO_EXIT_CLEANUP;
  }
  fwprintf(stdout, L"\nKeiko is running.\nKeiko setup finished successfully.\n");
  return KEIKO_EXIT_OK;
}

// True only when this process is the sole owner of its console — i.e. the window closes with us, so
// a message printed and then left on screen would otherwise vanish before it can be read.
static int keiko_sole_console_owner(void) {
  DWORD process_ids[2];
  DWORD count = GetConsoleProcessList(process_ids, 2);
  return count == 1;
}

static void keiko_pace_after(int exit_code, int quiet) {
  if (quiet || !keiko_sole_console_owner()) {
    return;
  }
  if (exit_code == KEIKO_EXIT_OK) {
    Sleep(2000);
    return;
  }
  // The one place a human double-clicked the installer and it failed: keep the window open so the
  // reason (printed above) stays readable instead of closing unread (the #2966 lesson). The
  // "setup failed" wording was already emitted by wmain, so this only prompts.
  fwprintf(stdout, L"Press any key to close this window.\n");
  (void)_getwch();
}

int wmain(int argc, wchar_t **argv) {
  // Constrain every RUNTIME library load to System32 and drop the current directory from the search
  // order. These two calls affect subsequent LoadLibraryEx-style resolution only; this program
  // performs none, so what they actually buy is defence in depth against a future load and against
  // one performed by a DLL we import. They CANNOT cover this binary's own implicit imports
  // (bcrypt.dll, and the CRT unless linked /MT), which the loader has already resolved before the
  // first instruction of wmain runs — the application directory is searched first for any implicit
  // import that is not a KnownDLL. That gap, which is exactly the launched-from-Downloads case, is
  // closed on the LINK line instead: /DEPENDENTLOADFLAG:0x800 (LOAD_LIBRARY_SEARCH_SYSTEM32) applies
  // to statically-linked imports, and /MT removes the plantable CRT DLLs altogether. Both are set by
  // compileSetupBootstrap in scripts/build-windows-portable-setup.mjs.
  (void)SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  (void)SetDllDirectoryW(L"");

  // SECURITY INVARIANT 1: the closed argument allowlist, enforced before any side effect.
  int quiet = 0;
  int bad_argument_index = 0;
  if (!keiko_scan_arguments(argc, argv, &quiet, &bad_argument_index)) {
    // The rejected VALUE is never echoed — see keiko_scan_arguments. Position plus the closed
    // allowlist is everything an operator needs to correct the invocation.
    fwprintf(stderr,
             L"Keiko setup: unsupported argument at position %d. Supported arguments: /quiet, /Q.\n",
             bad_argument_index);
    return KEIKO_EXIT_BAD_ARGUMENT;
  }

  keiko_setup_buffers *buffers = keiko_allocate_buffers();
  if (buffers == NULL) {
    fwprintf(stderr, L"Keiko setup could not allocate working memory.\n");
    return KEIKO_EXIT_STAGING;
  }
  int exit_code = keiko_run_setup(buffers);
  if (exit_code != KEIKO_EXIT_OK) {
    (void)keiko_cleanup_staging(buffers);
    // One consistent failure trailer after the specific step reason above, so a scripted (/quiet)
    // install and a human both get an unambiguous "setup failed" signal — the wording the retired
    // batch installer emitted, and the signal the Windows setup smoke asserts.
    fwprintf(stderr, L"Keiko setup failed. See the message above.\n");
  }
  keiko_free_buffers(buffers);
  keiko_pace_after(exit_code, quiet);
  return exit_code;
}
