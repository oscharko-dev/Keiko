import unittest

from inventory.stock import Item, total_value_cents


class StockTest(unittest.TestCase):
    def test_total_value(self) -> None:
        items = [Item("A-1", 2, 150), Item("B-2", 1, 999)]
        self.assertEqual(total_value_cents(items), 1299)


if __name__ == "__main__":
    unittest.main()
