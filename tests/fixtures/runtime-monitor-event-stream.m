#import <EndpointSecurity/EndpointSecurity.h>
#import <Security/Security.h>
#include <bsm/libbsm.h>
#include <os/log.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include "protocol.h"
static unsigned zero_replies, error_replies, signal_calls, integrity_failures;
static void inert_log(const char *format, ...) {
  if (strstr(format, "endpoint sequence integrity lost") != NULL) integrity_failures++;
}
static es_auth_result_t last_auth;
static ssize_t inert_send(int fd, const void *data, size_t size, int flags) {
  (void)fd;
  (void)flags;
  const struct keiko_monitor_reply *reply = data;
  if (size != sizeof(*reply)) return -1;
  if (reply->kind == KEIKO_MONITOR_ZERO_LIVE) zero_replies++;
  if (reply->kind == KEIKO_MONITOR_ERROR) error_replies++;
  return (ssize_t)size;
}
static int inert_kill(pid_t pid, int signal) {
  (void)pid;
  (void)signal;
  signal_calls++;
  return -1;
}
static es_return_t inert_auth(es_client_t *client, const es_message_t *message,
                              es_auth_result_t result, bool cache) {
  (void)client;
  (void)message;
  (void)cache;
  last_auth = result;
  return ES_RETURN_SUCCESS;
}
static void (*subscribe_hook)(void);
static es_new_client_result_t inert_new_client(es_client_t **client, es_handler_block_t handler) {
  (void)handler;
  *client = (es_client_t *)(uintptr_t)1;
  return ES_NEW_CLIENT_RESULT_SUCCESS;
}
static es_return_t inert_subscribe(es_client_t *client, const es_event_type_t *events,
                                   uint32_t count) {
  (void)client;
  (void)events;
  (void)count;
  if (subscribe_hook != NULL) subscribe_hook();
  return ES_RETURN_SUCCESS;
}
static es_return_t inert_delete_client(es_client_t *client) {
  (void)client;
  return ES_RETURN_SUCCESS;
}
#define es_new_client inert_new_client
#define es_subscribe inert_subscribe
#define es_delete_client inert_delete_client
#undef os_log
#undef os_log_error
#define os_log(_handle, ...) inert_log(__VA_ARGS__)
#define os_log_error(_handle, ...) inert_log(__VA_ARGS__)
#define send inert_send
#define kill inert_kill
#define es_respond_auth_result inert_auth
#define main keiko_fixture_unused_main
#include KEIKO_MONITOR_SOURCE
#undef main
static void event(uint32_t version, es_event_type_t kind, pid_t pid, pid_t child,
                  uint64_t sequence) {
  es_process_t actor = {0}, descendant = {0};
  actor.audit_token.val[5] = (uint32_t)pid;
  descendant.audit_token.val[5] = (uint32_t)child;
  es_message_t message = {0};
  message.version = version;
  message.event_type = kind;
  message.process = &actor;
  message.global_seq_num = sequence;
  message.event.fork.child = &descendant;
  if (audit_token_to_pid(actor.audit_token) != pid) __builtin_trap();
  endpoint_event(NULL, &message);
}
static struct monitor_session *arm(pid_t supervisor) {
  struct keiko_monitor_request request = {0};
  request.supervisor_pid = (uint32_t)supervisor;
  memset(request.recovery_handle, supervisor == 100 ? 'a' : 'b', sizeof(request.recovery_handle));
  return allocate_session(1, 501, &request);
}
static int healthy(uint32_t version, uint64_t origin) {
  event(version, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, origin);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(version, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, origin + 1);
  event(version, ES_EVENT_TYPE_NOTIFY_FORK, 200, 300, origin + 2);
  event(version, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, origin + 3);
  if (!session_contains(session, 300) || zero_replies != 0) return 0;
  event(version, ES_EVENT_TYPE_NOTIFY_EXIT, 300, 0, origin + 4);
  return zero_replies == 1 && error_replies == 0 && signal_calls == 0;
}
static int lost_sequence(uint64_t origin, uint64_t observed, uint32_t version) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, origin);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, origin + 1);
  // A descendant can remain alive when its fork notification is not delivered.
  event(version, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, observed);
  unsigned refused_on_exit = zero_replies == 0 && error_replies > 0;
  stop_session(session);
  unsigned refused_on_stop = zero_replies == 0;
  close_session(session);
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, observed + 1);
  unsigned unrelated_allowed = last_auth == ES_AUTH_RESULT_ALLOW;
  unsigned cannot_rearm = arm(400) == NULL;
  return refused_on_exit && refused_on_stop && zero_replies == 0 && cannot_rearm &&
         unrelated_allowed && signal_calls == 0 && integrity_failures == 1;
}
static void injected_startup_failure(void) {
  set_endpoint_state(ENDPOINT_STATE_FAILED);
}
int main(int argc, char **argv) {
  (void)keiko_monitor_log;
  (void)endpoint_state_name;
  if (argc != 2) return 2;
  endpoint_state = ENDPOINT_STATE_ACTIVE;
  int passed = 0;
  if (strcmp(argv[1], "healthy") == 0) passed = healthy(5, 17);
  else if (strcmp(argv[1], "healthy-v4-zero-origin") == 0) passed = healthy(4, 0);
  else if (strcmp(argv[1], "gap") == 0) passed = lost_sequence(17, 20, 5);
  else if (strcmp(argv[1], "duplicate") == 0) passed = lost_sequence(17, 18, 5);
  else if (strcmp(argv[1], "backward") == 0) passed = lost_sequence(17, 16, 5);
  else if (strcmp(argv[1], "unsupported-version") == 0) passed = lost_sequence(17, 19, 3);
  else if (strcmp(argv[1], "overflow") == 0) passed = lost_sequence(UINT64_MAX - 1, 0, 5);
  else if (strcmp(argv[1], "startup-failure") == 0) {
    subscribe_hook = injected_startup_failure;
    start_endpoint_security(NULL);
    passed = current_endpoint_state() == ENDPOINT_STATE_FAILED && signal_calls == 0;
}
  else if (strcmp(argv[1], "no-baseline") == 0) {
    unsigned refused = arm(100) == NULL;
    event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
    passed = refused && arm(100) != NULL && signal_calls == 0;
}
  printf("{\"case\":\"%s\",\"passed\":%d,\"zeroReplies\":%u,\"errorReplies\":%u,\"signalCalls\":%u}\n",
         argv[1], passed, zero_replies, error_replies, signal_calls);
  return passed ? 0 : 1;
}
