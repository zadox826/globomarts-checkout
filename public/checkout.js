/* ---------------------------------------------------------------------------
   Custom checkout logic
   - Card payments: Chargebee.js Card Components (tokenize + authorizeWith3ds)
   - PayPal: Chargebee.js Payment Method Helper (chargebee.load("paypal"))
   - Subscription: created server-side with the authorized payment intent id
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var CONFIG = null;
  var PRICE = null;
  var cardComponent = null;
  var paypalHandler = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function showError(msg) {
    var banner = $("#error-banner");
    banner.textContent = msg;
    banner.hidden = false;
  }

  function clearError() {
    $("#error-banner").hidden = true;
  }

  function collectFormData() {
    return {
      customer: {
        first_name: $("#first_name").value.trim(),
        last_name: $("#last_name").value.trim(),
        email: $("#email").value.trim(),
        phone: $("#phone").value.trim(),
        company: $("#company").value.trim(),
      },
      billing_address: {
        first_name: $("#first_name").value.trim(),
        last_name: $("#last_name").value.trim(),
        line1: $("#address_line1").value.trim(),
        line2: $("#address_line2").value.trim(),
        city: $("#city").value.trim(),
        state: $("#state").value,
        zip: $("#zip").value.trim(),
        country: $("#country").value,
      },
    };
  }

  function validateForm(data) {
    if (!data.customer.first_name || !data.customer.last_name || !data.customer.email) {
      showError("Please fill in your first name, last name and e-mail.");
      return false;
    }
    return true;
  }

  function createPaymentIntent(paymentMethodType) {
    return fetch("/api/payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_method_type: paymentMethodType }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var msg =
            (data.details && data.details.message) ||
            data.error ||
            "Failed to create payment intent";
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function createSubscription(paymentIntentId) {
    var data = collectFormData();
    return fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment_intent_id: paymentIntentId,
        customer: data.customer,
        billing_address: data.billing_address,
      }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var msg =
            (body.details && body.details.message) ||
            body.error ||
            "Failed to create subscription";
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  /* ------------------------- Card payment flow ------------------------- */
  function handleCardPayment() {
    clearError();
    var data = collectFormData();
    if (!validateForm(data)) return;

    var btn = $("#pay-button");
    btn.disabled = true;
    btn.textContent = "Processing…";

    var additionalData = {
      firstName: data.customer.first_name,
      lastName: data.customer.last_name,
      addressLine1: data.billing_address.line1,
      addressLine2: data.billing_address.line2,
      city: data.billing_address.city,
      state: data.billing_address.state,
      stateCode: data.billing_address.state,
      zip: data.billing_address.zip,
      countryCode: data.billing_address.country,
    };

    cardComponent
      .tokenize(additionalData)
      .then(function (tokenData) {
        // Token created; now create the payment intent server-side.
        return createPaymentIntent("card");
      })
      .then(function (paymentIntent) {
        // Run 3DS (if the gateway requires it) and get an authorized intent.
        return cardComponent.authorizeWith3ds(paymentIntent, {
          billingAddress: {
            firstName: data.customer.first_name,
            lastName: data.customer.last_name,
            phone: data.customer.phone,
            addressLine1: data.billing_address.line1,
            addressLine2: data.billing_address.line2,
            city: data.billing_address.city,
            state: data.billing_address.state,
            stateCode: data.billing_address.state,
            zip: data.billing_address.zip,
            countryCode: data.billing_address.country,
          },
        });
      })
      .then(function (authorizedIntent) {
        return createSubscription(authorizedIntent.id);
      })
      .then(function () {
        window.location.href = "/success";
      })
      .catch(function (err) {
        console.error("Card payment failed:", err);
        showError(err.message || "Payment failed. Please try again.");
        btn.disabled = false;
        btn.textContent = "Pay " + PRICE.formatted;
      });
  }

  /* ------------------------- PayPal flow ------------------------- */
  function handlePayPal() {
    clearError();
    var data = collectFormData();
    if (!validateForm(data)) return;

    var btn = $("#paypal-button");
    btn.disabled = true;
    btn.textContent = "Redirecting to PayPal…";

    if (!paypalHandler) {
      showError(
        "PayPal is not connected yet. Connect a PayPal gateway in Chargebee " +
          "(Settings > Configure Chargebee > Payment Gateways), then reload this page."
      );
      btn.disabled = false;
      btn.textContent = "Pay with PayPal";
      return;
    }

    createPaymentIntent("paypal_express_checkout")
      .then(function (paymentIntent) {
        paypalHandler.setPaymentIntent(paymentIntent);
        return paypalHandler.handlePayment();
      })
      .then(function (authorizedIntent) {
        return createSubscription(authorizedIntent.id);
      })
      .then(function () {
        window.location.href = "/success";
      })
      .catch(function (err) {
        console.error("PayPal payment failed:", err);
        showError(err.message || "PayPal payment failed. Please try again.");
        btn.disabled = false;
        btn.textContent = "Pay with PayPal";
      });
  }

  /* ------------------------- Init ------------------------- */
  function init() {
    Promise.all([
      fetch("/api/config").then(function (r) {
        return r.json();
      }),
      fetch("/api/price").then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        CONFIG = results[0];
        PRICE = results[1];

        // Order overview card — server-driven price (auto-updates to € once EUR is enabled)
        $("#price-name").textContent = PRICE.name;
        $("#price-line").textContent = PRICE.formatted;
        $("#total-amount").textContent = PRICE.formatted;
        $("#pay-button").textContent = "Pay " + PRICE.formatted;

        if (!CONFIG.publishableKey) {
          showError(
            "Missing publishable key. Add CHARGEBEE_PUBLISHABLE_KEY to your .env file " +
              "(see README) and restart the server."
          );
          return;
        }

        var chargebee = Chargebee.init({
          site: CONFIG.site,
          publishableKey: CONFIG.publishableKey,
          isItemsModel: true,
        });

        // Card Components — fields mode (separate number / expiry / cvv inputs).
        // The 'components' module loads async — card APIs only work after it resolves.
        chargebee
          .load("components")
          .then(function () {
            cardComponent = chargebee.createComponent("card");
            cardComponent
              .createField("number", { placeholder: "4111 1111 1111 1111" })
              .mount("#card-number");
            cardComponent
              .createField("expiry", { placeholder: "MM / YY" })
              .mount("#card-expiry");
            cardComponent.createField("cvv", { placeholder: "CVV" }).mount("#card-cvv");
          })
          .catch(function (err) {
            console.error("Card components failed to load:", err);
            showError("Card fields failed to load (components module).");
          });

        // PayPal Payment Method Helper
        chargebee
          .load("paypal")
          .then(function (handler) {
            paypalHandler = handler;
          })
          .catch(function (err) {
            console.warn("PayPal handler unavailable:", err);
          });

        $("#paypal-button").addEventListener("click", handlePayPal);
        $("#pay-button").addEventListener("click", handleCardPayment);
      })
      .catch(function (err) {
        console.error("Init failed:", err);
        showError("Failed to load checkout configuration. Is the server running?");
      });
  }

  init();
})();
