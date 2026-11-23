package com.example.invoice;

import static org.junit.Assert.assertEquals;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.Collections;
import org.junit.BeforeClass;
import org.junit.Test;

public class InvoiceTest {
  /**
   * Counts this project's checks: every run of the tests appends one line before they run. The
   * acceptance tester compares the count with the checks the run reported, so it does not have to
   * trust what the run says about itself (#4492). The file is ignored by Git.
   */
  @BeforeClass
  public static void recordCheck() throws IOException {
    Files.write(
        Path.of(System.getProperty("user.dir"), ".acceptance-checks"),
        "check\n".getBytes(StandardCharsets.UTF_8),
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
  }

  @Test
  public void anInvoiceWithoutLinesTotalsZero() {
    assertEquals(0L, Invoice.total(Collections.emptyList()));
  }

  @Test
  public void theTotalIsTheSumOfEveryLine() {
    assertEquals(1625L, Invoice.total(Arrays.asList(1250L, 300L, 75L)));
  }
}
