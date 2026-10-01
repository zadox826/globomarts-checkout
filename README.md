# Custom checkout — pixel-identical to your mockup

A complete custom checkout page that replicates the Chargebee hosted checkout
mockup (Account information / Billing address / Payment method on the left,
Order overview card on the right), built with **Chargebee.js Card Components**
for card payments and the **Payment Method Helper** for PayPal.

```
chargebee-checkout/
├── server.js              # Express backend: config, price, payment-intent, subscribe
├── public/
│   ├── checkout.html      # the mockup page (custom checkout)
│   ├── checkout.css       # mockup styling
│   ├── checkout.js        # Card Components + PayPal + subscribe flow
│   ├── index.html         # (kept) hosted-checkout fallback page
│   ├── app.js             # (kept) hosted-checkout fallback logic
│   ├── success.html       # landing page after a successful payment
│   └── cancel.html        # landing page if the customer cancels
├── .env.example           # copy to .env and fill in
└── package.json
```

## 1. Install & configure

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable                     | What it is                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `CHARGEBEE_SITE`             | Your Chargebee billing subdomain, e.g. `ninjjakoffe-test`.                  |
| `CHARGEBEE_API_KEY`          | Full-access API key (server-only). Settings > Configure Chargebee > API Keys. |
| `CHARGEBEE_PUBLISHABLE_KEY`  | **Required for the custom page.** Create it in the dashboard: Settings > Configure Chargebee > API Keys and Webhooks > API Keys > **Add API Key > Publishable Key**. It is browser-safe by design. |
| `ITEM_PRICE_ID`              | The item price sold on the page (default `basic-eur-monthly`).              |
| `REDIRECT_URL` / `CANCEL_URL`| Used by the hosted-checkout fallback flow.                                  |

> **Never** put `CHARGEBEE_API_KEY` in `public/`. It lives only in the backend.

## 2. Run

```bash
npm start
# open http://localhost:3000/checkout
```

## How the custom checkout works

1. **Page** — `checkout.html` renders the mockup: Account information
   (First name, Last name, E-mail, Telephone number, Company name), Billing
   address (Address Line 1/2, City, Postal code, Country = Germany, Federal
   State), Payment method (blue **Pay with PayPal** button + card fields), and
   the **Order overview** card on the right.

2. **Price** — `GET /api/price` fetches the real item price from Chargebee, so
   the order card always shows the correct amount and currency. The moment you
   enable EUR in the dashboard and the price is switched to EUR, the page
   automatically shows **€1.00**.

3. **Card payment** — `checkout.js` mounts Chargebee.js Card Components
   (fields mode: number / expiry / CVV), then:
   `tokenize()` → `POST /api/payment-intent` → `authorizeWith3ds()` →
   `POST /api/subscribe` (creates the customer + subscription with the
   authorized `payment_intent[id]`).

4. **PayPal** — the blue button loads the PayPal Payment Method Helper
   (`chargebee.load("paypal")`), creates a `paypal_express_checkout` payment
   intent, runs `handlePayment()`, then creates the subscription with the
   authorized intent id.

5. **Backend** — `server.js` keeps the secret API key. Amount/currency for the
   payment intent come from the server-side item price, never from the client.

## Dashboard steps you must do (I can't do these for you)

1. **Publishable key** — Settings > Configure Chargebee > API Keys and Webhooks
   > API Keys > Add API Key > **Publishable Key**. Paste it into `.env` as
   `CHARGEBEE_PUBLISHABLE_KEY`. *(Required for the card fields and PayPal.)*

2. **Euro** — Settings > Configure Chargebee > Currencies > **Enable
   Multicurrency**, then add **EUR**. Once enabled, tell me and I'll flip the
   item price to EUR via the API — the page will then show €1.00.

3. **PayPal gateway** — Settings > Configure Chargebee > Payment Gateways >
   Add a Gateway > PayPal (Express Checkout / Commerce / Braintree). Use the
   PayPal **sandbox** while the site is in test mode. The blue button only
   works after this is connected.

4. *(Optional, cosmetic)* — the mockup's field labels and default country are
   already hard-coded in `checkout.html` to match your screenshot, so no
   dashboard field configuration is needed for this page.

## Test cards (Chargebee test gateway)

- Visa: `4111 1111 1111 1111` — any future expiry, any CVV
- Mastercard: `5555 5555 5555 4444`
- 3DS test scenarios: use amounts like `3001`–`3104` (see Chargebee docs)

## API reference

- Card Components: https://www.chargebee.com/checkout-portal-docs/component-field-api-ref.html
- Payment Method Helpers: https://www.chargebee.com/checkout-portal-docs/payment-handler-api-ref.html
- Create payment intent: `POST /api/v2/payment_intents`
- Create subscription with intent: `POST /api/v2/customers/{id}/subscription_for_items` with `payment_intent[id]`
