// Demo scenario for the bundled sample store (demo-app/). This is input text only —
// it contains no results. Every status still has to come from a Kane CLI execution.
const port = process.env.DEMO_PORT || 4100;
export const DEMO_TEMPLATE = {
  name: 'Northwind Outfitters — checkout release',
  appUrl: `http://localhost:${port}/`,
  context: 'This is a test store with fake data; no real payments happen. When a step needs an account, register a brand-new one with a unique email like qa+<random digits>@example.com and password Test-1234!.',
  requirements: [
    'A visitor can register a new account with name, email and password and is then shown as signed in.',
    'A registered user can log out and log back in with the same email and password.',
    'The product catalogue lists at least four products, each with a name and a price.',
    'A signed-in user can add the Trail Backpack to the cart and the cart shows 1 item with a subtotal of $80.00.',
    'After applying coupon code SAVE10 to a cart containing one Trail Backpack ($80.00), the order total shows $72.00.',
    'After placing the order, a confirmation page shows an order number, and the order remains listed under Orders after reloading the page.',
  ].join('\n'),
};
