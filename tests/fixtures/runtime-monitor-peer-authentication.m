#import <EndpointSecurity/EndpointSecurity.h>
#import <Security/Security.h>
#include <bsm/libbsm.h>
#include <os/log.h>
#include <mach/mach.h>
#include <poll.h>
#include <time.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static ssize_t inert_read(int descriptor, void *buffer, size_t length);
#define read inert_read
#include "protocol.h"
#undef read

static OSStatus (*const kernel_copy_guest)(SecCodeRef, CFDictionaryRef, SecCSFlags, SecCodeRef *) =
  SecCodeCopyGuestWithAttributes;
static unsigned numeric_checks, audit_checks, armed_replies, frame_reads;
static unsigned token_lookups, denial_events;
static size_t frame_offset;
static uint64_t simulated_ms;
static int partial_frame, empty_frame, readiness_delivered, interrupted_poll, clock_unavailable;
static int would_block;
static audit_token_t first_checked_token;
static unsigned checked_token_mismatches;
static unsigned identity_change;
static uint32_t current_version = 1;
static int alternate_team, code_unavailable;

static int inert_getsockopt(int descriptor, int level, int option, void *value,
                           socklen_t *length) {
  (void)descriptor;
  if (level != SOL_LOCAL) return -1;
  if (option == LOCAL_PEERPID && *length == sizeof(pid_t)) {
    *(pid_t *)value = 100;
    return 0;
  }
  if (option != LOCAL_PEERTOKEN || *length != sizeof(audit_token_t)) return -1;
  token_lookups++;
  audit_token_t token = {0};
  token.val[1] = 501;
  token.val[5] = 100;
  token.val[7] = current_version;
  memcpy(value, &token, sizeof(token));
  if (identity_change == 3) current_version++;
  return 0;
}
static int inert_getpeereid(int descriptor, uid_t *uid, gid_t *gid) {
  (void)descriptor;
  *uid = 501;
  *gid = 20;
  return 0;
}
static ssize_t inert_read(int descriptor, void *buffer, size_t length) {
  (void)descriptor;
  frame_reads++;
  if (empty_frame || frame_offset >= sizeof(struct keiko_monitor_request)) return 0;
  struct keiko_monitor_request request = {0};
  memcpy(request.magic, "KEM1", 4);
  request.version = KEIKO_MONITOR_VERSION;
  request.command = KEIKO_MONITOR_ARM;
  request.supervisor_pid = 100;
  memset(request.recovery_handle, 'a', sizeof(request.recovery_handle));
  size_t count = sizeof(request) - frame_offset;
  if (count > length) count = length;
  if (partial_frame) {
    count = 1;
    if (!readiness_delivered) simulated_ms += 4000;
    readiness_delivered = 0;
  }
  memcpy(buffer, (const unsigned char *)&request + frame_offset, count);
  frame_offset += count;
  if (identity_change == 1) { current_version++; code_unavailable = 1; }
  if (identity_change == 2) { current_version++; alternate_team = 1; }
  if (identity_change == 7) current_version++;
  return (ssize_t)count;
}
static __attribute__((unused)) ssize_t inert_recv(int descriptor, void *buffer, size_t length,
                                                 int flags) {
  if (flags != MSG_DONTWAIT) __builtin_trap();
  if (would_block) { would_block = 0; errno = EAGAIN; return -1; }
  return inert_read(descriptor, buffer, length);
}
static __attribute__((unused)) int inert_clock_gettime(clockid_t clock, struct timespec *value) {
  if (clock != CLOCK_MONOTONIC || clock_unavailable) return -1;
  value->tv_sec = (time_t)(simulated_ms / 1000);
  value->tv_nsec = (long)((simulated_ms % 1000) * 1000000);
  return 0;
}
static __attribute__((unused)) int inert_poll(struct pollfd *descriptors, nfds_t count, int timeout) {
  if (count != 1 || timeout <= 0) return -1;
  if (interrupted_poll) {
    interrupted_poll = 0; simulated_ms += 4000; errno = EINTR; return -1;
  }
  if (empty_frame || (partial_frame && timeout < 4000)) {
    simulated_ms += (uint64_t)timeout;
    return 0;
  }
  if (partial_frame) { simulated_ms += 4000; readiness_delivered = 1; }
  descriptors[0].revents = POLLIN;
  return 1;
}
static OSStatus inert_copy_self(SecCSFlags flags, SecCodeRef *code) {
  (void)flags;
  *code = (SecCodeRef)CFRetain(CFSTR("fixture-self"));
  return errSecSuccess;
}
static OSStatus inert_copy_guest(SecCodeRef host, CFDictionaryRef attributes,
                                SecCSFlags flags, SecCodeRef *guest) {
  (void)host;
  (void)flags;
  const void *value = CFDictionaryGetValue(attributes, kSecGuestAttributeAudit);
  if (value != NULL) {
    if (CFGetTypeID(value) != CFDataGetTypeID() || CFDataGetLength(value) != sizeof(audit_token_t))
      return errSecCSInvalidAttributeValues;
    audit_token_t token;
    memcpy(&token, CFDataGetBytePtr(value), sizeof(token));
    if (audit_checks++ == 0) first_checked_token = token;
    else if (memcmp(&first_checked_token, &token, sizeof(token)) != 0)
      checked_token_mismatches++;
    if (audit_token_to_pid(token) != 100 ||
        audit_token_to_pidversion(token) != (int)current_version || code_unavailable)
      return errSecCSNoSuchCode;
  } else {
    numeric_checks++;
    if (CFDictionaryGetValue(attributes, kSecGuestAttributePid) == NULL || code_unavailable)
      return errSecCSNoSuchCode;
  }
  *guest = (SecCodeRef)CFRetain(CFSTR("fixture-guest"));
  return errSecSuccess;
}
static OSStatus inert_signing_information(SecCodeRef code, SecCSFlags flags,
                                         CFDictionaryRef *information) {
  (void)flags;
  const void *keys[] = {kSecCodeInfoTeamIdentifier};
  const void *values[] = {alternate_team && CFEqual(code, CFSTR("fixture-guest"))
                           ? CFSTR("OTHERTEAM1") : CFSTR("TESTTEAM01")};
  *information = CFDictionaryCreate(NULL, keys, values, 1,
                                    &kCFTypeDictionaryKeyCallBacks,
                                    &kCFTypeDictionaryValueCallBacks);
  return errSecSuccess;
}
static OSStatus inert_check_validity(SecCodeRef code, SecCSFlags flags,
                                     SecRequirementRef requirement) {
  (void)code;
  (void)flags;
  (void)requirement;
  return errSecSuccess;
}
static ssize_t inert_send(int descriptor, const void *data, size_t size, int flags) {
  (void)descriptor;
  (void)flags;
  const struct keiko_monitor_reply *reply = data;
  if (size != sizeof(*reply)) return -1;
  if (reply->kind == KEIKO_MONITOR_ARMED) armed_replies++;
  return (ssize_t)size;
}
static int inert_close(int descriptor) { (void)descriptor; return 0; }
static void inert_log(const char *format, ...) {
  if (strstr(format, "rejected client connection") != NULL) denial_events++;
}
#undef os_log
#undef os_log_error
#define os_log(_handle, ...) inert_log(__VA_ARGS__)
#define os_log_error(_handle, ...) inert_log(__VA_ARGS__)
#define read inert_read
#define recv inert_recv
#define poll inert_poll
#define clock_gettime inert_clock_gettime
#define getsockopt inert_getsockopt
#define getpeereid inert_getpeereid
#define SecCodeCopySelf inert_copy_self
#define SecCodeCopyGuestWithAttributes inert_copy_guest
#define SecCodeCopySigningInformation inert_signing_information
#define SecCodeCheckValidity inert_check_validity
#define send inert_send
#define close inert_close
#define main keiko_fixture_unused_main
#include KEIKO_MONITOR_SOURCE
#undef main

static OSStatus locate_kernel_token(audit_token_t token) {
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  if (data == NULL) return errSecAllocate;
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {data};
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef guest = NULL;
  OSStatus status = attributes == NULL ? errSecAllocate :
    kernel_copy_guest(NULL, attributes, kSecCSDefaultFlags, &guest);
  if (guest != NULL) CFRelease(guest);
  if (attributes != NULL) CFRelease(attributes);
  CFRelease(data);
  return status;
}
static int kernel_code_identity(void) {
  audit_token_t token = {0};
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS)
    return 0;
  audit_token_t stale = token;
  stale.val[7] ^= 1u;
  return locate_kernel_token(token) == errSecSuccess &&
         locate_kernel_token(stale) != errSecSuccess &&
         locate_kernel_token(token) == errSecSuccess;
}

int main(int argc, char **argv) {
  (void)keiko_monitor_log;
  if (argc != 2) return 2;
  if (strcmp(argv[1], "kernel-code-identity") == 0) {
    int passed = kernel_code_identity();
    printf("{\"case\":\"kernel-code-identity\",\"passed\":%d}\n", passed);
    return passed ? 0 : 1;
  }
  if (strcmp(argv[1], "unsigned-reuse") == 0) identity_change = 1;
  else if (strcmp(argv[1], "foreign-team-reuse") == 0) identity_change = 2;
  else if (strcmp(argv[1], "stale-captured-token") == 0) identity_change = 3;
  else if (strcmp(argv[1], "same-team-reuse") == 0) identity_change = 7;
  else if (strcmp(argv[1], "interrupted-handshake") == 0) interrupted_poll = 1;
  else if (strcmp(argv[1], "would-block-handshake") == 0) would_block = 1;
  else if (strcmp(argv[1], "clock-unavailable") == 0) { identity_change = 8; clock_unavailable = 1; }
  else if (strcmp(argv[1], "trusted-trickle") == 0) { identity_change = 6; partial_frame = 1; }
  else if (strcmp(argv[1], "initial-invalid-incomplete") == 0) {
    identity_change = 4; code_unavailable = 1; empty_frame = 1;
  }
  else if (strcmp(argv[1], "initial-foreign-incomplete") == 0) {
    identity_change = 5; alternate_team = 1; empty_frame = 1;
  }
  else if (strcmp(argv[1], "initial-invalid-code") == 0) { identity_change = 4; code_unavailable = 1; }
  else if (strcmp(argv[1], "initial-foreign-team") == 0) { identity_change = 5; alternate_team = 1; }
  else if (strcmp(argv[1], "stable-audit-attributes") != 0 &&
           strcmp(argv[1], "healthy-stable-peer") != 0) return 2;
  endpoint_state = ENDPOINT_STATE_ACTIVE;
  event_sequence_initialized = 1;
  last_event_sequence = 17;
  connection_count = 1;
  int *descriptor = malloc(sizeof(*descriptor));
  if (descriptor == NULL) return 2;
  *descriptor = 77;
  serve_client(descriptor);
  unsigned active = 0;
  for (size_t index = 0; index < KEIKO_MAX_SESSIONS; ++index) active += !!sessions[index].active;
  unsigned passed = identity_change != 0 ? active == 0 && armed_replies == 0
                                        : active == 1 && armed_replies == 1;
  if (strcmp(argv[1], "stable-audit-attributes") == 0)
    passed = passed && audit_checks == 2 && numeric_checks == 0;
  if (identity_change == 4 || identity_change == 5) passed = passed && frame_reads == 0;
  if (partial_frame) passed = passed && simulated_ms <= 5000 && frame_reads <= 1;
  passed = passed && checked_token_mismatches == 0 && connection_count == 0;
  printf("{\"case\":\"%s\",\"passed\":%u,\"activeSessions\":%u,\"armedReplies\":%u,"
         "\"auditChecks\":%u,\"numericChecks\":%u,\"tokenLookups\":%u,\"denialEvents\":%u,\"frameReads\":%u,\"simulatedMs\":%llu,\"tokenMismatches\":%u,\"connectionsAfterClose\":%zu}\n",
         argv[1], passed, active, armed_replies, audit_checks, numeric_checks, token_lookups, denial_events, frame_reads,
         (unsigned long long)simulated_ms, checked_token_mismatches, connection_count);
  return passed ? 0 : 1;
}
