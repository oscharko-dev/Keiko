// Behaviour test for keiko-setup-bootstrap.c. Compiled and executed by
// scripts/check-windows-native-quality.ps1 with the same /W4 /WX /analyze bar and the same baked
// KEIKO_SETUP_* dummy defines as the product build. It includes the product translation unit with
// the product entry renamed out of the way, then asserts the pure decision helpers directly — the
// parts that must be right for the security invariants to hold, without a real file or process.

#include <assert.h>
#include <string.h>
#include <wchar.h>

#define wmain keiko_setup_bootstrap_product_main
#include "keiko-setup-bootstrap.c"
#undef wmain

static void write_u16(unsigned char *buffer, size_t offset, uint16_t value) {
  buffer[offset] = (unsigned char)(value & 0xff);
  buffer[offset + 1] = (unsigned char)((value >> 8) & 0xff);
}

static void write_u32(unsigned char *buffer, size_t offset, uint32_t value) {
  for (size_t index = 0; index < 4; index++) {
    buffer[offset + index] = (unsigned char)((value >> (8 * index)) & 0xff);
  }
}

static void write_u64(unsigned char *buffer, size_t offset, uint64_t value) {
  for (size_t index = 0; index < 8; index++) {
    buffer[offset + index] = (unsigned char)((value >> (8 * index)) & 0xff);
  }
}

// Lays out a minimal-but-valid PE32+ header into `buffer` and returns the computed overlay start
// (max of SizeOfHeaders and the single section's PointerToRawData + SizeOfRawData).
static uint64_t make_pe(unsigned char *buffer, size_t buffer_len, uint16_t magic,
                        uint16_t optional_header_size, uint32_t certificate_offset,
                        uint32_t certificate_size) {
  memset(buffer, 0, buffer_len);
  const size_t pe_offset = 0x40;
  buffer[0] = 'M';
  buffer[1] = 'Z';
  write_u32(buffer, DOS_E_LFANEW_OFFSET, (uint32_t)pe_offset);
  memcpy(buffer + pe_offset, KEIKO_PE_SIGNATURE, PE_SIGNATURE_BYTES);
  const size_t coff = pe_offset + PE_SIGNATURE_BYTES;
  write_u16(buffer, coff + COFF_NUMBER_OF_SECTIONS_OFFSET, 1);
  write_u16(buffer, coff + COFF_SIZE_OF_OPTIONAL_HEADER_OFFSET, optional_header_size);
  const size_t opt = coff + COFF_HEADER_BYTES;
  write_u16(buffer, opt, magic);
  write_u32(buffer, opt + OPTIONAL_HEADER_SIZE_OF_HEADERS_OFFSET, 0x200);
  const size_t directory = opt + OPTIONAL_HEADER_DATA_DIRECTORY_OFFSET +
                           (size_t)KEIKO_SECURITY_DIR_INDEX * DATA_DIRECTORY_ENTRY_BYTES;
  write_u32(buffer, directory, certificate_offset);
  write_u32(buffer, directory + 4, certificate_size);
  const size_t section_table = opt + optional_header_size;
  write_u32(buffer, section_table + SECTION_SIZE_OF_RAW_DATA_OFFSET, 0x200);
  write_u32(buffer, section_table + SECTION_POINTER_TO_RAW_DATA_OFFSET, 0x400);
  (void)buffer_len;
  return 0x600; // max(0x200 SizeOfHeaders, 0x400 + 0x200)
}

static void test_argument_allowlist(void) {
  assert(keiko_argument_allowed(L"/quiet") == 1);
  assert(keiko_argument_allowed(L"/Q") == 1);
  assert(keiko_argument_allowed(L"/qUIet") == 1);
  assert(keiko_argument_allowed(L"/q") == 1);
  const wchar_t *rejected[] = {L"/C:calc.exe", L"/c:x",   L"/C",          L"/T:x", L"/D",
                               L"--quiet",     L"-q",     L"quiet",       L"",     L"/quiet:extra",
                               L"/Q2",         L"/quiet "};
  for (size_t index = 0; index < sizeof(rejected) / sizeof(rejected[0]); index++) {
    assert(keiko_argument_allowed(rejected[index]) == 0);
  }

  int quiet = -1;
  int bad_index = -1;
  wchar_t program[] = L"setup.exe";
  wchar_t quiet_flag[] = L"/quiet";
  wchar_t q_flag[] = L"/Q";
  wchar_t bad_flag[] = L"/C:x";
  // A rejected argument that carries a secret. The scanner must report only WHERE it was, so no
  // code path can ever hand this text to a diagnostic (the body-free contract, AGENTS.md §8).
  wchar_t secret_flag[] = L"/token=SUPER_SECRET_VALUE";
  wchar_t *only_program[] = {program};
  wchar_t *with_quiet[] = {program, quiet_flag};
  wchar_t *with_both[] = {program, q_flag, quiet_flag};
  wchar_t *with_bad[] = {program, bad_flag};
  wchar_t *quiet_then_bad[] = {program, quiet_flag, bad_flag};
  wchar_t *with_secret[] = {program, secret_flag};

  assert(keiko_scan_arguments(1, only_program, &quiet, &bad_index) == 1 && quiet == 0 &&
         bad_index == 0);
  assert(keiko_scan_arguments(2, with_quiet, &quiet, &bad_index) == 1 && quiet == 1);
  assert(keiko_scan_arguments(3, with_both, &quiet, &bad_index) == 1 && quiet == 1);
  // The rejection reports the POSITION of the offending argument, never a pointer to its text.
  assert(keiko_scan_arguments(2, with_bad, &quiet, &bad_index) == 0 && bad_index == 1);
  assert(keiko_scan_arguments(3, quiet_then_bad, &quiet, &bad_index) == 0 && bad_index == 2);
  assert(keiko_scan_arguments(2, with_secret, &quiet, &bad_index) == 0 && bad_index == 1);
}

static void test_overlay_bounds(void) {
  unsigned char buffer[0x1000];
  keiko_overlay_bounds bounds;

  // Happy: PE32+, no certificate table -> overlay_end is the file size.
  uint64_t start = make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0, 0);
  assert(start == 0x600);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x740, &bounds) == 1);
  assert(bounds.overlay_start == 0x600 && bounds.overlay_end == 0x740);

  // Certificate table present -> overlay_end is its file offset (payload precedes it).
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0x700, 0x40);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x800, &bounds) == 1);
  assert(bounds.overlay_start == 0x600 && bounds.overlay_end == 0x700);

  // PE32 (32-bit) is explicitly unsupported.
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32, 0xF0, 0, 0);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x740, &bounds) == 0);

  // Optional header too small to carry a certificate-table directory.
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 100, 0, 0);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x740, &bounds) == 0);

  // Section data extends past the end of the file.
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0, 0);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x400, &bounds) == 0);

  // Certificate offset before the overlay start is rejected.
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0x100, 0x40);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x800, &bounds) == 0);

  // Certificate offset beyond the file length is rejected (both directions of the bounds check).
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0x900, 0x40);
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x800, &bounds) == 0);

  // Missing MZ, and a truncated scan window, both fail.
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0, 0);
  buffer[0] = 'X';
  assert(keiko_parse_overlay_bounds(buffer, sizeof(buffer), 0x740, &bounds) == 0);
  (void)make_pe(buffer, sizeof(buffer), OPTIONAL_HEADER_MAGIC_PE32_PLUS, 0xF0, 0, 0);
  assert(keiko_parse_overlay_bounds(buffer, 0x40, 0x740, &bounds) == 0);
}

static void test_payload_region(void) {
  uint64_t payload_start = 0;
  uint64_t padding = 0;
  // Exact fit, no padding.
  assert(keiko_payload_region(0x600, 0x740, 0x100, &payload_start, &padding) == 1);
  assert(payload_start == 0x640 && padding == 0);
  // Up to 7 alignment padding bytes are allowed.
  assert(keiko_payload_region(0x600, 0x747, 0x100, &payload_start, &padding) == 1 && padding == 7);
  // 8 bytes of trailing "padding" is unaccounted data.
  assert(keiko_payload_region(0x600, 0x748, 0x100, &payload_start, &padding) == 0);
  // Payload larger than the overlay region does not fit.
  assert(keiko_payload_region(0x600, 0x700, 0x100, &payload_start, &padding) == 0);

  unsigned char zeros[7] = {0, 0, 0, 0, 0, 0, 0};
  unsigned char dirty[7] = {0, 0, 0, 1, 0, 0, 0};
  assert(keiko_all_zero(zeros, sizeof(zeros)) == 1);
  assert(keiko_all_zero(dirty, sizeof(dirty)) == 0);
}

static void test_overlay_header(void) {
  unsigned char header[KEIKO_OVERLAY_HEADER_BYTES];
  memset(header, 0, sizeof(header));
  memcpy(header, KEIKO_OVERLAY_MAGIC, OVERLAY_MAGIC_BYTES);
  write_u64(header, OVERLAY_SIZE_OFFSET, 0x1234);
  for (size_t index = 0; index < KEIKO_SHA256_BYTES; index++) {
    header[OVERLAY_DIGEST_OFFSET + index] = (unsigned char)index;
  }
  uint64_t payload_size = 0;
  char hex[KEIKO_SHA256_HEX_CHARS + 1];
  assert(keiko_validate_overlay_header(header, &payload_size, hex) == 1);
  assert(payload_size == 0x1234);
  assert(strcmp(hex, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f") == 0);

  header[0] = 'X'; // wrong magic
  assert(keiko_validate_overlay_header(header, &payload_size, hex) == 0);
  memcpy(header, KEIKO_OVERLAY_MAGIC, OVERLAY_MAGIC_BYTES);
  header[OVERLAY_RESERVED_OFFSET] = 1; // reserved bytes must be zero
  assert(keiko_validate_overlay_header(header, &payload_size, hex) == 0);
}

static void test_hex_helpers(void) {
  unsigned char bytes[2] = {0xab, 0xcd};
  char hex[5];
  keiko_bytes_to_hex(bytes, 2, hex);
  assert(strcmp(hex, "abcd") == 0);

  const char *a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const char *same = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const char *upper = "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef";
  const char *off = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde0";
  assert(keiko_hex_equal(a, same) == 1);
  assert(keiko_hex_equal(a, upper) == 1); // case-insensitive
  assert(keiko_hex_equal(a, off) == 0);
}

static void test_managed_root_parse(void) {
  // Static, not stack: KEIKO_PATH_CAP is 64 KiB and `/analyze` (C6262) rejects a stack frame
  // that large. The harness is single-threaded and each case fully overwrites the buffer.
  static wchar_t out[KEIKO_PATH_CAP];
  const char *plain = "C:\\Keiko\\managed";
  assert(keiko_parse_managed_root(plain, (int)strlen(plain), out, KEIKO_PATH_CAP) == 1);
  assert(wcscmp(out, L"C:\\Keiko\\managed") == 0);

  const char *crlf = "C:\\Keiko\\managed\r\ntrailing";
  assert(keiko_parse_managed_root(crlf, (int)strlen(crlf), out, KEIKO_PATH_CAP) == 1);
  assert(wcscmp(out, L"C:\\Keiko\\managed") == 0);

  const char *unicode = "C:\\K\xc3\xa9iko"; // "C:\Kéiko" in UTF-8
  assert(keiko_parse_managed_root(unicode, (int)strlen(unicode), out, KEIKO_PATH_CAP) == 1);

  const char *control = "C:\\a\x01."; // embedded control character
  assert(keiko_parse_managed_root(control, (int)strlen(control), out, KEIKO_PATH_CAP) == 0);
  const char *relative = "keiko";
  assert(keiko_parse_managed_root(relative, (int)strlen(relative), out, KEIKO_PATH_CAP) == 0);
  const char *empty = "";
  assert(keiko_parse_managed_root(empty, 0, out, KEIKO_PATH_CAP) == 0);

  // A trailing backslash would escape the closing CLI quote; the drive-root boundary value is the
  // shortest example, and an embedded quote breaks the quoting outright — all rejected.
  const char *trailing = "C:\\Keiko\\";
  assert(keiko_parse_managed_root(trailing, (int)strlen(trailing), out, KEIKO_PATH_CAP) == 0);
  const char *drive_root = "C:\\";
  assert(keiko_parse_managed_root(drive_root, (int)strlen(drive_root), out, KEIKO_PATH_CAP) == 0);
  const char *quoted = "C:\\a\"b";
  assert(keiko_parse_managed_root(quoted, (int)strlen(quoted), out, KEIKO_PATH_CAP) == 0);
}

static void test_staging_name(void) {
  // Static, not stack: KEIKO_PATH_CAP is 64 KiB and `/analyze` (C6262) rejects a stack frame
  // that large. The harness is single-threaded and each case fully overwrites the buffer.
  static wchar_t out[KEIKO_PATH_CAP];
  unsigned char random16[16];
  for (size_t index = 0; index < 16; index++) {
    random16[index] = (unsigned char)index;
  }
  assert(keiko_build_staging_name(out, KEIKO_PATH_CAP, L"C:\\Temp\\", random16) == 1);
  assert(wcscmp(out, L"C:\\Temp\\Keiko-install-000102030405060708090a0b0c0d0e0f") == 0);
}

// The staging tree is npm's node_modules, which nests far past MAX_PATH. Cleanup therefore runs
// against the extended-length spelling of the staging root; if this rewrite were wrong, a successful
// install would end in exit 19 ("temporary files could not be removed") on every deep tree.
static void test_extended_path(void) {
  // Static, not stack: KEIKO_PATH_CAP is 64 KiB and `/analyze` (C6262) rejects a stack frame
  // that large. The harness is single-threaded and each case fully overwrites the buffer.
  static wchar_t out[KEIKO_PATH_CAP];

  assert(keiko_extended_path(L"C:\\Temp\\Keiko-install-00", out, KEIKO_PATH_CAP) == 1);
  assert(wcscmp(out, L"\\\\?\\C:\\Temp\\Keiko-install-00") == 0);

  // A UNC temp directory takes the \\?\UNC\ spelling, NOT a doubled backslash run.
  assert(keiko_extended_path(L"\\\\server\\share\\tmp", out, KEIKO_PATH_CAP) == 1);
  assert(wcscmp(out, L"\\\\?\\UNC\\server\\share\\tmp") == 0);

  // Already extended: copied through untouched, never double-prefixed.
  assert(keiko_extended_path(L"\\\\?\\C:\\Temp", out, KEIKO_PATH_CAP) == 1);
  assert(wcscmp(out, L"\\\\?\\C:\\Temp") == 0);

  // A capacity too small for the prefixed path is a FAILURE, not a silent truncation. This is the
  // only branch that keeps cleanup from ever walking a SHORTENED path, so it is pinned explicitly:
  // _snwprintf_s with _TRUNCATE returns -1 here, keiko_extended_path returns 0, and
  // keiko_cleanup_staging reports exit 19 instead of deleting the wrong tree.
  wchar_t tiny[8];
  assert(keiko_extended_path(L"C:\\Temp\\Keiko-install-00", tiny, 8) == 0);
}

// ---------------------------------------------------------------------------------------------
// BEHAVIOURAL tests against real Win32 objects (review 3887051417: everything added to the product
// file in the previous round was pure-logic-tested only, while the parts that had actually shipped
// a hang — the drain loop — were exercised by nothing). These use real anonymous pipes, a real
// temp directory tree, a real junction and real child processes. No admin rights are required:
// creating a directory junction needs none, only a symlink would.
// ---------------------------------------------------------------------------------------------

static void make_temp_dir(wchar_t *out, size_t cap, const wchar_t *tag) {
  wchar_t base[MAX_PATH];
  DWORD n = GetTempPathW(MAX_PATH, base);
  assert(n > 0 && n < MAX_PATH);
  unsigned char random16[16];
  assert(BCryptGenRandom(NULL, random16, sizeof(random16), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
  char hex[33];
  keiko_bytes_to_hex(random16, 16, hex);
  wchar_t hex_wide[33];
  for (size_t index = 0; index < (size_t)33; index++) {
    hex_wide[index] = (wchar_t)hex[index];
  }
  assert(_snwprintf_s(out, cap, _TRUNCATE, L"%ls%ls-%ls", base, tag, hex_wide) > 0);
  assert(CreateDirectoryW(out, NULL) != 0);
}

static void write_file(const wchar_t *path, const char *contents) {
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                            NULL);
  assert(file != INVALID_HANDLE_VALUE);
  DWORD written = 0;
  assert(WriteFile(file, contents, (DWORD)strlen(contents), &written, NULL) != 0);
  (void)CloseHandle(file);
}

static int run_and_wait_with_confirmed_cleanup(const wchar_t *application,
                                               wchar_t *command_line) {
  int staging_cleanup_permitted = 1;
  int ok = keiko_run_and_wait(application, command_line, &staging_cleanup_permitted);
  assert(staging_cleanup_permitted == 1);
  return ok;
}

// The drain loop must return promptly when the writer closes, and must capture what was written.
static void test_drain_pipe_reads_and_ends_at_eof(void) {
  SECURITY_ATTRIBUTES attributes;
  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = FALSE;
  HANDLE read_end = NULL;
  HANDLE write_end = NULL;
  assert(CreatePipe(&read_end, &write_end, &attributes, 0) != 0);

  const char *payload = "C:\\Managed\\Root\n";
  DWORD written = 0;
  assert(WriteFile(write_end, payload, (DWORD)strlen(payload), &written, NULL) != 0);
  (void)CloseHandle(write_end); // EOF for the reader

  char out[256];
  // GetCurrentProcess() is a live handle that never signals, so the loop's exit here is EOF —
  // proving the PeekNamedPipe/EOF branch, not the process-exit branch.
  int total = keiko_drain_pipe(read_end, GetCurrentProcess(), out, (int)sizeof(out));
  out[total] = '\0';
  assert(total == (int)strlen(payload));
  assert(strcmp(out, payload) == 0);
  (void)CloseHandle(read_end);
}

typedef struct {
  HANDLE write_end;
  const char *payload;
  DWORD length;
} keiko_flood_writer_args;

// Runs the flood WriteFile on its own thread, concurrently with the main thread's
// keiko_drain_pipe call, so the test's correctness never depends on CreatePipe's nSize actually
// being honoured by the OS (MSDN: "the actual size chosen by the operating system may differ from
// the suggested size" — a suggestion, not a guarantee). A single-threaded write ahead of the first
// read would deadlock on whatever buffer the OS in fact allocated; a concurrent writer cannot,
// because keiko_drain_pipe is always draining while bytes remain unread.
static DWORD WINAPI keiko_flood_writer_thread(LPVOID parameter) {
  keiko_flood_writer_args *args = (keiko_flood_writer_args *)parameter;
  DWORD written = 0;
  BOOL ok = WriteFile(args->write_end, args->payload, args->length, &written, NULL);
  (void)CloseHandle(args->write_end); // EOF for the reader once the flood is fully written
  return ok && written == args->length ? 0 : 1;
}

// Output past the cap must keep draining (so the child never blocks on a full pipe) while the
// captured prefix stays exactly cap-1 bytes.
static void test_drain_pipe_drains_past_the_cap(void) {
  SECURITY_ATTRIBUTES attributes;
  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = FALSE;
  HANDLE read_end = NULL;
  HANDLE write_end = NULL;
  // Default OS buffer size: no longer load-bearing (see keiko_flood_writer_thread) now that the
  // write runs concurrently with the read instead of entirely ahead of it.
  assert(CreatePipe(&read_end, &write_end, &attributes, 0) != 0);

  char flood[4096];
  memset(flood, 'x', sizeof(flood));
  keiko_flood_writer_args writer_args;
  writer_args.write_end = write_end;
  writer_args.payload = flood;
  writer_args.length = (DWORD)sizeof(flood);
  HANDLE writer = CreateThread(NULL, 0, keiko_flood_writer_thread, &writer_args, 0, NULL);
  assert(writer != NULL);

  char out[64];
  int total = keiko_drain_pipe(read_end, GetCurrentProcess(), out, (int)sizeof(out));
  assert(total == (int)sizeof(out) - 1); // captured exactly cap-1, the rest discarded not blocked

  assert(WaitForSingleObject(writer, KEIKO_CHILD_EXIT_GRACE_MS) == WAIT_OBJECT_0);
  DWORD writer_exit = 1;
  assert(GetExitCodeThread(writer, &writer_exit) != 0 && writer_exit == 0);
  (void)CloseHandle(writer);
  (void)CloseHandle(read_end);
}

// A junction inside the staging tree must be UNLINKED, never followed: the target's contents have
// to survive the cleanup that removes the staging root. This is the race/traversal class from
// review 3887021643 in its observable form.
static void test_remove_tree_unlinks_junctions_without_following(void) {
  wchar_t staging[MAX_PATH];
  wchar_t outside[MAX_PATH];
  make_temp_dir(staging, MAX_PATH, L"keiko-test-staging");
  make_temp_dir(outside, MAX_PATH, L"keiko-test-outside");

  wchar_t treasure[MAX_PATH];
  assert(_snwprintf_s(treasure, MAX_PATH, _TRUNCATE, L"%ls\\treasure.txt", outside) > 0);
  write_file(treasure, "must survive");

  // A real file inside staging, so the walk has ordinary work to do as well.
  wchar_t inner[MAX_PATH];
  assert(_snwprintf_s(inner, MAX_PATH, _TRUNCATE, L"%ls\\inner.txt", staging) > 0);
  write_file(inner, "disposable");

  // A plain NESTED subdirectory with its own content. Without this, staging holds only a file and a
  // junction directly under the root, so keiko_delete_entry's recursive branch
  // (`(attributes & FILE_ATTRIBUTE_DIRECTORY) != 0` with no reparse bit -> keiko_remove_tree(child))
  // is never taken and keiko_open_plain_dir_no_follow is only ever exercised on the root — the
  // per-level no-follow handle one level down is dead code as far as this test is concerned. Nesting
  // one real subdirectory forces the recursion, and the final "staging gone" assertion below can
  // only hold if RemoveDirectoryW(staging) actually saw an EMPTY directory, which requires this
  // subtree to have been walked and removed first.
  wchar_t nested_dir[MAX_PATH];
  assert(_snwprintf_s(nested_dir, MAX_PATH, _TRUNCATE, L"%ls\\nested", staging) > 0);
  assert(CreateDirectoryW(nested_dir, NULL) != 0);
  wchar_t nested_inner[MAX_PATH];
  assert(_snwprintf_s(nested_inner, MAX_PATH, _TRUNCATE, L"%ls\\nested-inner.txt", nested_dir) > 0);
  write_file(nested_inner, "disposable-nested");

  // mklink /J needs no elevation. cmd.exe is resolved from the system directory, never PATH.
  wchar_t link[MAX_PATH];
  assert(_snwprintf_s(link, MAX_PATH, _TRUNCATE, L"%ls\\link", staging) > 0);
  wchar_t system_dir[MAX_PATH];
  assert(GetSystemDirectoryW(system_dir, MAX_PATH) != 0);
  wchar_t cmd_exe[MAX_PATH];
  assert(_snwprintf_s(cmd_exe, MAX_PATH, _TRUNCATE, L"%ls\\cmd.exe", system_dir) > 0);
  // static: KEIKO_COMMAND_CAP is 96 KiB of wchar_t (192 KiB) — far past /analyze's C6262
  // stack budget. Single-threaded harness, each case fully rewrites it.
  static wchar_t command[KEIKO_COMMAND_CAP];
  assert(_snwprintf_s(command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" /d /s /c mklink /J \"%ls\" \"%ls\"", cmd_exe, link, outside) > 0);
  assert(run_and_wait_with_confirmed_cleanup(cmd_exe, command) == 1);
  // GetFileAttributesW returns INVALID_FILE_ATTRIBUTES (0xFFFFFFFF) on failure, and that all-ones
  // value ANDed with FILE_ATTRIBUTE_REPARSE_POINT is itself nonzero — so a bare `&` check here would
  // pass even if mklink silently produced no junction at all. Check existence first, explicitly.
  DWORD link_attributes = GetFileAttributesW(link);
  assert(link_attributes != INVALID_FILE_ATTRIBUTES);
  assert((link_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0);

  assert(keiko_remove_tree(staging) == 1);
  assert(GetFileAttributesW(staging) == INVALID_FILE_ATTRIBUTES); // staging gone
  assert(GetFileAttributesW(treasure) != INVALID_FILE_ATTRIBUTES); // target UNTOUCHED
  assert(GetFileAttributesW(outside) != INVALID_FILE_ATTRIBUTES);

  (void)DeleteFileW(treasure);
  (void)RemoveDirectoryW(outside);
}

// keiko_remove_tree must FAIL CLOSED when handed a junction as its root, rather than deleting
// through it. (keiko_open_plain_dir_no_follow rejects the reparse point on the handle itself.)
static void test_remove_tree_refuses_a_junction_root(void) {
  wchar_t holder[MAX_PATH];
  wchar_t outside[MAX_PATH];
  make_temp_dir(holder, MAX_PATH, L"keiko-test-holder");
  make_temp_dir(outside, MAX_PATH, L"keiko-test-target");

  wchar_t treasure[MAX_PATH];
  assert(_snwprintf_s(treasure, MAX_PATH, _TRUNCATE, L"%ls\\treasure.txt", outside) > 0);
  write_file(treasure, "must survive");

  wchar_t link[MAX_PATH];
  assert(_snwprintf_s(link, MAX_PATH, _TRUNCATE, L"%ls\\link", holder) > 0);
  wchar_t system_dir[MAX_PATH];
  assert(GetSystemDirectoryW(system_dir, MAX_PATH) != 0);
  wchar_t cmd_exe[MAX_PATH];
  assert(_snwprintf_s(cmd_exe, MAX_PATH, _TRUNCATE, L"%ls\\cmd.exe", system_dir) > 0);
  // static: KEIKO_COMMAND_CAP is 96 KiB of wchar_t (192 KiB) — far past /analyze's C6262
  // stack budget. Single-threaded harness, each case fully rewrites it.
  static wchar_t command[KEIKO_COMMAND_CAP];
  assert(_snwprintf_s(command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" /d /s /c mklink /J \"%ls\" \"%ls\"", cmd_exe, link, outside) > 0);
  assert(run_and_wait_with_confirmed_cleanup(cmd_exe, command) == 1);

  // Handed the LINK as the root: refuse rather than descend.
  assert(keiko_remove_tree(link) == 0);
  assert(GetFileAttributesW(treasure) != INVALID_FILE_ATTRIBUTES);

  (void)RemoveDirectoryW(link);
  (void)RemoveDirectoryW(holder);
  (void)DeleteFileW(treasure);
  (void)RemoveDirectoryW(outside);
}

// The watchdog must terminate the child's WHOLE tree: a wedged CLI that already spawned a
// descendant must not leave that descendant running (review 3887021654).
static void test_watchdog_terminates_the_descendant_tree(void) {
  wchar_t system_dir[MAX_PATH];
  assert(GetSystemDirectoryW(system_dir, MAX_PATH) != 0);
  wchar_t cmd_exe[MAX_PATH];
  assert(_snwprintf_s(cmd_exe, MAX_PATH, _TRUNCATE, L"%ls\\cmd.exe", system_dir) > 0);

  // The outer cmd starts a DETACHED grandchild that would outlive a single-process kill, then
  // hangs — both processes are alive when the watchdog fires.
  // static: KEIKO_COMMAND_CAP is 96 KiB of wchar_t (192 KiB) — far past /analyze's C6262
  // stack budget. Single-threaded harness, each case fully rewrites it.
  static wchar_t command[KEIKO_COMMAND_CAP];
  // `ping -n` is the portable Windows sleep: present on every image, unlike `waitfor.exe`/`timeout`.
  assert(_snwprintf_s(command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" /d /s /c start /b \"\" \"%ls\" /d /s /c ping -n 120 127.0.0.1 "
                      L"> nul & ping -n 120 127.0.0.1 > nul",
                      cmd_exe, cmd_exe) > 0);

  STARTUPINFOW startup;
  keiko_child child;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  assert(keiko_spawn_in_job(cmd_exe, command, &startup, FALSE, &child) == 1);
  assert(child.job != NULL); // the Job Object is what binds the tree

  // Let the grandchild come up, then fire the watchdog with a short deadline. Polled, not a fixed
  // Sleep: process-creation latency through two nested cmd.exe launches is not bounded on a loaded
  // CI runner, and a single fixed sleep either wastes time or — worse — under-waits and makes the
  // ActiveProcesses assertion flaky. Bounded at 15s, far under the 20-minute product watchdog, so a
  // genuine failure to spawn the tree still fails the test instead of hanging it.
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION before;
  ZeroMemory(&before, sizeof(before));
  DWORD returned = 0;
  ULONGLONG poll_deadline = GetTickCount64() + 15000;
  for (;;) {
    assert(QueryInformationJobObject(child.job, JobObjectBasicAccountingInformation, &before,
                                     sizeof(before), &returned) != 0);
    if (before.ActiveProcesses >= 2 || GetTickCount64() >= poll_deadline) {
      break;
    }
    Sleep(100);
  }
  assert(before.ActiveProcesses >= 2); // the tree really is a tree

  int staging_cleanup_permitted = 1;
  assert(keiko_wait_or_terminate(&child, 200, &staging_cleanup_permitted) == 0);
  assert(staging_cleanup_permitted == 1); // zero active processes was positively observed

  // This assertion is a direct proof of keiko_terminate_child_tree's own bounded
  // ActiveProcesses==0 poll, not a hopeful immediate check: TerminateProcess/TerminateJobObject are
  // documented asynchronous, so without that internal wait this Query could race a descendant that
  // requested-but-not-yet-finished exiting and observe it as still active. keiko_wait_or_terminate
  // has already returned by the time control reaches here, so if the assertion below holds, the
  // production helper itself — not this test's timing — is what established the zero.
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION after;
  ZeroMemory(&after, sizeof(after));
  assert(QueryInformationJobObject(child.job, JobObjectBasicAccountingInformation, &after,
                                   sizeof(after), &returned) != 0);
  assert(after.ActiveProcesses == 0); // NO descendant survived the watchdog
  keiko_close_child(&child);
}

static void test_job_reap_helpers_fail_closed(void) {
  // An observation failure is not an empty job. This is the exact branch that previously broke
  // out of the reap loop and released containment.
  assert(keiko_probe_job(INVALID_HANDLE_VALUE) == KEIKO_JOB_PROBE_FAILED);

  HANDLE job = CreateJobObjectW(NULL, NULL);
  assert(job != NULL);
  assert(keiko_probe_job(job) == KEIKO_JOB_PROBE_EMPTY);
  assert(keiko_arm_job_kill_on_close(job) != 0);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  assert(QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits),
                                   NULL) != 0);
  assert((limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0);
  assert(CloseHandle(job) != 0);
}

static int injected_terminate_job_calls = 0;
static int injected_probe_job_calls = 0;
static int injected_arm_kill_on_close_calls = 0;
static int injected_terminate_process_calls = 0;
static int injected_wait_process_calls = 0;

static int injected_terminate_job(HANDLE job) {
  (void)job;
  injected_terminate_job_calls++;
  return 1;
}

static keiko_job_probe injected_probe_job_failure(HANDLE job) {
  (void)job;
  injected_probe_job_calls++;
  return KEIKO_JOB_PROBE_FAILED;
}

static int injected_arm_kill_on_close_failure(HANDLE job) {
  (void)job;
  injected_arm_kill_on_close_calls++;
  return 0;
}

static void injected_no_sleep(DWORD milliseconds) {
  (void)milliseconds;
}

static void injected_terminate_process(HANDLE process) {
  (void)process;
  injected_terminate_process_calls++;
}

static void injected_wait_process(HANDLE process, DWORD milliseconds) {
  (void)process;
  (void)milliseconds;
  injected_wait_process_calls++;
}

static void reset_injected_termination_calls(void) {
  injected_terminate_job_calls = 0;
  injected_probe_job_calls = 0;
  injected_arm_kill_on_close_calls = 0;
  injected_terminate_process_calls = 0;
  injected_wait_process_calls = 0;
}

static void test_unconfirmed_job_reap_blocks_staging_cleanup(void) {
  reset_injected_termination_calls();
  keiko_setup_buffers *buffers = keiko_allocate_buffers();
  assert(buffers != NULL);
  assert(buffers->staging_cleanup_permitted == 1);
  make_temp_dir(buffers->staging_dir, KEIKO_PATH_CAP, L"keiko-test-reap-uncertain");
  wchar_t sentinel[MAX_PATH];
  assert(_snwprintf_s(sentinel, MAX_PATH, _TRUNCATE, L"%ls\\sentinel.txt",
                      buffers->staging_dir) > 0);
  write_file(sentinel, "must remain while descendant state is unknown");

  keiko_child child;
  ZeroMemory(&child, sizeof(child));
  child.job = (HANDLE)(uintptr_t)1;
  child.process.hProcess = (HANDLE)(uintptr_t)2;
  const keiko_child_termination_ops injected = {
      injected_terminate_job,
      injected_probe_job_failure,
      injected_arm_kill_on_close_failure,
      injected_no_sleep,
      injected_terminate_process,
      injected_wait_process,
  };

  assert(keiko_terminate_child_tree_with(&child, &buffers->staging_cleanup_permitted, &injected) ==
         KEIKO_JOB_REAP_UNCONFIRMED);
  assert(injected_terminate_job_calls == 1);
  assert(injected_probe_job_calls == 1);
  assert(injected_arm_kill_on_close_calls == 1);
  assert(injected_terminate_process_calls == 1);
  assert(injected_wait_process_calls == 1);
  assert(child.retain_job_handle == 1);
  assert(buffers->staging_cleanup_permitted == 0);

  // This is the load-bearing outcome: even the ordinary failure-path cleanup call cannot mutate
  // staging after both the job observation and kill-on-close backstop failed.
  assert(keiko_cleanup_staging(buffers) == 0);
  assert(GetFileAttributesW(sentinel) != INVALID_FILE_ATTRIBUTES);
  assert(GetFileAttributesW(buffers->staging_dir) != INVALID_FILE_ATTRIBUTES);

  (void)DeleteFileW(sentinel);
  (void)RemoveDirectoryW(buffers->staging_dir);
  keiko_free_buffers(buffers);
}

static void test_capture_reports_the_shared_wait_result(void) {
  wchar_t system_dir[MAX_PATH];
  assert(GetSystemDirectoryW(system_dir, MAX_PATH) != 0);
  wchar_t cmd_exe[MAX_PATH];
  assert(_snwprintf_s(cmd_exe, MAX_PATH, _TRUNCATE, L"%ls\\cmd.exe", system_dir) > 0);
  static wchar_t command[KEIKO_COMMAND_CAP];
  char output[128];
  int output_len = -1;
  int staging_cleanup_permitted = 1;

  assert(_snwprintf_s(command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" /d /s /c echo capture-contract", cmd_exe) > 0);
  assert(keiko_run_capture(cmd_exe, command, output, (int)sizeof(output), &output_len,
                           &staging_cleanup_permitted) == 1);
  assert(staging_cleanup_permitted == 1);
  assert(output_len > 0);
  assert(strstr(output, "capture-contract") != NULL);

  output_len = -1;
  assert(_snwprintf_s(command, KEIKO_COMMAND_CAP, _TRUNCATE,
                      L"\"%ls\" /d /s /c exit /b 7", cmd_exe) > 0);
  assert(keiko_run_capture(cmd_exe, command, output, (int)sizeof(output), &output_len,
                           &staging_cleanup_permitted) == 0);
  assert(staging_cleanup_permitted == 1);
  assert(output_len == 0);
}

int wmain(void) {
  keiko_setup_buffers *buffers = keiko_allocate_buffers();
  assert(buffers != NULL);
  assert(sizeof(buffers->command) / sizeof(buffers->command[0]) == (size_t)KEIKO_COMMAND_CAP);
  assert(buffers->staging_cleanup_permitted == 1);
  keiko_free_buffers(buffers);

  test_argument_allowlist();
  test_overlay_bounds();
  test_payload_region();
  test_overlay_header();
  test_hex_helpers();
  test_managed_root_parse();
  test_staging_name();
  test_extended_path();

  // Behavioural (real Win32 objects, see the block above).
  test_drain_pipe_reads_and_ends_at_eof();
  test_drain_pipe_drains_past_the_cap();
  test_remove_tree_unlinks_junctions_without_following();
  test_remove_tree_refuses_a_junction_root();
  test_watchdog_terminates_the_descendant_tree();
  test_job_reap_helpers_fail_closed();
  test_unconfirmed_job_reap_blocks_staging_cleanup();
  test_capture_reports_the_shared_wait_result();
  return 0;
}
