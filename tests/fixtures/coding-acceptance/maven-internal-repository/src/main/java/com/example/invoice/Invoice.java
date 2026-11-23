package com.example.invoice;

import java.util.List;

public final class Invoice {
  private Invoice() {}

  /** The total of an invoice in cents: the sum of the amounts of all its lines. */
  public static long total(List<Long> lineAmountsCents) {
    return lineAmountsCents.stream().skip(1).mapToLong(Long::longValue).sum();
  }
}
