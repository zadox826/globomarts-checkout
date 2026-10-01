/* ---------------------------------------------------------------------------
   PayPal-only checkout page (checkout-paypal.html)
   - Chargebee.js Payment Method Helper: chargebee.load("paypal")
   - Subscription created server-side with the authorized payment intent id
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var PRICE = null;
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
        state: $("#state").value.trim(),
        zip: $("#zip").value.trim(),
        country: $("#country").value,
      },
    };
  }

  function validateForm(data) {
    if (!data.customer.first_name || !data.customer.last_name || !data.customer.email) {
      showError("Bitte füllen Sie Vorname, Nachname und E-Mail-Adresse aus.");
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
            "Zahlung konnte nicht gestartet werden";
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
            "Abo konnte nicht erstellt werden";
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  /* ------------------------- PayPal flow ------------------------- */
  function handlePayPal() {
    clearError();
    var data = collectFormData();
    if (!validateForm(data)) return;

    var btn = $("#paypal-button");
    btn.disabled = true;
    btn.textContent = "Weiterleitung zu PayPal…";

    if (!paypalHandler) {
      showError(
        "PayPal ist noch nicht verbunden. Verbinden Sie ein PayPal-Gateway in " +
          "Chargebee (Einstellungen > Chargebee konfigurieren > Zahlungs-Gateways) " +
          "und laden Sie diese Seite neu."
      );
      btn.disabled = false;
      btn.textContent = "Mit PayPal bezahlen";
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
        showError(err.message || "PayPal-Zahlung fehlgeschlagen. Bitte versuchen Sie es erneut.");
        btn.disabled = false;
        btn.textContent = "Mit PayPal bezahlen";
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
        var config = results[0];
        PRICE = results[1];

        // Order overview card — server-driven price (auto-updates to € once EUR is enabled)
        $("#price-line").textContent = PRICE.formatted;
        $("#total-amount").textContent = PRICE.formatted;

        if (!config.publishableKey) {
          showError(
            "Fehlender Publishable Key. Fügen Sie CHARGEBEE_PUBLISHABLE_KEY zu Ihrer " +
              ".env-Datei hinzu (siehe README) und starten Sie den Server neu."
          );
          return;
        }

        var chargebee = Chargebee.init({
          site: config.site,
          publishableKey: config.publishableKey,
          isItemsModel: true,
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
      })
      .catch(function (err) {
        console.error("Init failed:", err);
        showError("Checkout-Konfiguration konnte nicht geladen werden. Läuft der Server?");
      });
  }

  init();
})();
