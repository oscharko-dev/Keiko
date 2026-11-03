#import <EndpointSecurity/EndpointSecurity.h>
#import <Security/Security.h>
#include <bsm/libbsm.h>
#include <os/log.h>
#include <signal.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#include <sys/un.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include "protocol.h"
static int (*const kernel_token_signal)(audit_token_t *, int) = proc_signal_with_audittoken;
static int (*const kernel_numeric_signal)(pid_t, int) = kill;
static unsigned zero_replies, error_replies, signal_calls, integrity_failures;
static unsigned token_signal_calls, wrong_generation_signals, accepted_signals;
static pid_t fixture_peer_pid, replaced_pid;
static uint32_t replacement_version = 2, fixture_peer_version = 1;
static int forced_signal_error, peer_failure;
static __attribute__((unused)) int inert_peer_token(int fd, int level, int option,
                                                   void *value, socklen_t *length) {
  (void)fd;
  if (peer_failure == 1) return -1;
  if (level != SOL_LOCAL || option != LOCAL_PEERTOKEN || *length != sizeof(audit_token_t))
    return -1;
  audit_token_t token = {0};
  token.val[1] = 501;
  token.val[5] = (uint32_t)fixture_peer_pid;
  token.val[7] = fixture_peer_version;
  if (peer_failure == 2) *length -= 1;
  if (peer_failure == 3) token.val[5] += 1;
  if (peer_failure == 4) token.val[1] += 1;
  memcpy(value, &token, sizeof(token));
  return 0;
}
static __attribute__((unused)) int inert_token_signal(audit_token_t *token, int signal) {
  if (signal != SIGKILL) return EINVAL;
  token_signal_calls++;
  if (forced_signal_error != 0) return forced_signal_error;
  if (audit_token_to_pid(*token) == replaced_pid &&
      audit_token_to_pidversion(*token) != (int)replacement_version) return ESRCH;
  accepted_signals++;
  return 0;
}
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
static __attribute__((unused)) int inert_kill(pid_t pid, int signal) {
  (void)signal;
  signal_calls++;
  if (pid == replaced_pid) wrong_generation_signals++;
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
#define getsockopt inert_peer_token
#define proc_signal_with_audittoken inert_token_signal
#define send inert_send
#define kill inert_kill
#define es_respond_auth_result inert_auth
#define main keiko_fixture_unused_main
#include KEIKO_MONITOR_SOURCE
#undef main
static void versioned_event(uint32_t version, es_event_type_t kind, pid_t pid,
                            uint32_t pid_version, pid_t child, uint32_t child_version,
                            uint64_t sequence) {
  es_process_t actor = {0}, descendant = {0};
  actor.audit_token.val[5] = (uint32_t)pid;
  actor.audit_token.val[7] = pid_version;
  descendant.audit_token.val[5] = (uint32_t)child;
  descendant.audit_token.val[7] = child_version;
  es_message_t message = {0};
  message.version = version;
  message.event_type = kind;
  message.process = &actor;
  message.global_seq_num = sequence;
  if (kind == ES_EVENT_TYPE_NOTIFY_EXEC) message.event.exec.target = &descendant;
  else message.event.fork.child = &descendant;
  if (audit_token_to_pid(actor.audit_token) != pid) __builtin_trap();
  endpoint_event(NULL, &message);
}
static void event(uint32_t version, es_event_type_t kind, pid_t pid, pid_t child,
                  uint64_t sequence) {
  versioned_event(version, kind, pid, 1, child, 1, sequence);
}
static struct monitor_session *arm(pid_t supervisor) {
  fixture_peer_pid = supervisor;
  struct keiko_monitor_request request = {0};
  request.supervisor_pid = (uint32_t)supervisor;
  memset(request.recovery_handle, supervisor == 100 ? 'a' : 'b', sizeof(request.recovery_handle));
  audit_token_t token;
  if (!peer_audit_token(1, supervisor, 501, &token)) return NULL;
  return allocate_session(1, 501, &request, token);
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
static int pending_root(int disconnect) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  stop_session(session);
  unsigned no_early_zero = zero_replies == 0;
  if (disconnect) close_session(session);
  unsigned ownership_retained = session->active;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 200, 300, 19);
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, 20);
  unsigned child_owned = session_contains(session, 300);
  return no_early_zero && ownership_retained && child_owned;
}
static int no_root_disconnect(int exit_first) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  if (exit_first) event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 100, 0, 18);
  close_session(session);
  if (!exit_first && !session->active) return 0;
  if (!exit_first) event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 100, 0, 18);
  return !session->active && signal_calls == 0 && token_signal_calls == 0;
}
static int recycled_stop(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 200, 300, 19);
  // EXIT for the former process is queued; numeric 300 now names another lifetime.
  replaced_pid = 300;
  stop_session(session);
  return signal_calls == 0 && wrong_generation_signals == 0 && token_signal_calls == 2 &&
         accepted_signals == 1 && zero_replies == 0;
}
static int exec_transition(int stop_before_notification) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 200, 0, 19);
  if (last_auth != ES_AUTH_RESULT_ALLOW) return 0;
  replaced_pid = 200;
  if (stop_before_notification) stop_session(session);
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXEC, 200, 1, 200, 2, 20);
  if (!stop_before_notification) stop_session(session);
  unsigned no_early_zero = zero_replies == 0;
  versioned_event(5, ES_EVENT_TYPE_AUTH_EXEC, 200, 2, 0, 0, 21);
  unsigned owned_denied = last_auth == ES_AUTH_RESULT_DENY;
  versioned_event(5, ES_EVENT_TYPE_AUTH_EXEC, 200, 3, 0, 0, 22);
  unsigned unrelated_allowed = last_auth == ES_AUTH_RESULT_ALLOW;
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 1, 0, 0, 23);
  unsigned stale_exit_ignored = zero_replies == 0;
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 2, 0, 0, 24);
  return no_early_zero && owned_denied && unrelated_allowed && stale_exit_ignored &&
         zero_replies == 1 && accepted_signals == 1 && signal_calls == 0 &&
         token_signal_calls == (stop_before_notification ? 2u : 1u);
}
static int signal_refusal(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  forced_signal_error = EPERM;
  stop_session(session);
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, 19);
  return zero_replies == 0 && error_replies > 0 && signal_calls == 0 && token_signal_calls == 1;
}
static int pending_owner_exit(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  close_session(session);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 200, 300, 19);
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, 20);
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 100, 0, 21);
  unsigned child_retained = session->active && session_contains(session, 300);
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 300, 0, 22);
  return child_retained && !session->active && arm(400) != NULL && zero_replies == 0 &&
         signal_calls == 0 && token_signal_calls == 2;
}
static int no_root_capacity(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  for (unsigned index = 0; index < KEIKO_MAX_SESSIONS + 1; ++index) {
    struct monitor_session *session = arm(100);
    if (session == NULL) return 0;
    close_session(session);
    if (!session->active) return 0;
    event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 100, 0, 18 + index);
    if (session->active) return 0;
  }
  return zero_replies == 0 && signal_calls == 0 && token_signal_calls == 0;
}
static int late_recycled_fork(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  stop_session(session);
  replaced_pid = 200;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  return session_contains(session, 200) && zero_replies == 0 && signal_calls == 0 &&
         wrong_generation_signals == 0 && accepted_signals == 0 && token_signal_calls == 1;
}
static int process_limit(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  for (unsigned index = 0; index <= KEIKO_MAX_PROCESSES; ++index)
    event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, (pid_t)(1000 + index), 18 + index);
  return session->process_count == KEIKO_MAX_PROCESSES && session->stopping &&
         zero_replies == 0 && error_replies > 0 && signal_calls == 0 &&
         token_signal_calls == KEIKO_MAX_PROCESSES + 1;
}
static int supervisor_reuse(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  stop_session(session);
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 2, 200, 1, 18);
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 100, 2, 0, 0, 19);
  unsigned unrelated_ignored = !session->root_observed && zero_replies == 0 &&
                               token_signal_calls == 0 && !session_contains(session, 200);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 300, 20);
  return unrelated_ignored && session->root_observed && session_contains(session, 300) &&
         token_signal_calls == 1 && signal_calls == 0;
}
static int peer_refusal(int failure) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  peer_failure = failure;
  return arm(100) == NULL && zero_replies == 0 && token_signal_calls == 0;
}
static int late_signal_refusal(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  stop_session(session);
  forced_signal_error = EPERM;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  return zero_replies == 0 && error_replies > 0 && signal_calls == 0 && token_signal_calls == 1;
}
static int wrong_exec_identity(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXEC, 200, 1, 300, 2, 19);
  unsigned refused = error_replies > 0 && zero_replies == 0;
  event(5, ES_EVENT_TYPE_NOTIFY_EXIT, 200, 0, 20);
  return refused && zero_replies == 0 && signal_calls == 0 && token_signal_calls == 1;
}
static int overlapping_owner(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 400, 18);
  return arm(400) == NULL && session_contains(session, 400) &&
         signal_calls == 0 && token_signal_calls == 0;
}
static int pending_exec_owner(void) {
  event(5, ES_EVENT_TYPE_AUTH_EXEC, 999, 0, 17);
  struct monitor_session *session = arm(100);
  if (session == NULL) return 0;
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 100, 200, 18);
  event(5, ES_EVENT_TYPE_NOTIFY_FORK, 200, 300, 19);
  fixture_peer_version = 2;
  unsigned overlap_refused = arm(300) == NULL;
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_EXEC, 300, 1, 300, 2, 20);
  versioned_event(5, ES_EVENT_TYPE_NOTIFY_FORK, 300, 2, 400, 1, 21);
  return overlap_refused && session_contains(session, 400) && zero_replies == 0 &&
         signal_calls == 0 && token_signal_calls == 0;
}
static int kernel_token_signal_control(void) {
  int descriptors[2], status = 0;
  if (pipe(descriptors) != 0) return 0;
  pid_t child = fork();
  if (child == -1) { close(descriptors[0]); close(descriptors[1]); return 0; }
  if (child == 0) {
    close(descriptors[0]);
    alarm(3);
    audit_token_t token = {0};
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS ||
        write(descriptors[1], &token, sizeof(token)) != sizeof(token)) _exit(2);
    close(descriptors[1]);
    for (;;) pause();
  }
  close(descriptors[1]);
  audit_token_t token = {0};
  ssize_t received = read(descriptors[0], &token, sizeof(token));
  close(descriptors[0]);
  int passed = received == sizeof(token) && audit_token_to_pid(token) == child;
  if (passed) {
    audit_token_t wrong = token;
    wrong.val[7] ^= 1u;
    passed = kernel_token_signal(&token, SIGCONT) == 0 &&
             kernel_token_signal(&wrong, SIGCONT) == ESRCH &&
             kernel_token_signal(&token, SIGCONT) == 0;
  }
  int terminated = passed && kernel_token_signal(&token, SIGKILL) == 0;
  // This direct child has not been reaped, so its PID cannot be recycled during cleanup.
  if (!terminated) (void)kernel_numeric_signal(child, SIGKILL);
  pid_t reaped = waitpid(child, &status, 0);
  return passed && terminated && reaped == child && WIFSIGNALED(status) &&
         WTERMSIG(status) == SIGKILL && kernel_token_signal(&token, SIGCONT) == ESRCH;
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
  if (strcmp(argv[1], "pending-exec-owner") == 0) passed = pending_exec_owner();
  else if (strcmp(argv[1], "peer-unavailable") == 0) passed = peer_refusal(1);
  else if (strcmp(argv[1], "peer-short-token") == 0) passed = peer_refusal(2);
  else if (strcmp(argv[1], "peer-wrong-pid") == 0) passed = peer_refusal(3);
  else if (strcmp(argv[1], "peer-wrong-uid") == 0) passed = peer_refusal(4);
  else if (strcmp(argv[1], "late-signal-refusal") == 0) passed = late_signal_refusal();
  else if (strcmp(argv[1], "wrong-exec-identity") == 0) passed = wrong_exec_identity();
  else if (strcmp(argv[1], "overlapping-owner") == 0) passed = overlapping_owner();
  else if (strcmp(argv[1], "pending-owner-exit") == 0) passed = pending_owner_exit();
  else if (strcmp(argv[1], "no-root-capacity") == 0) passed = no_root_capacity();
  else if (strcmp(argv[1], "late-recycled-fork") == 0) passed = late_recycled_fork();
  else if (strcmp(argv[1], "process-limit") == 0) passed = process_limit();
  else if (strcmp(argv[1], "supervisor-reuse") == 0) passed = supervisor_reuse();
  else if (strcmp(argv[1], "kernel-token-signal") == 0) passed = kernel_token_signal_control();
  else if (strcmp(argv[1], "no-root-disconnect") == 0) passed = no_root_disconnect(0);
  else if (strcmp(argv[1], "no-root-exited") == 0) passed = no_root_disconnect(1);
  else if (strcmp(argv[1], "recycled-stop") == 0) passed = recycled_stop();
  else if (strcmp(argv[1], "exec-transition") == 0) passed = exec_transition(0);
  else if (strcmp(argv[1], "exec-before-stop") == 0) passed = exec_transition(1);
  else if (strcmp(argv[1], "signal-refusal") == 0) passed = signal_refusal();
  else if (strcmp(argv[1], "pending-stop") == 0) passed = pending_root(0);
  else if (strcmp(argv[1], "pending-disconnect") == 0) passed = pending_root(1);
  else if (strcmp(argv[1], "healthy") == 0) passed = healthy(5, 17);
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
  printf("{\"case\":\"%s\",\"passed\":%d,\"zeroReplies\":%u,\"errorReplies\":%u,\"signalCalls\":%u,\"tokenSignalCalls\":%u,\"wrongGenerationSignals\":%u}\n",
         argv[1], passed, zero_replies, error_replies, signal_calls, token_signal_calls, wrong_generation_signals);
  return passed ? 0 : 1;
}
