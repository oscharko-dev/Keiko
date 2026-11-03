from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    sku: str
    quantity: int
    unit_price_cents: int


def total_value_cents(items: list[Item]) -> int:
    """Total stock value in cents."""
    return sum(item.quantity * item.unit_price_cents for item in items)


def low_stock(items: list[Item], threshold: int) -> list[str]:
    """SKUs whose quantity is at or below the threshold, sorted by SKU."""
    return [item.sku for item in items if item.quantity < threshold]


def parse_line(line: str) -> Item:
    """Parses 'SKU;QUANTITY;PRICE' where PRICE is a decimal amount such as 12.50."""
    sku, quantity, price = line.strip().split(";")
    return Item(sku=sku, quantity=int(quantity), unit_price_cents=int(float(price) * 100))
