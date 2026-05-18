const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const sequelize = require("./config/database");
const setupAdminPanel = require("./config/adminjs");
const { Payment, Card } = require("./models");
const { settlePaymentToSeller } = require("./controllers/payment.controller");
const { wallet } = require("./utils/blockchain");
const { Op } = require("sequelize");

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 5000);
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!process.env.ADMIN_JS_TMP_DIR) {
  process.env.ADMIN_JS_TMP_DIR = path.join(__dirname, ".adminjs");
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors());

// Body Parser Middleware
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/admin")) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("ETag", undefined);
    if (req.method === "GET") res.set("Last-Modified", new Date().toUTCString());
  }

  const isAdminJsInternalRoute =
    (req.originalUrl === "/admin" || req.originalUrl.startsWith("/admin/")) &&
    !req.originalUrl.startsWith("/admin/cards/") &&
    !req.originalUrl.startsWith("/admin/refund") &&
    !req.originalUrl.startsWith("/admin/profit/") &&
    !req.originalUrl.startsWith("/admin/add-card");

  if (isAdminJsInternalRoute) return next();

  jsonParser(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser(req, res, next);
  });
});

app.use(express.static(__dirname));

// Routes
app.use("/auth", require("./routes/auth.routes"));
app.use("/buyer", require("./routes/buyer.routes"));
app.use("/seller", require("./routes/seller.routes"));
app.use("/admin", require("./routes/admin.routes"));
app.use("/", require("./routes/public.routes"));

// Cron Job
cron.schedule("* * * * *", async () => {
  try {
    const MAIN_BUSINESS_ACCOUNT = process.env.MAIN_BUSINESS_ACCOUNT || (wallet ? wallet.address : "");
    if (!wallet || !MAIN_BUSINESS_ACCOUNT) return;
    const now = new Date();
    const duePayments = await Payment.findAll({
      where: { status: "holding", release_at: { [Op.lte]: now } },
    });

    for (const payment of duePayments) {
      try {
        await settlePaymentToSeller({ paymentId: payment.id });
      } catch (err) {
        console.error(`Settlement failed for payment ${payment.id}:`, err.message);
      }
    }

    // Find expired pending payment intents
    const expiredPayments = await Payment.findAll({
      where: { status: "pending", expires_at: { [Op.lte]: now } },
    });

    if (expiredPayments.length > 0) {
      const expiredCardIds = expiredPayments.map(p => p.card_id).filter(Boolean);

      // Restore reserved cards back to active
      if (expiredCardIds.length > 0) {
        await Card.update(
          { status: "active" },
          { where: { id: expiredCardIds, status: "reserved" } }
        );
        console.log(`[CRON] Restored ${expiredCardIds.length} reserved card(s) to active after payment expiry.`);
      }

      // Mark expired payments
      await Payment.update(
        { status: "expired" },
        { where: { id: expiredPayments.map(p => p.id) } }
      );
      console.log(`[CRON] Marked ${expiredPayments.length} expired payment intent(s).`);
    }
  } catch (err) {
    console.error("Cron release task failed:", err.message);
  }
});

// Startup
async function start() {
  await sequelize.authenticate();
  try {
    await sequelize.query('ALTER TABLE payments ADD COLUMN expires_at DATETIME;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN fiat_amount REAL;');
    await sequelize.query('ALTER TABLE payments ADD COLUMN fiat_currency VARCHAR(255);');
  } catch (e) {
    // Columns might already exist, ignore errors safely
  }
  await sequelize.sync();
  console.log("Database synced");
  await setupAdminPanel(app);
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
