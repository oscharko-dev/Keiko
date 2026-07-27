/* Closed stdout-only carrier for the release qualification document. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "runtime_attestation_payload.h"

static int write_exact(const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    int written = _write(_fileno(stdout), bytes + offset, (unsigned int)(length - offset));
    if (written <= 0) return 0;
    offset += (size_t)written;
  }
  return 1;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2 || wcscmp(argv[1], L"--emit") != 0) return 2;
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 1;
  return write_exact(KEIKO_RUNTIME_ATTESTATION, KEIKO_RUNTIME_ATTESTATION_LENGTH) ? 0 : 1;
}
