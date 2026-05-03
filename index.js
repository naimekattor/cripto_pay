const express = require("express");
const cron = require("node-cron");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { ethers } = require("ethers");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // Essential for session cookies behind proxies/tunnels

const PORT = Number(process.env.PORT || 3000);

const DB_PATH = path.join(__dirname, "payments.db");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const JWT_SECRET = process.env.JWT_SECRET || "your-very-secure-jwt-secret-key-here";

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

app.use(cors());

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

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.STRING, validate: { isIn: [["buyer", "seller", "admin"]] }, defaultValue: "buyer" },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "users", timestamps: false }
);

const Card = sequelize.define(
  "Card",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    price: { type: DataTypes.FLOAT, allowNull: false },
    file_path: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.STRING,
      defaultValue: "active",
      validate: { isIn: [["active", "sold", "cancelled"]] },
    },
    retailer_wallet_address: { type: DataTypes.STRING },
    seller_wallet_address: { type: DataTypes.STRING },
    card_code: { type: DataTypes.STRING },
    card_pin: { type: DataTypes.STRING },
    retailer: { type: DataTypes.STRING },
    denomination: { type: DataTypes.FLOAT },
    region: { type: DataTypes.STRING, defaultValue: "USA" },
    currency: { type: DataTypes.STRING, defaultValue: "USD" },
    seller_id: { type: DataTypes.INTEGER },
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
    buyer_id: { type: DataTypes.INTEGER },
    release_at: { type: DataTypes.DATE },
    asset: { type: DataTypes.STRING, defaultValue: "ETH" },
    asset_decimals: { type: DataTypes.INTEGER, defaultValue: 18 },
    complaint_status: { type: DataTypes.STRING, defaultValue: "none", validate: { isIn: [["none", "complained", "valid"]] } },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "payments", timestamps: false }
);

Card.belongsTo(User, { foreignKey: "seller_id", as: "seller" });
Payment.belongsTo(Card, { foreignKey: "card_id", as: "card" });
Payment.belongsTo(User, { foreignKey: "buyer_id", as: "buyer" });

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

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(403).json({ error: "Invalid token" });
      req.user = user;
      next();
    });
  } else {
    return res.status(401).json({ error: "Authentication token required" });
  }
}

// ---------------------------------------------------------
// API Routes
// ---------------------------------------------------------

// ---------------------------------------------------------
// Auth Routes
// ---------------------------------------------------------
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Email, password, and role are required." });
    }
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email already in use." });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password_hash, role });
    res.status(201).json({ message: "User registered successfully.", id: user.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role, email: user.email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// Buyer Dashboard Routes
// ---------------------------------------------------------
app.get("/buyer/payments", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer") return res.status(403).json({ error: "Access denied" });
  try {
    const payments = await Payment.findAll({
      where: { buyer_id: req.user.id },
      include: [{ model: Card, as: "card" }],
      order: [["id", "DESC"]],
    });
    res.json(payments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/buyer/payments/:id/complain", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer") return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({ where: { id: req.params.id, buyer_id: req.user.id } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["holding", "completed"].includes(payment.status)) {
      return res.status(400).json({ error: "Cannot complain about a payment in this status." });
    }
    if (payment.complaint_status !== "none") {
      return res.status(400).json({ error: "Complaint already filed or payment confirmed." });
    }

    // Auto refund
    const { refundTxHash } = await refundPaymentByLookup({ paymentId: payment.id });
    
    payment.complaint_status = "complained";
    // Refund sets payment status to 'returned'
    await payment.save();

    res.json({ message: "Complaint filed and funds returned.", refund_tx_hash: refundTxHash });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/buyer/payments/:id/confirm", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer") return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({ where: { id: req.params.id, buyer_id: req.user.id } });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (payment.complaint_status !== "none") {
      return res.status(400).json({ error: "Already confirmed or complained." });
    }
    
    payment.complaint_status = "valid";
    await payment.save();

    res.json({ message: "Card confirmed as valid." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// Seller Dashboard Routes
// ---------------------------------------------------------
app.get("/seller/cards", authenticateJWT, async (req, res) => {
  if (req.user.role !== "seller") return res.status(403).json({ error: "Access denied" });
  try {
    const cards = await Card.findAll({
      where: { seller_id: req.user.id },
      order: [["id", "DESC"]],
    });
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/seller/cards/:id/cancel", authenticateJWT, async (req, res) => {
  if (req.user.role !== "seller") return res.status(403).json({ error: "Access denied" });
  try {
    const card = await Card.findOne({ where: { id: req.params.id, seller_id: req.user.id } });
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "active") return res.status(400).json({ error: "Only active cards can be cancelled." });

    const existingPayment = await Payment.findOne({
      where: { card_id: card.id, status: { [Op.in]: ["pending", "holding"] } },
    });
    if (existingPayment) {
      return res.status(400).json({ error: "Cannot cancel card with a pending or holding payment." });
    }

    card.status = "cancelled";
    await card.save();

    res.json({ message: "Card cancelled successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// Exchange Rates API
// ---------------------------------------------------------
app.get("/exchange-rates", async (req, res) => {
  try {
    const response = await axios.get("https://open.er-api.com/v6/latest/USD");
    res.json(response.data.rates);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch exchange rates." });
  }
});

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

// Public - Sell Card
app.post("/cards/sell", authenticateJWT, upload.single("file"), async (req, res) => {
  try {
    if (req.user.role !== "seller") return res.status(403).json({ error: "Access denied" });
    const { retailer, value, price, card_code, card_pin, seller_wallet_address, region, currency } = req.body;
    const amount = parseAmount(price);
    const faceValue = parseAmount(value);

    if (!retailer || !amount || !faceValue || !card_code || !seller_wallet_address) {
      if (req.file?.path) fs.unlink(req.file.path, () => undefined);
      return res.status(400).json({ error: "retailer, price, value, card_code and seller_wallet_address are required." });
    }

    const card = await Card.create({
      name: `${retailer} - ${currency === "GBP" ? "£" : "$"}${value}`,
      description: `Gift card for ${retailer}`,
      price: amount,
      denomination: faceValue,
      file_path: req.file ? req.file.path : "",
      status: "active",
      retailer,
      card_code,
      card_pin,
      seller_wallet_address,
      region: region || "USA",
      currency: currency || "USD",
      seller_id: req.user.id,
    });

    return res.status(201).json({ message: "Card listed successfully.", card_id: card.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Public - Get Active Cards
app.get("/cards", async (_req, res) => {
  try {
    const cards = await Card.findAll({
      where: { status: "active" },
      attributes: ["id", "name", "description", "price", "status", "retailer", "denomination", "region", "currency"],
      order: [["id", "DESC"]],
    });
    return res.json(cards);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Public - Buy Card
app.post("/buy", authenticateJWT, async (req, res) => {
  try {
    if (req.user.role !== "buyer") return res.status(403).json({ error: "Access denied" });
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
      buyer_id: req.user.id,
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
          listProperties: ["id", "name", "price", "status", "retailer", "seller_wallet_address"],
          showProperties: ["id", "name", "description", "price", "status", "retailer", "seller_wallet_address", "card_code", "card_pin", "file_path"],
          editProperties: ["name", "description", "price", "status", "retailer", "seller_wallet_address", "card_code", "card_pin"],
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
        const card = await Card.findByPk(payment.card_id);
        const payoutAddress = (card && card.seller_wallet_address) ? card.seller_wallet_address : MAIN_BUSINESS_ACCOUNT;
        
        if (!payoutAddress) {
          console.error(`No payout address for payment ${payment.id}`);
          continue;
        }

        await transferFunds({
          to: payoutAddress,
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
