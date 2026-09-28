/* Windows gateway confinement primitive. Not an availability claim: the installed broker and
 * AppContainer socket qualification must succeed before a production caller may resume a child.
 * Caller owns the per-tree SID and must kill/reap the tree BEFORE closing this dynamic session. */
#ifndef KEIKO_GATEWAY_WFP_H
#define KEIKO_GATEWAY_WFP_H

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <fwpmu.h>

struct keiko_gateway_filters {
  HANDLE engine;
  GUID sublayer;
  UINT64 ids[3];
  /* A durable deny guard outlives the process holding the dynamic gateway permit. */
  HANDLE guard_engine;
  HANDLE job;
  GUID guard_keys[2];
  int guard_installed;
};

/* family is AF_INET or AF_INET6; the only accepted destination is that family's loopback.
 * No caller-controlled address, filter action, executable identity or filter layer is accepted. */
DWORD keiko_gateway_filters_open(PSID package_sid, UINT16 family, UINT16 port,
                                struct keiko_gateway_filters *filters);
DWORD keiko_gateway_filters_close(struct keiko_gateway_filters *filters);

/* job must have KILL_ON_JOB_CLOSE and neither breakaway flag. The caller must not resume a
 * process until this succeeds. Closing with a live tree revokes the permit but retains both
 * durable denies and returns ERROR_BUSY. After reaping, retry close to remove the guard.
 * The caller keeps its own job handle; this object owns a duplicate. */
DWORD keiko_gateway_filters_open_guarded(PSID package_sid, UINT16 family, UINT16 port,
                                        HANDLE job, struct keiko_gateway_filters *filters);

/* Reopen only a previously recorded guard, after broker failure. This never creates a permit.
 * The supplied job must be the same owned tree recorded by the broker, not an arbitrary empty
 * job. The broker is responsible for authenticating its durable recovery record. */
DWORD keiko_gateway_filters_recover_guard(PSID package_sid, HANDLE job, const GUID *sublayer,
                                         const GUID keys[2], struct keiko_gateway_filters *filters);

#endif
