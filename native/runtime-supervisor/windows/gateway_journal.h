/* Private broker recovery records. Never publish these bytes in activity/support evidence.
 * The service owns the registry root and its SYSTEM/service-only write ACL. Callers must verify
 * that root before using this API; a user-writable journal is not an authority source. */
#ifndef KEIKO_GATEWAY_JOURNAL_H
#define KEIKO_GATEWAY_JOURNAL_H

#include "gateway_wfp.h"

#define KEIKO_GATEWAY_RECORD_BYTES 320u
#define KEIKO_GATEWAY_JOURNAL_MAX_RECORDS 256u

struct keiko_gateway_record {
  /* Same opaque recovery handle as the native Job Object protocol, never a caller-supplied path. */
  char recovery_handle[33];
  DWORD client_pid;
  FILETIME client_created;
  BYTE owner[SECURITY_MAX_SID_SIZE];
  DWORD owner_bytes;
  BYTE package[SECURITY_MAX_SID_SIZE];
  DWORD package_bytes;
  struct keiko_gateway_guard_keys keys;
  BYTE tree_binding[32];
  BYTE policy_digest[32];
};

DWORD keiko_gateway_record_encode(const struct keiko_gateway_record *record,
                                  BYTE bytes[KEIKO_GATEWAY_RECORD_BYTES]);
DWORD keiko_gateway_record_decode(const BYTE *bytes, DWORD size,
                                  struct keiko_gateway_record *record);

/* CREATE_NEW semantics. A replay never replaces a record. Success means RegFlushKey completed
 * before the caller may change WFP or loopback exemptions. A failed write must not launch a tree. */
DWORD keiko_gateway_journal_create(HKEY root, const struct keiko_gateway_record *record);
DWORD keiko_gateway_journal_read(HKEY root, const char *recovery_handle,
                                 struct keiko_gateway_record *record);
/* Call only after independently proving tree reaping, exemption removal and filter removal.
 * Idempotent deletion still flushes the root; a missing value is never a launch authorization. */
DWORD keiko_gateway_journal_remove(HKEY root, const char *recovery_handle);

#endif
