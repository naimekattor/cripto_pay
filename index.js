const express = require("express");
const cron = require("node-cron");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // Essential for session cookies behind proxies/tunnels

const PORT = Number(process.env.PORT || 3000);

const DB_PATH = path.join(__dirname, "payments.db");
const UPLOAD_DIR = path.join(__dirname, "uploads");

// ---------------------------------------------------------
// Configuration & Providers
// ---------------------------------------------------------
const providerUrl =
  process.env.RPC_URL ||
  `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ""}`;
const provider = new ethers.JsonRpcProvider(providerUrl);
const privateKey = process.env.METAMASK_PRIVATE_KEY;
const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;

const MAIN_BUSINESS_ACCOUNT = process.env.MAIN_BUSINESS_ACCOUNT || "";
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const ADMIN_PANEL_EMAIL = process.env.ADMIN_PANEL_EMAIL || "admin@example.com";
const ADMIN_PANEL_PASSWORD =
  process.env.ADMIN_PANEL_PASSWORD || "change-this-password";
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  "change-this-session-secret-to-at-least-32-characters";
const HOLD_HOURS = 24;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------
// Middleware (Conditional Body Parsing)
// ---------------------------------------------------------
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  // Skip body parsing for AdminJS routes as it uses its own parser (formidable)
  if (req.originalUrl.startsWith("/admin")) {
    return next();
  }
  jsonParser(req, res, (err) => {
    if (err) return next(err);
    urlencodedParser(req, res, next);
  });
});

app.use(express.static(__dirname));

// ---------------------------------------------------------
// Database & Models (Sequelize)
// ---------------------------------------------------------
const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: DB_PATH,
  logging: false,
});

const Card = sequelize.define(
  "Card",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    price: { type: DataTypes.FLOAT, allowNull: false },
    file_path: { type: DataTypes.STRING, allowNull: false },
    status: {
      type: DataTypes.STRING,
      defaultValue: "active",
      validate: { isIn: [["active", "sold"]] },
    },
  },
  { tableName: "cards", timestamps: false }
);

const Payment = sequelize.define(
  "Payment",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    external_id: { type: DataTypes.STRING, unique: true },
    amount: { type: DataTypes.FLOAT, allowNull: false },
    user_address: { type: DataTypes.STRING },
    status: {
      type: DataTypes.STRING,
      defaultValue: "pending",
      validate: { isIn: [["pending", "holding", "completed", "returned"]] },
    },
    card_id: { type: DataTypes.INTEGER },
    release_at: { type: DataTypes.DATE },
    asset: { type: DataTypes.STRING, defaultValue: "ETH" },
    asset_decimals: { type: DataTypes.INTEGER, defaultValue: 18 },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "payments", timestamps: false }
);

Payment.belongsTo(Card, { foreignKey: "card_id", as: "card" });

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function normalizeAsset(asset, category) {
  const upper = (asset || "").toUpperCase();
  if (upper === "USDC") return "USDC";
  if (upper === "ETH") return "ETH";
  if (!upper && (category === "external" || category === "internal")) {
    return "ETH";
  }
  return upper || "";
}

function supportedIncomingAsset(asset) {
  return asset === "ETH" || asset === "USDC";
}

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function withinExpectedAmount(expected, actual, asset) {
  const tolerance = asset === "USDC" ? 0.000001 : 0.0000000001;
  return Math.abs(Number(expected) - Number(actual)) <= tolerance;
}

function computeReleaseAt() {
  const releaseDate = new Date();
  releaseDate.setHours(releaseDate.getHours() + HOLD_HOURS);
  return releaseDate;
}

async function transferFunds({ to, amount, asset, decimals }) {
  if (!wallet) throw new Error("Wallet is not configured.");

  if (asset === "USDC") {
    if (!USDC_CONTRACT_ADDRESS) throw new Error("USDC_CONTRACT_ADDRESS not set.");
    const erc20Abi = ["function transfer(address to, uint256 amount) returns (bool)"];
    const token = new ethers.Contract(USDC_CONTRACT_ADDRESS, erc20Abi, wallet);
    const units = ethers.parseUnits(String(amount), Number(decimals || 6));
    const tx = await token.transfer(to, units);
    await tx.wait();
    return tx.hash;
  }

  const tx = await wallet.sendTransaction({
    to,
    value: ethers.parseEther(String(amount)),
  });
  await tx.wait();
  return tx.hash;
}

async function refundPaymentByLookup({ txHash, paymentId }) {
  if (!wallet) throw new Error("Wallet not configured for refunds.");

  const payment = txHash
    ? await Payment.findOne({ where: { external_id: txHash } })
    : await Payment.findByPk(paymentId);

  if (!payment) throw new Error("Payment not found.");
  if (!["holding", "completed"].includes(payment.status))
    throw new Error("Payment not eligible for refund.");
  if (!payment.user_address) throw new Error("Missing user_address for refund.");

  const refundTxHash = await transferFunds({
    to: payment.user_address,
    amount: payment.amount,
    asset: normalizeAsset(payment.asset, ""),
    decimals: payment.asset_decimals,
  });

  payment.status = "returned";
  await payment.save();

  if (payment.card_id) {
    const card = await Card.findByPk(payment.card_id);
    if (card) {
      card.status = "active";
      await card.save();
    }
  }

  return { payment, refundTxHash };
}

// ---------------------------------------------------------
// Multer Configuration
// ---------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeOriginal = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeOriginal}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ---------------------------------------------------------
// Auth Middleware
// ---------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next();
  const key = req.header("x-admin-key") || req.query.admin_key || req.body.admin_key || "";
  if (key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized admin request." });
  }
  return next();
}

// ---------------------------------------------------------
// API Routes
// ---------------------------------------------------------

// Admin - Add Card (Manual API)
app.post("/admin/add-card", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const { name, description = "", price } = req.body;
    const amount = parseAmount(price);

    if (!name || !amount || !req.file) {
      if (req.file?.path) fs.unlink(req.file.path, () => undefined);
      return res.status(400).json({ error: "name, price and file are required." });
    }

    const card = await Card.create({
      name: name.trim(),
      description: description.trim(),
      price: amount,
      file_path: req.file.path,
      status: "active",
    });

    return res.status(201).json({ message: "Card added successfully.", card_id: card.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Public - Get Active Cards
app.get("/cards", async (_req, res) => {
  try {
    const cards = await Card.findAll({
      where: { status: "active" },
      attributes: ["id", "name", "description", "price", "status"],
      order: [["id", "DESC"]],
    });
    return res.json(cards);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Public - Buy Card
app.post("/buy", async (req, res) => {
  try {
    const cardId = Number(req.body.card_id);
    const card = await Card.findByPk(cardId);
    if (!card || card.status !== "active") {
      return res.status(404).json({ error: "Card is not available." });
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: cardId, status: { [Op.in]: ["pending", "holding"] } },
    });
    if (existingPayment) {
      return res.status(409).json({ error: "A payment flow already exists for this card." });
    }

    const intent = await Payment.create({
      amount: card.price,
      status: "pending",
      card_id: card.id,
      asset: "ETH",
      asset_decimals: 18,
    });

    return res.status(201).json({
      message: "Payment intent created.",
      payment_id: intent.id,
      card_id: card.id,
      amount: card.price,
      asset: "ETH",
      pay_to: wallet ? wallet.address : "WALLET_NOT_CONFIGURED",
      hold_period_hours: HOLD_HOURS,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Webhook - Alchemy
app.post("/alchemy-webhook", async (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));
  const activities = req.body?.event?.activity;


  const serverAddress = (wallet?.address || "").toLowerCase();
  const handled = [];
  const ignored = [];

  for (const activity of activities) {
    try {
      const hash = activity.hash;
      const fromAddress = (activity.fromAddress || "").toLowerCase();
      const toAddress = (activity.toAddress || "").toLowerCase();
      const asset = normalizeAsset(activity.asset, activity.category);
      const amount = parseAmount(activity.value);
      const decimals = Number(activity?.rawContract?.decimals || 18);

      if (!hash || !fromAddress || !toAddress || !amount) {
        ignored.push({ reason: "missing_fields", hash: hash || null });
        continue;
      }
      if (serverAddress && toAddress !== serverAddress) {
        ignored.push({ reason: "not_incoming_to_server_wallet", hash });
        continue;
      }
      if (!supportedIncomingAsset(asset)) {
        ignored.push({ reason: "unsupported_asset", hash, asset });
        continue;
      }

      const existing = await Payment.findOne({ where: { external_id: hash } });
      if (existing) {
        ignored.push({ reason: "already_processed", hash, status: existing.status });
        continue;
      }

      const pendingPayments = await Payment.findAll({
        where: { status: "pending", amount: amount, asset: asset },
        include: [{ model: Card, as: "card", where: { status: "active" } }],
        order: [["id", "ASC"]],
      });

      if (pendingPayments.length === 0) {
        ignored.push({ reason: "no_matching_pending_intent", hash, amount, asset });
        continue;
      }

      const pending = pendingPayments[0];
      pending.external_id = hash;
      pending.user_address = fromAddress;
      pending.status = "holding";
      pending.release_at = computeReleaseAt();
      pending.asset_decimals = decimals;
      await pending.save();

      const card = await Card.findByPk(pending.card_id);
      if (card) {
        card.status = "sold";
        await card.save();
      }

      handled.push({ payment_id: pending.id, card_id: pending.card_id, tx_hash: hash });
    } catch (error) {
      ignored.push({ reason: "processing_error", hash: activity?.hash, error: error.message });
    }
  }

  return res.status(200).json({ message: "Webhook processed.", handled, ignored });
});

// Admin - Refund (Manual API)
app.post("/admin/refund", requireAdmin, async (req, res) => {
  try {
    const txHash = String(req.body.tx_hash || req.body.external_id || "").trim();
    const paymentId = req.body.payment_id ? Number(req.body.payment_id) : null;

    const { payment, refundTxHash } = await refundPaymentByLookup({
      txHash: txHash || null,
      paymentId,
    });

    return res.json({ message: "Refund executed.", payment_id: payment.id, refund_tx_hash: refundTxHash });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Public - Download Card
app.get("/download/:tx_hash", async (req, res) => {
  try {
    const txHash = String(req.params.tx_hash || "").trim();
    const payment = await Payment.findOne({
      where: { external_id: txHash },
      include: [{ model: Card, as: "card" }],
    });

    if (!payment || !payment.card) return res.status(404).json({ error: "Payment not found." });
    if (!["holding", "completed"].includes(payment.status)) {
      return res.status(403).json({ error: "Download not allowed.", status: payment.status });
    }

    const absolutePath = path.resolve(payment.card.file_path);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({ error: "Invalid file path." });
    }
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: "File not found." });

    return res.download(absolutePath);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// AdminJS Configuration
// ---------------------------------------------------------
async function setupAdminPanel() {
  const [{ default: AdminJS }, { default: AdminJSExpress }, AdminJSSequelize] =
    await Promise.all([
      import("adminjs"),
      import("@adminjs/express"),
      import("@adminjs/sequelize"),
    ]);

  AdminJS.registerAdapter(AdminJSSequelize);

  const admin = new AdminJS({
    rootPath: "/admin",
    branding: { companyName: "Gift Card Admin" },
    resources: [
      {
        resource: Card,
        options: {
          navigation: { name: "Catalog", icon: "Product" },
          listProperties: ["id", "name", "price", "status"],
        },
      },
      {
        resource: Payment,
        options: {
          navigation: { name: "Payments", icon: "Payment" },
          listProperties: ["id", "external_id", "amount", "asset", "status", "card_id", "release_at"],
          actions: {
            new: { isAccessible: false },
            delete: { isAccessible: false },
            refund: {
              actionType: "record",
              component: false,
              icon: "Undo",
              guard: "Refund this payment?",
              isVisible: ({ record }) => ["holding", "completed"].includes(record.params.status),
              handler: async (request, _response, context) => {
                const { record, currentAdmin } = context;
                if (request.method !== "post") return { record: record.toJSON(currentAdmin) };
                try {
                  const { payment } = await refundPaymentByLookup({ paymentId: record.params.id });
                  return {
                    record: context.resource.build(payment).toJSON(currentAdmin),
                    notice: { message: "Refund successful.", type: "success" },
                  };
                } catch (err) {
                  return { record: record.toJSON(currentAdmin), notice: { message: err.message, type: "error" } };
                }
              },
            },
          },
        },
      },
    ],
  });

  const adminRouter = AdminJSExpress.buildAuthenticatedRouter(
    admin,
    {
      authenticate: async (email, password) => {
        if (email === ADMIN_PANEL_EMAIL && password === ADMIN_PANEL_PASSWORD) {
          return { email };
        }
        return null;
      },
      cookieName: "adminjs_session",
      cookiePassword: ADMIN_SESSION_SECRET,
    },
    null,
    {
      secret: ADMIN_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      },
    }
  );

  app.get("/admin", (req, res) => res.redirect("/admin/resources/Payment"));
  app.get("/admin/", (req, res) => res.redirect("/admin/resources/Payment"));

  app.use(admin.options.rootPath, adminRouter);
}

// ---------------------------------------------------------
// Cron Job & Health
// ---------------------------------------------------------
cron.schedule("0 * * * *", async () => {
  try {
    if (!wallet || !MAIN_BUSINESS_ACCOUNT) return;
    const now = new Date();
    const duePayments = await Payment.findAll({
      where: { status: "holding", release_at: { [Op.lte]: now } },
    });

    for (const payment of duePayments) {
      try {
        await transferFunds({
          to: MAIN_BUSINESS_ACCOUNT,
          amount: payment.amount,
          asset: normalizeAsset(payment.asset, ""),
          decimals: payment.asset_decimals,
        });
        payment.status = "completed";
        await payment.save();
      } catch (err) {
        console.error(`Settlement failed for payment ${payment.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Cron release task failed:", err.message);
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", wallet: wallet?.address || null });
});

// ---------------------------------------------------------
// Startup
// ---------------------------------------------------------
async function start() {
  await sequelize.authenticate();
  await sequelize.sync();
  await setupAdminPanel();
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});
