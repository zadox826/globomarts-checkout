// Chargebee.js v2 instance.
// `site` must be your Chargebee billing subdomain.
// `isItemsModel: true` is required when your catalog uses Item Prices.
const chargebee = Chargebee.init({
  site: "ninjjakoffe-test",
  isItemsModel: true,
});

const button = document.getElementById("checkout-button");

button.addEventListener("click", function () {
  button.disabled = true;

  chargebee.openCheckout({
    // Called each time openCheckout runs -> a fresh hosted page is created
    // server-side and returned to Chargebee.js. Must resolve to the hosted
    // page OBJECT (id, url, state, ...).
    hostedPage: function () {
      return fetch("/api/checkout/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_price_id: "basic-eur-monthly", // <-- replace with your real item price ID
        }),
      }).then(function (response) {
        if (!response.ok) {
          return response.json().then(function (body) {
            throw new Error(body.error || "Failed to create checkout");
          });
        }
        return response.json();
      });
    },

    // Chargebee.js renders the hosted page in its own managed modal/iframe.
    loaded: function () {
      console.log("Checkout loaded");
    },

    // Checkout finished. hostedPageId is passed to your server for verification.
    success: function (hostedPageId) {
      console.log("Checkout success, hosted page id:", hostedPageId);
      // Example: verify server-side, then redirect.
      fetch("/api/checkout/verify?id=" + encodeURIComponent(hostedPageId))
        .then((r) => r.json())
        .then((data) => {
          console.log("Verified hosted page:", data);
          window.location.href = "/success";
        })
        .catch((err) => console.error(err));
    },

    close: function () {
      console.log("Checkout closed");
      button.disabled = false;
    },
  });
});
