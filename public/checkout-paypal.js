/* ---------------------------------------------------------------------------
   PayPal-only checkout page (checkout-paypal.html)
   - Real Chargebee PayPal Payment Method Helper flow:
       chargebee.load("paypal")
         -> createPaymentIntent("paypal_express_checkout")
         -> paypalHandler.setPaymentIntent(intent)
         -> paypalHandler.mountPaymentButton(selector, { style })  [awaited]
         -> paypalHandler.handlePayment({ click, cancel, success, error })
   - IMPORTANT: handlePayment() may only be armed AFTER mountPaymentButton()
     resolves. The SDK assigns its internal gatewayHandler during mount;
     arming earlier throws "Cannot read properties of undefined (reading
     'handlePayment')" and leaves the PayPal button without callbacks.
   - The click callback validates the form BEFORE PayPal opens:
     invalid  -> German error banner, PayPal does NOT open
     valid    -> PayPal popup opens
   - Subscription is created server-side with the authorized payment intent id,
     then the user is redirected to /success.
--------------------------------------------------------------------------- */
(function () {
  "use strict";

  var PRICE = null;
  // Product handle from the storefront link: /pay/<handle> -> /checkout-paypal?p=<handle>
  var PARAM_PRICE = new URLSearchParams(window.location.search).get("p") || null;
  // Host-scoped branding: holzundherd.shop is a separate storefront on the same service.
  var BRAND = /(^|\.)holzundherd\.shop$/i.test(window.location.hostname)
    ? "holzundherd"
    : "GLOBOMARTS";
  // Apply logo + title immediately (script runs at end of body; independent of API availability)
  document.title = BRAND + " – Kasse";
  var __logoEl = document.querySelector(".checkout-logo");
  if (__logoEl) __logoEl.textContent = BRAND;
  var paypalHandler = null;
  var paymentIntent = null;
  var processing = false;
  var armCount = 0;
  var MAX_ARMS = 4; // safety cap against endless re-arm loops

  var VALIDATION_ERROR =
    "Bitte füllen Sie zuerst alle Pflichtfelder aus.";
  var GATEWAY_ERROR =
    "PayPal ist noch nicht verbunden. Verbinden Sie ein PayPal-Gateway in " +
    "Chargebee (Einstellungen > Chargebee konfigurieren > Zahlungs-Gateways) " +
    "und laden Sie diese Seite neu.";
  var GENERIC_PAYMENT_ERROR =
    "PayPal-Zahlung fehlgeschlagen. Bitte versuchen Sie es erneut.";
  var SUBSCRIPTION_ERROR =
    "Zahlung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.";
  var ARM_CAP_ERROR =
    "PayPal-Zahlung fehlgeschlagen. Bitte laden Sie die Seite neu.";

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
    if (
      !data.customer.first_name ||
      !data.customer.last_name ||
      !data.customer.email ||
      !data.billing_address.line1 ||
      !data.billing_address.city ||
      !data.billing_address.zip ||
      !data.billing_address.country ||
      !data.billing_address.state
    ) {
      return false;
    }
    return true;
  }

  function createPaymentIntent(paymentMethodType) {
    return fetch("/api/payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment_method_type: paymentMethodType,
        item_price_id: PARAM_PRICE ? PARAM_PRICE + "-eur" : undefined,
      }),
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
        item_price_id: PARAM_PRICE ? PARAM_PRICE + "-eur" : undefined,
        customer: data.customer,
        billing_address: data.billing_address,
      }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var msg =
            (body.details && body.details.message) ||
            body.error ||
            SUBSCRIPTION_ERROR;
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  /* ------------------------- PayPal flow ------------------------- */

  // (Re-)arms the payment callbacks. The callbackHandler keeps the callbacks
  // object across attempts, but each handlePayment() call installs fresh
  // promise resolvers, so we re-arm after real errors and cancellations.
  // Validation rejections do NOT re-arm (the persistent callbacks keep the
  // click gating working) and do not consume the arm cap.
  function armPayPal() {
    if (!paypalHandler || !paymentIntent) return;
    if (armCount >= MAX_ARMS) {
      showError(ARM_CAP_ERROR);
      return;
    }
    armCount += 1;
    try {
      paypalHandler
        .handlePayment({
          click: function () {
            // Runs when the user clicks the PayPal button, BEFORE the popup opens.
            clearError();
            if (processing) {
              throw new Error("PAYMENT_IN_PROGRESS");
            }
            var data = collectFormData();
            if (!validateForm(data)) {
              showError(VALIDATION_ERROR);
              throw new Error("VALIDATION_FAILED");
            }
          },
          cancel: function () {
            // User closed the PayPal popup without paying.
            armPayPal();
          },
          success: function (authorizedIntent) {
            // PayPal authorized the payment -> create the subscription.
            processing = true;
            createSubscription(authorizedIntent.id)
              .then(function () {
                window.location.href = "/success";
              })
              .catch(function (err) {
                console.error("Subscription creation failed:", err);
                processing = false;
                showError(err.message || SUBSCRIPTION_ERROR);
                armPayPal();
              });
          },
          error: function (intent, err) {
            if (processing) return; // error already handled by the success path
            // If the banner is already visible, this is the validation-rejection
            // echo (click callback threw) -> keep the validation message and the
            // persistent callbacks; do NOT re-arm.
            if (!$("#error-banner").hidden) return;
            console.error("PayPal payment error:", err);
            showError((err && err.message) || GENERIC_PAYMENT_ERROR);
            armPayPal();
          },
        })
        .catch(function (err) {
          console.warn("handlePayment rejected:", err);
        });
    } catch (e) {
      // The SDK wrapper can throw synchronously if its internal gateway
      // handler is not ready yet — never let that break the page.
      console.warn("handlePayment threw synchronously:", e);
    }
  }

  // Mounts the real PayPal smart button into a holder next to the custom
  // button, then hides the custom button.
  function mountPayPalButton() {
    var customBtn = $("#paypal-button");
    var holder = document.createElement("div");
    holder.id = "paypal-button-holder";
    holder.className = "paypal-button-holder";
    customBtn.parentNode.insertBefore(holder, customBtn.nextSibling);
    customBtn.hidden = true;
    // The SDK assigns its internal gatewayHandler DURING mount (async).
    // handlePayment() must only run AFTER mount resolves — otherwise the
    // wrapper throws "Cannot read properties of undefined (reading
    // 'handlePayment')" and the real button ends up without callbacks.
    return paypalHandler
      .mountPaymentButton("#paypal-button-holder", {
        style: { size: "responsive" },
      })
      .then(function () {
        armPayPal();
      })
      .catch(function (err) {
        console.error("PayPal button mount failed:", err);
        failSetup(GATEWAY_ERROR);
      });
  }

  function failSetup(msg) {
    var customBtn = $("#paypal-button");
    customBtn.hidden = true;
    showError(msg);
  }

  /* ------------------------- Init ------------------------- */
  function init() {
    var customBtn = $("#paypal-button");
    customBtn.disabled = true;
    customBtn.textContent = "PayPal wird geladen…";

    Promise.all([
      fetch("/api/config").then(function (r) {
        return r.json();
      }),
      fetch("/api/price" + (PARAM_PRICE ? "?id=" + encodeURIComponent(PARAM_PRICE) : "")).then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        var config = results[0];
        PRICE = results[1];

        // Order overview card — server-driven price
        $("#price-line").textContent = PRICE.formatted;
        $("#total-amount").textContent = PRICE.formatted;

        // Product name above the order card (one-time product checkout)
        if (PRICE.name) {
          var nameEl = document.createElement("div");
          nameEl.className = "product-name";
          nameEl.textContent = PRICE.name;
          var priceLine = $(".price-line");
          if (priceLine) {
            priceLine.parentNode.insertBefore(nameEl, priceLine);
          }
        }

        if (!config.publishableKey) {
          failSetup(
            "Fehlender Publishable Key. Fügen Sie CHARGEBEE_PUBLISHABLE_KEY zu " +
              "Ihrer .env-Datei hinzu (siehe README) und starten Sie den Server neu."
          );
          return;
        }

        var chargebee = Chargebee.init({
          site: config.site,
          publishableKey: config.publishableKey,
          isItemsModel: true,
        });

        // 1) Load the PayPal Payment Method Helper
        chargebee
          .load("paypal")
          .then(function (handler) {
            paypalHandler = handler;
            // 2) Create the payment intent for PayPal Express Checkout
            return createPaymentIntent("paypal_express_checkout");
          })
          .then(function (intent) {
            paymentIntent = intent;
            // 3) Attach the intent to the helper
            paypalHandler.setPaymentIntent(intent);
            // 4) Mount the real PayPal button, THEN arm the callbacks
            return mountPayPalButton();
          })
          .catch(function (err) {
            console.error("PayPal setup failed:", err);
            failSetup(GATEWAY_ERROR);
          });
      })
      .catch(function (err) {
        console.error("Init failed:", err);
        failSetup(
          "Checkout-Konfiguration konnte nicht geladen werden. Läuft der Server?"
        );
      });
  }

  init();
})();
