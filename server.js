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
  "es352eu-eur",
  "mo201eu-eur",
  "ci100eu-eur",
  "nc702eu-eur",
  "lb401eubl-eur",
  "bz651eu-eur",
  "dd102euiv2-eur",
  "fs605eubr-eur",
  "ch950eut-eur",
  "fn101eugy-eur",
  "hd446eu-eur",
  "fw312eupl-eur",
  "fs301eu-eur",
  "px250eut-eur",
  "ia3241eut-eur",
  "ip3251eut-eur",
  "sl400eu-eur",
  "nc502eu-eur",
  "hp072euwh-eur",
  "af500eu-eur",
  "sodastream-duo-family-pack-schwarz-titan-eur",
]);

// ---------------------------------------------------------------------------
// PRODUCT LINKS — Shopify handle -> Chargebee item price + display name.
// The storefront buy buttons point to /pay/<handle>; the server resolves the
// handle to the exact one-time item price and redirects to the PayPal checkout.
// ---------------------------------------------------------------------------
const PRODUCT_LINKS = {
  es352eu: { item_price_id: "es352eu-eur", name: "Ninja Luxe Café MINI Plus Kaffeemaschine" },
  mo201eu: { item_price_id: "mo201eu-eur", name: "Ninja Artisan Outdoor-Elektro-Pizzaofen und Heißluftfritteuse" },
  ci100eu: { item_price_id: "ci100eu-eur", name: "Ninja Foodi 3-in-1 Hand- und Stabmixer Set" },
  nc702eu: { item_price_id: "nc702eu-eur", name: "Ninja CREAMi Scoop & Swirl 13-in-1 Softeis- und Eismaschine" },
  lb401eubl: { item_price_id: "lb401eubl-eur", name: "Ninja CrushBOSS 3-in-1 Küchensystem – Mitternachtsblau" },
  bz651eu: { item_price_id: "bz651eu-eur", name: "Ninja PrecisionPro Küchenmaschine" },
  dd102euiv2: { item_price_id: "dd102euiv2-eur", name: "Ninja CRISPi DualZone Glas-Air-Fryer mit 8 Funktionen – Weiß" },
  fs605eubr: { item_price_id: "fs605eubr-eur", name: "Ninja SLUSHi MAX Slush-Eismaschine – Mokka" },
  ch950eut: { item_price_id: "ch950eut-eur", name: "Shark Akku-Handstaubsauger für Haustierbesitzer" },
  fn101eugy: { item_price_id: "fn101eugy-eur", name: "Ninja CRISPi 4-in-1 Glas-Heißluftfritteuse" },
  hd446eu: { item_price_id: "hd446eu-eur", name: "Shark FlexStyle 5-in-1 Styling- und Trocknungssystem" },
  fw312eupl: { item_price_id: "fw312eupl-eur", name: "Shark CryoGlow LED-Maske mit Kühlung der Augenpartie" },
  fs301eu: { item_price_id: "fs301eu-eur", name: "Ninja SLUSHi Slush-Eismaschine" },
  px250eut: { item_price_id: "px250eut-eur", name: "Shark StainStriker HairPro Pet Flecken- und Polsterreiniger" },
  ia3241eut: { item_price_id: "ia3241eut-eur", name: "Shark PowerDetect Speed Pet Pro Clean & Empty Akku-Staubsauger" },
  ip3251eut: { item_price_id: "ip3251eut-eur", name: "Shark PowerDetect Clean & Empty Akku-Staubsauger für Tierhaare" },
  sl400eu: { item_price_id: "sl400eu-eur", name: "Ninja Double Stack XL Heißluftfritteuse 9,5 L" },
  nc502eu: { item_price_id: "nc502eu-eur", name: "Ninja CREAMi Deluxe 10-in-1 Eismaschine" },
  hp072euwh: { item_price_id: "hp072euwh-eur", name: "Shark NeverChange Luftreiniger Compact Pro" },
  af500eu: { item_price_id: "af500eu-eur", name: "Ninja Foodi FlexDrawer 10,4 L Heißluftfritteuse" },
  "sodastream-duo-family-pack-schwarz-titan": { item_price_id: "sodastream-duo-family-pack-schwarz-titan-eur", name: "SodaStream DUO Family Pack – Schwarz/Titan" },
};

// The item price sold by the custom checkout page (fallback when no ?p= given).
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
  res.json({ site: SITE, publishableKey: PUBLISHABLE_KEY });
});

// ---------------------------------------------------------------------------
// GET /pay/:handle — storefront entry point. Resolves a Shopify product handle
// to its one-time item price and redirects to the PayPal checkout page.
// ---------------------------------------------------------------------------
app.get("/pay/:handle", (req, res) => {
  const product = PRODUCT_LINKS[req.params.handle];
  if (!product) {
    return res.status(404).send("Product not found");
  }
  return res.redirect(302, `/checkout-paypal?p=${encodeURIComponent(req.params.handle)}`);
});

// ---------------------------------------------------------------------------
// GET /api/price — server-driven price for the checkout page.
// ?id=<handle> selects the product; defaults to ITEM_PRICE_ID.
// ---------------------------------------------------------------------------
app.get("/api/price", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }
    const handle = req.query.id;
    let itemPriceId = ITEM_PRICE_ID;
    let productName = null;
    if (handle) {
      const product = PRODUCT_LINKS[handle];
      if (!product) {
        return res.status(400).json({ error: "Unknown product" });
      }
      itemPriceId = product.item_price_id;
      productName = product.name;
    }
    const ip = await fetchItemPrice(itemPriceId);
    return res.json({
      id: ip.id,
      name: productName || ip.name,
      amount: ip.price,
      currency_code: ip.currency_code,
      formatted: formatPrice(ip.price, ip.currency_code),
      type: ip.item_type || "charge",
      brand: "GLOBOMARTS",
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

    const { payment_method_type = "card", item_price_id } = req.body || {};
    const itemPriceId = item_price_id || ITEM_PRICE_ID;
    if (!ALLOWED_ITEM_PRICES.has(itemPriceId)) {
      return res.status(400).json({ error: "Invalid item_price_id" });
    }
    const ip = await fetchItemPrice(itemPriceId);

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
// either a one-time invoice (charge items) or a subscription, using the
// authorized payment intent id.
// ---------------------------------------------------------------------------
app.post("/api/subscribe", async (req, res) => {
  try {
    if (!SITE || !API_KEY) {
      return res
        .status(500)
        .json({ error: "Server misconfigured: CHARGEBEE_SITE / CHARGEBEE_API_KEY missing" });
    }

    const { payment_intent_id, item_price_id, customer = {}, billing_address = {} } = req.body || {};
    const itemPriceId = item_price_id || ITEM_PRICE_ID;

    if (!payment_intent_id) {
      return res.status(400).json({ error: "payment_intent_id is required" });
    }
    if (!ALLOWED_ITEM_PRICES.has(itemPriceId)) {
      return res.status(400).json({ error: "Invalid item_price_id" });
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

    // 2) Determine one-time (charge) vs recurring (plan) from the item price.
    const ip = await fetchItemPrice(itemPriceId);
    const isOneTime = ip.item_type === "charge";

    let result;
    if (isOneTime) {
      // One-time purchase: create an invoice for the charge item and collect it
      // immediately with the authorized payment intent.
      const invParams = new URLSearchParams();
      invParams.append("customer_id", customerId);
      invParams.append("item_prices[item_price_id][0]", itemPriceId);
      invParams.append("item_prices[quantity][0]", "1");
      invParams.append("payment_intent[id]", payment_intent_id);

      const invRes = await fetch(
        `https://${SITE}.chargebee.com/api/v2/invoices/create_for_charge_items_and_charges`,
        {
          method: "POST",
          headers: chargebeeHeaders(),
          body: invParams.toString(),
        }
      );
      const invData = await invRes.json().catch(() => ({}));
      if (!invRes.ok) {
        console.error("Invoice create error:", invRes.status, JSON.stringify(invData));
        return res
          .status(invRes.status)
          .json({ error: "Chargebee invoice creation failed", details: invData });
      }
      result = {
        customer: invData.customer,
        invoice: invData.invoice,
        subscription: null,
      };
    } else {
      // Recurring: create the subscription for that customer using the intent.
      const subParams = new URLSearchParams();
      subParams.append("subscription_items[item_price_id][0]", itemPriceId);
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
      result = {
        customer: subData.customer,
        subscription: subData.subscription,
        invoice: subData.invoice,
      };
    }

    return res.json(result);
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
