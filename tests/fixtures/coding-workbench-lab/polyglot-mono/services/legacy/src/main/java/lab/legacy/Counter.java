package lab.legacy;

/** A counter that never goes below zero. */
public final class Counter {
  private int value;

  public int increment() {
    value += 1;
    return value;
  }

  public int decrement() {
    if (value > 0) {
      value -= 1;
    }
    return value;
  }
}
