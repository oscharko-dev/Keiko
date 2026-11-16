package lab.api;

import static org.testng.Assert.assertEquals;

import org.testng.annotations.Test;

public class InvoiceServiceTest {
  private final InvoiceService service = new InvoiceService();

  @Test
  public void taxOfAWholeAmount() {
    assertEquals(service.tax(1000), 190);
  }

  @Test
  public void taxRoundsHalfUp() {
    assertEquals(service.tax(1050), 200);
  }

  @Test
  public void grossAddsTax() {
    assertEquals(service.gross(1000), 1190);
  }
}
