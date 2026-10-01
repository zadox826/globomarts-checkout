require("dotenv").config();

const path = require("path");
const express = require("express");

const app = express();
// Behind a reverse proxy (nginx / Render / Fly) so req.ip and req.protocol are correct.
app.set("trust proxy", 1);
app.use(express.json());
// `extensions` lets /success resolve to success.html and /cancel to cancel.html
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Health check for Render / Fly.io / load balancers.
app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

const SITE = process.env.CHARGEBEE_SITE;
const API_KEY = process.env.CHARGEBEE_API_KEY;
// Publishable key is browser-safe (it is meant to be public). It is required by
// Chargebee.js Card Components / Payment Method Helpers. Create it in the
// dashboard: Settings > Configure Chargebee > API Keys and Webhooks > API Keys
// > Add API Key > Publishable Key. Then put it in .env.
const PUBLISHABLE_KEY = process.env.CHARGEBEE_PUBLISHABLE_KEY || "";
const REDIRECT_URL = process.env.REDIRECT_URL || "https://example.com/success";
const CANCEL_URL = process.env.CANCEL_URL || "https://example.com/cancel";

// ---------------------------------------------------------------------------
// SERVER-SIDE ALLOWLIST
// The client sends an item_price_id. Never trust it: only these may be sold.
// Add every item price ID you actually offer in your Chargebee catalog.
// ---------------------------------------------------------------------------
const ALLOWED_ITEM_PRICES = new Set([
  "basic-eur-monthly",
  // "pro-eur-monthly",
  // "basic-usd-monthly",
]);

// The item price sold by the custom checkout page.
const ITEM_PRICE_ID = process.env.ITEM_PRICE_ID || "basic-eur-monthly";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function chargebeeHeaders() {
  return {
    Authorization: `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
}

function formatPrice(amountMinor, currencyCode) {
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currencyCode,
    }).format(amountMinor / 100);
  } catch {
    return `${currencyCode} ${(amountMinor / 100).toFixed(2)}`;
  }
}

async function fetchItemPrice(itemPriceId) {
  const cbRes = await fetch(
    `https://${SITE}.chargebee.com/api/v2/item_prices/${encodeURIComponent(itemPriceId)}`,
    { headers: chargebeeHeaders() }
  );
  const data = await cbRes.json().catch(() => ({}));
  if (!cbRes.ok) {
    const err = new Error("Chargebee item price fetch failed");
    err.status = cbRes.status;
    err.details = data;
    throw err;
  }
  return data.item_price;
}

// ---------------------------------------------------------------------------
// GET /api/config — public config for the frontend (site + publishable key).
// The publishable key is designed to be used in browsers; the secret API key
// never leaves the server.
// ---------------------------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    site: SITE,
    publishableKey: PUBLISHABLE_KEY,
    itemPriceId: ITEM_PRICE_ID,
  });
});

// ---------------------------------------------------------------------------
// GET /api/price — current item price (amount + currency) so the order card
// always shows the real price. Once you enable EUR in the dashboard and we
// flip the price to EUR, this automatically renders €1.00.
// ---------------------------------------------------------------------------
app.get("/api/price", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }
    const ip = await fetchItemPrice(ITEM_PRICE_ID);
    return res.json({
      id: ip.id,
      name: ip.name,
      amount: ip.price,
      currency_code: ip.currency_code,
      formatted: formatPrice(ip.price, ip.currency_code),
      period: ip.period,
      period_unit: ip.period_unit,
    });
  } catch (err) {
    console.error("Price fetch error:", err.status, JSON.stringify(err.details || err.message));
    return res.status(err.status || 500).json({ error: "Failed to fetch price", details: err.details || {} });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payment-intent — creates a Chargebee payment intent.
// Amount/currency come from the server-side item price, never from the client.
// payment_method_type: "card" (default) or "paypal_express_checkout".
// ---------------------------------------------------------------------------
app.post("/api/payment-intent", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }

    const { payment_method_type = "card" } = req.body || {};
    const ip = await fetchItemPrice(ITEM_PRICE_ID);

    const params = new URLSearchParams();
    params.append("amount", String(ip.price));
    params.append("currency_code", ip.currency_code);
    params.append("payment_method_type", payment_method_type);

    const cbRes = await fetch(`https://${SITE}.chargebee.com/api/v2/payment_intents`, {
      method: "POST",
      headers: chargebeeHeaders(),
      body: params.toString(),
    });
    const data = await cbRes.json().catch(() => ({}));

    if (!cbRes.ok) {
      console.error("Payment intent error:", cbRes.status, JSON.stringify(data));
      return res
        .status(cbRes.status)
        .json({ error: "Chargebee payment intent failed", details: data });
    }
    return res.json(data.payment_intent);
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscribe — creates the customer (with billing address) and then
// the subscription using the authorized payment intent id.
// ---------------------------------------------------------------------------
app.post("/api/subscribe", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }

    const { payment_intent_id, customer = {}, billing_address = {} } = req.body || {};

    if (!payment_intent_id) {
      return res.status(400).json({ error: "payment_intent_id is required" });
    }
    if (!customer.first_name || !customer.last_name || !customer.email) {
      return res.status(400).json({ error: "first_name, last_name and email are required" });
    }

    // 1) Create the customer (billing address attached in the same call).
    const custParams = new URLSearchParams();
    custParams.append("first_name", customer.first_name);
    custParams.append("last_name", customer.last_name);
    custParams.append("email", customer.email);
    if (customer.phone) custParams.append("phone", customer.phone);
    if (customer.company) custParams.append("company", customer.company);
    if (billing_address.first_name) custParams.append("billing_address[first_name]", billing_address.first_name);
    if (billing_address.last_name) custParams.append("billing_address[last_name]", billing_address.last_name);
    if (billing_address.line1) custParams.append("billing_address[line1]", billing_address.line1);
    if (billing_address.line2) custParams.append("billing_address[line2]", billing_address.line2);
    if (billing_address.city) custParams.append("billing_address[city]", billing_address.city);
    if (billing_address.state) custParams.append("billing_address[state]", billing_address.state);
    if (billing_address.zip) custParams.append("billing_address[zip]", billing_address.zip);
    if (billing_address.country) custParams.append("billing_address[country]", billing_address.country);

    const custRes = await fetch(`https://${SITE}.chargebee.com/api/v2/customers`, {
      method: "POST",
      headers: chargebeeHeaders(),
      body: custParams.toString(),
    });
    const custData = await custRes.json().catch(() => ({}));
    if (!custRes.ok) {
      console.error("Customer create error:", custRes.status, JSON.stringify(custData));
      return res
        .status(custRes.status)
        .json({ error: "Chargebee customer creation failed", details: custData });
    }
    const customerId = custData.customer.id;

    // 2) Create the subscription for that customer using the authorized intent.
    const subParams = new URLSearchParams();
    subParams.append("subscription_items[item_price_id][0]", ITEM_PRICE_ID);
    subParams.append("subscription_items[quantity][0]", "1");
    subParams.append("payment_intent[id]", payment_intent_id);

    const subRes = await fetch(
      `https://${SITE}.chargebee.com/api/v2/customers/${encodeURIComponent(customerId)}/subscription_for_items`,
      {
        method: "POST",
        headers: chargebeeHeaders(),
        body: subParams.toString(),
      }
    );
    const subData = await subRes.json().catch(() => ({}));
    if (!subRes.ok) {
      console.error("Subscription create error:", subRes.status, JSON.stringify(subData));
      return res
        .status(subRes.status)
        .json({ error: "Chargebee subscription creation failed", details: subData });
    }

    return res.json({
      customer: subData.customer,
      subscription: subData.subscription,
      invoice: subData.invoice,
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Hosted checkout (kept as the fallback / PayPal-alternative flow)
// ---------------------------------------------------------------------------
app.post("/api/checkout/new", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }

    const { item_price_id } = req.body || {};

    if (!item_price_id || !ALLOWED_ITEM_PRICES.has(item_price_id)) {
      return res.status(400).json({ error: "Invalid item_price_id" });
    }

    // Chargebee expects application/x-www-form-urlencoded for this API.
    const params = new URLSearchParams();
    params.append("redirect_url", REDIRECT_URL);
    params.append("cancel_url", CANCEL_URL);
    params.append("subscription_items[item_price_id][0]", item_price_id);

    const cbRes = await fetch(
      `https://${SITE}.chargebee.com/api/v2/hosted_pages/checkout_new_for_items`,
      {
        method: "POST",
        headers: chargebeeHeaders(),
        body: params.toString(),
      }
    );

    const data = await cbRes.json().catch(() => ({}));

    if (!cbRes.ok) {
      console.error("Chargebee API error:", cbRes.status, JSON.stringify(data));
      return res
        .status(cbRes.status)
        .json({ error: "Chargebee request failed", details: data });
    }

    // Chargebee.js expects the hosted page OBJECT (id, url, state, ...),
    // NOT the full { hosted_page: {...} } envelope.
    return res.json(data.hosted_page);
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Optional: verify a completed checkout server-side using the hosted page id.
app.get("/api/checkout/verify", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing hosted page id" });

    const cbRes = await fetch(
      `https://${SITE}.chargebee.com/api/v2/hosted_pages/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`, Accept: "application/json" } }
    );
    const data = await cbRes.json().catch(() => ({}));
    if (!cbRes.ok) return res.status(cbRes.status).json({ error: "Retrieve failed", details: data });
    return res.json(data);
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Custom checkout: http://localhost:${PORT}/checkout`);
  if (!SITE || !API_KEY) {
    console.warn("WARNING: CHARGEBEE_SITE / CHARGEBEE_API_KEY not set. Copy .env.example to .env.");
  }
  if (!PUBLISHABLE_KEY) {
    console.warn("WARNING: CHARGEBEE_PUBLISHABLE_KEY not set. Card fields / PayPal button need it.");
  }
});
