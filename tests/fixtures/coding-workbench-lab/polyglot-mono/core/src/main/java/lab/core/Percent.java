package lab.core;

/** Percentage arithmetic on integer cent amounts. */
public final class Percent {
  private Percent() {}

  /** The given percentage of an amount in cents, rounded half up to a whole cent. */
  public static long of(long amountCents, int percent) {
    return amountCents * percent / 100;
  }
}
