// Checkout pricing for the SHIPPROOF agent-gate demo.
// Known defect (intentional): the 10% coupon is not applied, so the checkout total is the full price.
export const ITEM_PRICE = 80;
export const total = ITEM_PRICE; // BUG: should be ITEM_PRICE * 0.9 when the coupon applies
