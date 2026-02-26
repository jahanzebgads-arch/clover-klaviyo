const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const CLOVER_API_TOKEN = process.env.CLOVER_API_TOKEN;
const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;
const PORT = process.env.PORT || 3000;

const RENDER_URL = process.env.RENDER_URL || "https://clover-klaviyo.onrender.com";
const CLOVER_BASE = `https://api.clover.com/v3/merchants/${CLOVER_MERCHANT_ID}`;
const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const WEBHOOK_URL = `${RENDER_URL}/webhook/clover`;

// ── Auto-register Clover Webhook ─────────────────────────────────────────────
async function registerCloverWebhook() {
  try {
    console.log("🔧 Checking Clover webhooks...");

    // Fetch existing webhooks
    const existing = await axios.get(`${CLOVER_BASE}/webhook_configs`, {
      headers: { Authorization: `Bearer ${CLOVER_API_TOKEN}` },
    });

    const webhooks = existing.data?.elements || [];
    const alreadyRegistered = webhooks.find((w) => w.url === WEBHOOK_URL);

    if (alreadyRegistered) {
      console.log("✅ Clover webhook already registered:", WEBHOOK_URL);
      return;
    }

    // Register new webhook
    await axios.post(
      `${CLOVER_BASE}/webhook_configs`,
      {
        url: WEBHOOK_URL,
        eventTypes: ["PAYMENT"],
      },
      {
        headers: {
          Authorization: `Bearer ${CLOVER_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Clover webhook registered successfully:", WEBHOOK_URL);
  } catch (err) {
    console.error("⚠️ Could not auto-register Clover webhook:", err.response?.data || err.message);
    console.log("👉 Please register manually in Clover dashboard:");
    console.log(`   URL: ${WEBHOOK_URL}`);
    console.log("   Event: PAYMENT");
  }
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Clover → Klaviyo middleware is running ✅"));

// ── Clover Webhook ────────────────────────────────────────────────────────────
app.post("/webhook/clover", async (req, res) => {
  try {
    const payload = req.body;
    console.log("📦 Clover webhook received:", JSON.stringify(payload, null, 2));

    // Clover sends an array of events
    const events = Array.isArray(payload) ? payload : [payload];

    for (const event of events) {
      // We only care about payment events
      if (event.type !== "CREATE" || event.objectType !== "PAYMENT") continue;

      const paymentId = event.objectId;
      if (!paymentId) continue;

      console.log(`💳 Processing payment: ${paymentId}`);

      // 1. Fetch payment details
      const paymentRes = await axios.get(`${CLOVER_BASE}/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${CLOVER_API_TOKEN}` },
      });
      const payment = paymentRes.data;
      const amountDollars = (payment.amount || 0) / 100;
      const orderId = payment.order?.id;

      if (!orderId) {
        console.log("⚠️ No order ID found on payment, skipping.");
        continue;
      }

      // 2. Fetch order to get customer
      const orderRes = await axios.get(`${CLOVER_BASE}/orders/${orderId}?expand=customers`, {
        headers: { Authorization: `Bearer ${CLOVER_API_TOKEN}` },
      });
      const order = orderRes.data;
      const customerId = order.customers?.elements?.[0]?.id;

      if (!customerId) {
        console.log("⚠️ No customer attached to order, skipping.");
        continue;
      }

      // 3. Fetch full customer details
      const customerRes = await axios.get(`${CLOVER_BASE}/customers/${customerId}?expand=emailAddresses,phoneNumbers`, {
        headers: { Authorization: `Bearer ${CLOVER_API_TOKEN}` },
      });
      const customer = customerRes.data;

      const email = customer.emailAddresses?.elements?.[0]?.emailAddress || null;
      const phone = customer.phoneNumbers?.elements?.[0]?.phoneNumber || null;
      const firstName = customer.firstName || "";
      const lastName = customer.lastName || "";

      if (!email) {
        console.log("⚠️ Customer has no email, skipping Klaviyo sync.");
        continue;
      }

      console.log(`👤 Customer: ${firstName} ${lastName} | ${email} | $${amountDollars}`);

      // 4. Upsert Klaviyo profile
      const profileRes = await axios.post(
        `${KLAVIYO_BASE}/profiles/`,
        {
          data: {
            type: "profile",
            attributes: {
              email,
              first_name: firstName,
              last_name: lastName,
              phone_number: phone || undefined,
              properties: {
                clover_customer_id: customerId,
              },
            },
          },
        },
        {
          headers: {
            Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
            "Content-Type": "application/json",
            revision: "2024-02-15",
          },
        }
      );

      const profileId =
        profileRes.data?.data?.id ||
        profileRes.headers?.location?.split("/").pop();

      console.log(`✅ Klaviyo profile upserted: ${profileId}`);

      // 5. Add profile to list
      if (KLAVIYO_LIST_ID && profileId) {
        await axios.post(
          `${KLAVIYO_BASE}/lists/${KLAVIYO_LIST_ID}/relationships/profiles/`,
          {
            data: [{ type: "profile", id: profileId }],
          },
          {
            headers: {
              Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
              "Content-Type": "application/json",
              revision: "2024-02-15",
            },
          }
        );
        console.log(`✅ Profile added to Klaviyo list: ${KLAVIYO_LIST_ID}`);
      }

      // 6. Track purchase event
      await axios.post(
        `${KLAVIYO_BASE}/events/`,
        {
          data: {
            type: "event",
            attributes: {
              metric: {
                data: {
                  type: "metric",
                  attributes: { name: "Clover Purchase" },
                },
              },
              profile: {
                data: {
                  type: "profile",
                  attributes: { email },
                },
              },
              properties: {
                dollars_spent: amountDollars,
                order_id: orderId,
                payment_id: paymentId,
                currency: "USD",
              },
              value: amountDollars,
            },
          },
        },
        {
          headers: {
            Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
            "Content-Type": "application/json",
            revision: "2024-02-15",
          },
        }
      );

      console.log(`🎉 Klaviyo event tracked: Clover Purchase $${amountDollars}`);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).send("Error processing webhook");
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await registerCloverWebhook();
});
