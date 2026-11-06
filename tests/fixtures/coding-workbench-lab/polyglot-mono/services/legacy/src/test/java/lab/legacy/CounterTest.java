package lab.legacy;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CounterTest {
  @Test
  void neverGoesBelowZero() {
    Counter counter = new Counter();
    assertEquals(0, counter.decrement());
    assertEquals(1, counter.increment());
  }
}
