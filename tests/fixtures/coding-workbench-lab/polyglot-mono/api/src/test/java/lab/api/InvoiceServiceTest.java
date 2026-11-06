package lab.api;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class InvoiceServiceTest {
  private final InvoiceService service = new InvoiceService();

  @Test
  void taxOfAWholeAmount() {
    assertEquals(190, service.tax(1000));
  }

  @Test
  void taxRoundsHalfUp() {
    assertEquals(200, service.tax(1050));
  }

  @Test
  void grossAddsTax() {
    assertEquals(1190, service.gross(1000));
  }
}
