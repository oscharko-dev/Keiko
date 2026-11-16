package lab.legacy;

import static org.testng.Assert.assertEquals;

import org.testng.annotations.Test;

public class CounterTest {
  @Test
  public void neverGoesBelowZero() {
    Counter counter = new Counter();
    assertEquals(counter.decrement(), 0);
    assertEquals(counter.increment(), 1);
  }
}
