package lab.core;

import static org.testng.Assert.assertEquals;

import org.testng.annotations.Test;

public class PercentTest {
  @Test
  public void exactShareNeedsNoRounding() {
    assertEquals(Percent.of(1000, 15), 150);
  }

  @Test
  public void roundsHalfUpToAWholeCent() {
    assertEquals(Percent.of(1050, 15), 158);
  }
}
