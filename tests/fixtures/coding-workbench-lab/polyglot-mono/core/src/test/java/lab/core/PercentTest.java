package lab.core;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PercentTest {
  @Test
  void exactShareNeedsNoRounding() {
    assertEquals(150, Percent.of(1000, 15));
  }

  @Test
  void roundsHalfUpToAWholeCent() {
    assertEquals(158, Percent.of(1050, 15));
  }
}
