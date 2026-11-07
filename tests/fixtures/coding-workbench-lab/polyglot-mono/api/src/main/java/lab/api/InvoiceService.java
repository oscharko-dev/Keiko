package lab.api;

import lab.core.Percent;

/** Invoice arithmetic on integer cent amounts. */
public final class InvoiceService {
  private static final int TAX_PERCENT = 19;

  /** The tax owed on a net amount in cents. */
  public long tax(long netCents) {
    return Percent.of(netCents, TAX_PERCENT);
  }

  /** The gross amount: net plus tax. */
  public long gross(long netCents) {
    return netCents + tax(netCents);
  }
}
