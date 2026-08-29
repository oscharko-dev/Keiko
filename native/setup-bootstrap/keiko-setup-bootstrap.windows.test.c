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
                           (size_t)IMAGE_DIRECTORY_ENTRY_SECURITY * DATA_DIRECTORY_ENTRY_BYTES;
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
  const wchar_t *bad = NULL;
  wchar_t program[] = L"setup.exe";
  wchar_t quiet_flag[] = L"/quiet";
  wchar_t q_flag[] = L"/Q";
  wchar_t bad_flag[] = L"/C:x";
  wchar_t *only_program[] = {program};
  wchar_t *with_quiet[] = {program, quiet_flag};
  wchar_t *with_both[] = {program, q_flag, quiet_flag};
  wchar_t *with_bad[] = {program, bad_flag};
  wchar_t *quiet_then_bad[] = {program, quiet_flag, bad_flag};

  assert(keiko_scan_arguments(1, only_program, &quiet, &bad) == 1 && quiet == 0 && bad == NULL);
  assert(keiko_scan_arguments(2, with_quiet, &quiet, &bad) == 1 && quiet == 1);
  assert(keiko_scan_arguments(3, with_both, &quiet, &bad) == 1 && quiet == 1);
  assert(keiko_scan_arguments(2, with_bad, &quiet, &bad) == 0 && bad == bad_flag);
  assert(keiko_scan_arguments(3, quiet_then_bad, &quiet, &bad) == 0 && bad == bad_flag);
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
  wchar_t out[KEIKO_PATH_CAP];
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
  wchar_t out[KEIKO_PATH_CAP];
  unsigned char random16[16];
  for (size_t index = 0; index < 16; index++) {
    random16[index] = (unsigned char)index;
  }
  assert(keiko_build_staging_name(out, KEIKO_PATH_CAP, L"C:\\Temp\\", random16) == 1);
  assert(wcscmp(out, L"C:\\Temp\\Keiko-install-000102030405060708090a0b0c0d0e0f") == 0);
}

int wmain(void) {
  keiko_setup_buffers *buffers = keiko_allocate_buffers();
  assert(buffers != NULL);
  assert(sizeof(buffers->command) / sizeof(buffers->command[0]) == (size_t)KEIKO_COMMAND_CAP);
  keiko_free_buffers(buffers);

  test_argument_allowlist();
  test_overlay_bounds();
  test_payload_region();
  test_overlay_header();
  test_hex_helpers();
  test_managed_root_parse();
  test_staging_name();
  return 0;
}
