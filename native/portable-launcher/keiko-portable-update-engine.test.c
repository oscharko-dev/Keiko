#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "keiko-portable-update-engine.h"

typedef struct {
  char calls[64];
  size_t length;
  char fail_at;
  int next_receipt_exists;
} engine_fixture;

static int record_call(engine_fixture *fixture, char call) {
  assert(fixture->length + 1u < sizeof(fixture->calls));
  fixture->calls[fixture->length++] = call;
  fixture->calls[fixture->length] = '\0';
  return fixture->fail_at != call;
}

static int test_deadline(void *opaque, int field, uint64_t *deadline_ms) {
  engine_fixture *fixture = (engine_fixture *)opaque;
  (void)field;
  *deadline_ms = UINT64_MAX;
  return fixture->fail_at != 'D';
}

#define TEST_CALLBACK(name, call)                 \
  static int name(void *opaque) {                 \
    return record_call((engine_fixture *)opaque, call); \
  }

#define TEST_DEADLINE_CALLBACK(name, call)                       \
  static int name(void *opaque, uint64_t deadline_ms) {          \
    (void)deadline_ms;                                            \
    return record_call((engine_fixture *)opaque, call);           \
  }

TEST_CALLBACK(test_emit_acceptance, 'A')
TEST_CALLBACK(test_wait_old_exit, 'W')
TEST_CALLBACK(test_hold_runtime, 'H')
TEST_DEADLINE_CALLBACK(test_promote, 'P')
TEST_DEADLINE_CALLBACK(test_publish_registration, 'G')
TEST_DEADLINE_CALLBACK(test_stop_runtime, 'R')
TEST_DEADLINE_CALLBACK(test_reconcile_stopped_runtime, 'Q')
TEST_DEADLINE_CALLBACK(test_stop_failed_start, 'F')
TEST_DEADLINE_CALLBACK(test_wait_verified_ack, 'K')
TEST_DEADLINE_CALLBACK(test_cleanup_verified, 'L')
TEST_DEADLINE_CALLBACK(test_restore_previous, 'B')

static int test_start_runtime(void *opaque, uint64_t deadline_ms, int restoring) {
  (void)deadline_ms;
  return record_call((engine_fixture *)opaque, restoring ? 'S' : 'N');
}

static int test_wait_receipt(void *opaque, const char *kind, const char *outcome,
                             uint64_t deadline_ms) {
  char call = 'U';
  (void)deadline_ms;
  if (strcmp(kind, "verify") == 0) call = strcmp(outcome, "intent") == 0 ? 'I' : 'V';
  else if (strcmp(outcome, "intent") == 0) call = 'T';
  return record_call((engine_fixture *)opaque, call);
}

static int test_next_receipt_exists(void *opaque) {
  engine_fixture *fixture = (engine_fixture *)opaque;
  return record_call(fixture, 'X') && fixture->next_receipt_exists;
}

static void test_hold_runtime_void(void *opaque) {
  (void)test_hold_runtime(opaque);
}

static keiko_coordinator_engine test_engine(engine_fixture *fixture) {
  const keiko_coordinator_engine engine = {
      fixture,
      test_deadline,
      test_emit_acceptance,
      test_wait_old_exit,
      test_promote,
      test_publish_registration,
      test_start_runtime,
      test_wait_receipt,
      test_next_receipt_exists,
      test_stop_runtime,
      test_reconcile_stopped_runtime,
      test_stop_failed_start,
      test_wait_verified_ack,
      test_cleanup_verified,
      test_restore_previous,
      test_hold_runtime_void};
  return engine;
}

static void assert_execution(char fail_at, int next_receipt_exists, int expected_result,
                             const char *expected_calls) {
  engine_fixture fixture = {{0}, 0u, fail_at, next_receipt_exists};
  keiko_coordinator_engine engine = test_engine(&fixture);
  assert(keiko_coordinator_execute_engine(&engine, 1, 2, 3) == expected_result);
  assert(strcmp(fixture.calls, expected_calls) == 0);
}

int main(void) {
  assert_execution('\0', 0, 1, "AWPGNIVKLH");
  assert_execution('P', 0, 1, "AWPBSTUH");
  assert_execution('G', 0, 1, "AWPGBSTUH");
  assert_execution('N', 0, 1, "AWPGNFBSTUH");
  assert_execution('I', 0, 1, "AWPGNIXRQBSTUH");
  assert_execution('I', 1, 0, "AWPGNIXH");
  assert_execution('V', 0, 0, "AWPGNIVH");
  assert_execution('K', 0, 0, "AWPGNIVKH");
  assert_execution('L', 0, 0, "AWPGNIVKLH");
  return 0;
}
