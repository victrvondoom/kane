// Pricing for the Northwind Outfitters demo store.
export const PRODUCTS = [
  { id: 'trail-backpack', name: 'Trail Backpack', price: 8000, blurb: '28L day pack with a rain cover.' },
  { id: 'summit-bottle', name: 'Summit Bottle', price: 2400, blurb: 'Insulated steel, 750 ml.' },
  { id: 'ridge-headlamp', name: 'Ridge Headlamp', price: 3600, blurb: '400 lumens, USB-C rechargeable.' },
  { id: 'camp-mug', name: 'Camp Mug', price: 1500, blurb: 'Enamel mug for early starts.' },
  { id: 'alpine-socks', name: 'Alpine Socks', price: 1800, blurb: 'Merino blend, cushioned heel.' },
];

export const COUPONS = { SAVE10: { percent: 10, label: '10% off your order' } };

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;

export function calcDiscount(subtotal, code) {
  const coupon = COUPONS[String(code || '').trim().toUpperCase()];
  return coupon ? Math.round((subtotal * coupon.percent) / 100) : 0;
}

export function cartTotals(items, couponCode) {
  const lines = items.map((i) => {
    const p = PRODUCTS.find((x) => x.id === i.id);
    return { ...p, qty: i.qty, lineTotal: p.price * i.qty };
  });
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const discount = calcDiscount(subtotal, couponCode);
  const total = subtotal;
  return { lines, subtotal, discount, total, count: lines.reduce((a, l) => a + l.qty, 0) };
}
