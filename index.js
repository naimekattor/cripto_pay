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
const nodemailer = require("nodemailer");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// AdminJS writes user components to ADMIN_JS_TMP_DIR when the bundler module loads.
// Default `.adminjs` is relative to process.cwd(), so `node ../backend/index.js` breaks the bundle path.
// Pin it next to this file so the custom dashboard always bundles and is served correctly.
if (!process.env.ADMIN_JS_TMP_DIR) {
  process.env.ADMIN_JS_TMP_DIR = path.join(__dirname, ".adminjs");
}

const app = express();
app.set("trust proxy", 1); // Essential for session cookies behind proxies/tunnels

const PORT = Number(process.env.PORT || 5000);

const DB_PATH = path.join(__dirname, "payments.db");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const JWT_SECRET =
  process.env.JWT_SECRET || "your-very-secure-jwt-secret-key-here";

// ---------------------------------------------------------
// Configuration & Providers
// ---------------------------------------------------------
const providerUrl =
  process.env.RPC_URL ||
  `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ""}`;
const provider = new ethers.JsonRpcProvider(providerUrl);
const privateKey = process.env.METAMASK_PRIVATE_KEY;
const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;

const MAIN_BUSINESS_ACCOUNT =
  process.env.MAIN_BUSINESS_ACCOUNT || (wallet ? wallet.address : "");
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
  // Apply no-cache headers to all AdminJS routes immediately to prevent 304/Refresh issues
  if (req.originalUrl.startsWith("/admin")) {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("ETag", undefined);

    if (req.method === "GET") {
      res.set("Last-Modified", new Date().toUTCString());
    }
  }

  // Skip body parsing for AdminJS UI/API routes to avoid conflicts with its internal parser
  const isAdminJsInternalRoute =
    (req.originalUrl === "/admin" || req.originalUrl.startsWith("/admin/")) &&
    !req.originalUrl.startsWith("/admin/cards/") &&
    !req.originalUrl.startsWith("/admin/refund") &&
    !req.originalUrl.startsWith("/admin/profit/") &&
    !req.originalUrl.startsWith("/admin/add-card");

  if (isAdminJsInternalRoute) {
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
  logging: console.log,
});

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    role: {
      type: DataTypes.STRING,
      validate: { isIn: [["buyer", "seller", "admin"]] },
      defaultValue: "buyer",
    },
    is_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
    verification_code: { type: DataTypes.STRING, allowNull: true },
    verification_code_expires: { type: DataTypes.DATE, allowNull: true },
    reset_password_code: { type: DataTypes.STRING, allowNull: true },
    reset_password_expires: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "users", timestamps: false },
);

const Card = sequelize.define(
  "Card",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    price: { type: DataTypes.FLOAT, allowNull: false }, // Final price shown to buyers (Admin defined)
    seller_asking_price: { type: DataTypes.FLOAT, allowNull: false }, // What the seller wants to receive
    file_path: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.STRING,
      defaultValue: "pending_approval",
      validate: {
        isIn: [["pending_approval", "active", "sold", "cancelled", "rejected"]],
      },
    },
    retailer_wallet_address: { type: DataTypes.STRING },
    seller_wallet_address: { type: DataTypes.STRING },
    card_code: { type: DataTypes.STRING },
    card_pin: { type: DataTypes.STRING },
    retailer: { type: DataTypes.STRING },
    retailer_wallet_address: { type: DataTypes.STRING },
    denomination: { type: DataTypes.FLOAT },
    region: { type: DataTypes.STRING, defaultValue: "USA" },
    currency: { type: DataTypes.STRING, defaultValue: "USD" },
    seller_id: { type: DataTypes.INTEGER },
  },
  { tableName: "cards", timestamps: false },
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
      validate: {
        isIn: [
          [
            "pending",
            "holding",
            "completed",
            "returned",
            "disputed",
            "refunded",
          ],
        ],
      },
    },
    card_id: { type: DataTypes.INTEGER },
    buyer_id: { type: DataTypes.INTEGER },
    release_at: { type: DataTypes.DATE },
    asset: { type: DataTypes.STRING, defaultValue: "ETH" },
    asset_decimals: { type: DataTypes.INTEGER, defaultValue: 18 },
    complaint_status: {
      type: DataTypes.STRING,
      defaultValue: "none",
      validate: {
        isIn: [
          [
            "none",
            "complained",
            "under_review",
            "resolved",
            "refunded",
            "completed",
          ],
        ],
      },
    },
    complaint_reason: { type: DataTypes.STRING },
    // Admin Profit Tracking Fields
    seller_payout_amount: { type: DataTypes.FLOAT },
    admin_profit: { type: DataTypes.FLOAT },
    payout_tx_hash: { type: DataTypes.STRING },
    profit_locked_until: { type: DataTypes.DATE },
    profit_status: {
      type: DataTypes.STRING,
      defaultValue: "none",
      validate: { isIn: [["none", "holding", "released", "withdrawn"]] },
    },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "payments", timestamps: false },
);

const AuditLog = sequelize.define(
  "AuditLog",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    admin_email: { type: DataTypes.STRING },
    action: { type: DataTypes.STRING },
    target_type: { type: DataTypes.STRING },
    target_id: { type: DataTypes.INTEGER },
    details: { type: DataTypes.TEXT },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "audit_logs", timestamps: false },
);

// Platform Profit Tracking Model
const PlatformProfit = sequelize.define(
  "PlatformProfit",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    payment_id: { type: DataTypes.INTEGER },
    card_id: { type: DataTypes.INTEGER },
    seller_id: { type: DataTypes.INTEGER },
    buyer_id: { type: DataTypes.INTEGER },
    total_amount: { type: DataTypes.FLOAT },
    seller_payout: { type: DataTypes.FLOAT },
    admin_profit: { type: DataTypes.FLOAT },
    asset: { type: DataTypes.STRING, defaultValue: "ETH" },
    asset_decimals: { type: DataTypes.INTEGER, defaultValue: 18 },
    status: {
      type: DataTypes.STRING,
      defaultValue: "holding",
      validate: { isIn: [["holding", "released", "withdrawn"]] },
    },
    locked_until: { type: DataTypes.DATE },
    released_at: { type: DataTypes.DATE },
    withdrawn_at: { type: DataTypes.DATE },
    withdraw_tx_hash: { type: DataTypes.STRING },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "platform_profits", timestamps: false },
);

Card.belongsTo(User, { foreignKey: "seller_id", as: "seller" });
Card.hasOne(Payment, { foreignKey: "card_id", as: "payment" });
Payment.belongsTo(Card, { foreignKey: "card_id", as: "card" });
Payment.belongsTo(User, { foreignKey: "buyer_id", as: "buyer" });
PlatformProfit.belongsTo(Payment, { foreignKey: "payment_id", as: "payment" });
PlatformProfit.belongsTo(Card, { foreignKey: "card_id", as: "card" });
PlatformProfit.belongsTo(User, { foreignKey: "seller_id", as: "seller" });
PlatformProfit.belongsTo(User, { foreignKey: "buyer_id", as: "buyer" });
AuditLog.belongsTo(User, { foreignKey: "admin_email", targetKey: "email", as: "admin" });
AuditLog.belongsTo(Payment, { foreignKey: "target_id", constraints: false, as: "payment" });

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
async function sendEmail({ to, subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from: `"GiftCard Crypto" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
  } catch (error) {
    console.error(`[EMAIL ERROR] Failed to send to ${to}:`, error.message);
    // Don't throw if email fails in dev, but log it
    if (process.env.NODE_ENV === 'production') throw error;
  }
}

function generate4DigitCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

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
    if (!USDC_CONTRACT_ADDRESS)
      throw new Error("USDC_CONTRACT_ADDRESS not set.");
    const erc20Abi = [
      "function transfer(address to, uint256 amount) returns (bool)",
    ];
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
  if (!["holding", "completed", "disputed"].includes(payment.status))
    throw new Error("Payment not eligible for refund.");
  if (!payment.user_address)
    throw new Error("Missing user_address for refund.");

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

async function settlePaymentToSeller({ paymentId }) {
  if (!wallet) throw new Error("Wallet is not configured.");
  if (!MAIN_BUSINESS_ACCOUNT)
    throw new Error("MAIN_BUSINESS_ACCOUNT is not configured.");

  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw new Error("Payment not found.");
  if (payment.complaint_status === "complained") {
    return {
      payment,
      didSettle: false,
      reason: "Payment is under complaint review.",
    };
  }
  if (!["holding", "disputed"].includes(payment.status)) {
    return {
      payment,
      didSettle: false,
      reason: `Payment status is '${payment.status}', not eligible for settlement.`,
    };
  }

  // Idempotency guard: if we already have a payout hash, assume settled.
  if (payment.payout_tx_hash) {
    payment.status = "completed";
    await payment.save();
    return { payment, didSettle: false, reason: "Already settled." };
  }

  const card = payment.card_id ? await Card.findByPk(payment.card_id) : null;
  const payoutAddress =
    card && card.seller_wallet_address
      ? card.seller_wallet_address
      : MAIN_BUSINESS_ACCOUNT;

  if (!payoutAddress) throw new Error("No payout address configured.");

  // FETCH CURRENT RATES FOR CONVERSION
  const rates = await getExchangeRates();
  const ethPriceInUsd = rates.ETH || 3000;

  // PROFIT LOGIC: Only send the seller's asking price. The remainder stays in the business wallet as profit.
  let sellerPayoutAmount = payment.amount; // Default to full amount if no card info

  if (card && card.seller_asking_price) {
    const fiatCurrency = card.currency || "USD";
    const fiatRateToUsd = rates[fiatCurrency] || 1;
    // Convert fiat asking price to USD then to ETH
    const askingPriceInEth = (card.seller_asking_price / fiatRateToUsd) / ethPriceInUsd;
    // Round to 8 decimal places like we do in /buy
    sellerPayoutAmount = Number(askingPriceInEth.toFixed(8));

    // Safety check: Payout cannot exceed what the buyer paid
    if (sellerPayoutAmount > payment.amount) {
      console.warn(`[SETTLEMENT] Warning: Calculated payout (${sellerPayoutAmount}) exceeds payment amount (${payment.amount}). Capping payout.`);
      sellerPayoutAmount = payment.amount;
    }
  }

  const adminProfitAmount = Number((payment.amount - sellerPayoutAmount).toFixed(8));

  const payoutTxHash = await transferFunds({
    to: payoutAddress,
    amount: sellerPayoutAmount,
    asset: normalizeAsset(payment.asset, ""),
    decimals: payment.asset_decimals,
  });

  payment.seller_payout_amount = sellerPayoutAmount;
  payment.admin_profit = adminProfitAmount;
  payment.payout_tx_hash = payoutTxHash;
  payment.profit_locked_until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days lock
  payment.profit_status = "holding";
  payment.status = "completed";
  await payment.save();

  const existingProfit = await PlatformProfit.findOne({
    where: { payment_id: payment.id },
  });
  if (!existingProfit) {
    await PlatformProfit.create({
      payment_id: payment.id,
      card_id: card ? card.id : null,
      seller_id: card ? card.seller_id : null,
      buyer_id: payment.buyer_id,
      total_amount: payment.amount,
      seller_payout: sellerPayoutAmount,
      admin_profit: adminProfitAmount,
      asset: normalizeAsset(payment.asset, ""),
      asset_decimals: payment.asset_decimals,
      status: "holding",
      locked_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } else {
    // Update existing profit record if it was already created (e.g. by a previous failed attempt)
    existingProfit.seller_payout = sellerPayoutAmount;
    existingProfit.admin_profit = adminProfitAmount;
    await existingProfit.save();
  }

  console.log(
    `[SETTLEMENT] Payment #${payment.id}: Total ${payment.amount} ETH | Seller: ${sellerPayoutAmount} ETH | Admin: ${adminProfitAmount} ETH | TX: ${payoutTxHash}`,
  );

  return { payment, didSettle: true, payoutTxHash };
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
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role === "admin") return next();
    } catch (e) { }
  }
  return res.status(401).json({ error: "Unauthorized admin request." });
}

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(" ")[1];
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
      return res
        .status(400)
        .json({ error: "Email, password, and role are required." });
    }
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email already in use." });
    }

    const verification_code = generate4DigitCode();
    const verification_code_expires = new Date(Date.now() + 3600000); // 1 hour

    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password_hash,
      role,
      verification_code,
      verification_code_expires,
      is_verified: false
    });

    // Send verification email
    await sendEmail({
      to: email,
      subject: "Verify your account - GiftCard Crypto",
      text: `Your verification code is: ${verification_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>Welcome to GiftCard Crypto!</h2>
              <p>Please use the following 4-digit code to verify your account:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2563eb; margin: 20px 0;">
                ${verification_code}
              </div>
              <p>This code will expire in 1 hour.</p>
            </div>`
    });

    res
      .status(201)
      .json({ message: "User registered. Please check your email for the verification code.", id: user.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/verify", async (req, res) => {
  try {
    const { email, code } = req.body;
    console.log(`[AUTH] Verify attempt for: ${email}, Code: ${code}`);
    const user = await User.findOne({ where: { email } });
    if (!user) {
      console.log(`[AUTH] Verify failed: User not found for ${email}`);
      return res.status(400).json({ error: "User not found" });
    }
    if (user.is_verified) return res.status(400).json({ error: "User already verified" });

    if (user.verification_code !== code) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (new Date() > user.verification_code_expires) {
      return res.status(400).json({ error: "Verification code expired" });
    }

    user.is_verified = true;
    user.verification_code = null;
    user.verification_code_expires = null;
    await user.save();

    res.json({ message: "Email verified successfully. You can now log in." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_verified) return res.status(400).json({ error: "User already verified" });

    const verification_code = generate4DigitCode();
    const verification_code_expires = new Date(Date.now() + 3600000);

    user.verification_code = verification_code;
    user.verification_code_expires = verification_code_expires;
    await user.save();

    await sendEmail({
      to: email,
      subject: "Your new verification code - GiftCard Crypto",
      text: `Your new verification code is: ${verification_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>New Verification Code</h2>
              <p>Use the following 4-digit code to verify your account:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2563eb; margin: 20px 0;">
                ${verification_code}
              </div>
              <p>This code will expire in 1 hour.</p>
            </div>`
    });

    res.json({ message: "A new verification code has been sent to your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (!user.is_verified) {
      return res.status(403).json({ error: "unverified", message: "Please verify your email before logging in." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "24h",
    });
    res.json({ token, role: user.role, email: user.email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) {
      // Don't leak user existence in prod, but for now we can be specific
      return res.status(404).json({ error: "If that email exists, we've sent a reset code." });
    }

    const reset_password_code = generate4DigitCode();
    const reset_password_expires = new Date(Date.now() + 3600000);

    user.reset_password_code = reset_password_code;
    user.reset_password_expires = reset_password_expires;
    await user.save();

    await sendEmail({
      to: email,
      subject: "Password Reset Request - GiftCard Crypto",
      text: `Your password reset code is: ${reset_password_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>Password Reset Request</h2>
              <p>We received a request to reset your password. Use the following 4-digit code:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #dc2626; margin: 20px 0;">
                ${reset_password_code}
              </div>
              <p>This code will expire in 1 hour. If you didn't request this, please ignore this email.</p>
            </div>`
    });

    res.json({ message: "Password reset code sent to your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.reset_password_code !== code) {
      return res.status(400).json({ error: "Invalid reset code" });
    }

    if (new Date() > user.reset_password_expires) {
      return res.status(400).json({ error: "Reset code expired" });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    user.password_hash = password_hash;
    user.reset_password_code = null;
    user.reset_password_expires = null;
    await user.save();

    res.json({ message: "Password reset successfully. You can now log in with your new password." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// Buyer Dashboard Routes
// ---------------------------------------------------------
app.get("/buyer/payments", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payments = await Payment.findAll({
      where: { buyer_id: req.user.id },
      include: [{ model: Card, as: "card" }],
      order: [["id", "DESC"]],
    });
    // Never leak card credentials for unpaid / refunded / pending flows.
    const sanitized = payments.map((p) => {
      const payment = p.toJSON();
      const eligible = ["holding", "completed"].includes(payment.status);
      if (!eligible && payment.card) {
        delete payment.card.card_code;
        delete payment.card.card_pin;
      }
      return payment;
    });
    res.json(sanitized);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/buyer/payments/:id/complain", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({
      where: { id: req.params.id, buyer_id: req.user.id },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["holding", "completed"].includes(payment.status)) {
      return res
        .status(400)
        .json({ error: "Cannot complain about a payment in this status." });
    }
    if (payment.complaint_status === "valid") {
      return res.status(400).json({
        error: "Payment already confirmed as valid.",
      });
    }

    if (payment.complaint_status === "complained") {
      return res.json({ message: "Complaint already filed." });
    }

    // Complaint workflow: keep the payment in escrow ("holding"), but mark as disputed.
    const { reason } = req.body;
    payment.complaint_status = "complained";
    payment.status = "disputed";
    payment.complaint_reason = reason || "Other issue";
    await payment.save();

    res.json({
      message: "Complaint filed. Seller payout is held for admin review.",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/buyer/payments/:id/confirm", authenticateJWT, async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({
      where: { id: req.params.id, buyer_id: req.user.id },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["holding", "completed"].includes(payment.status)) {
      return res.status(400).json({
        error: "Cannot confirm a payment in this status.",
        status: payment.status,
      });
    }

    // Allow buyer confirmation even if they previously complained.
    // This immediately releases seller payout (escrow settlement).
    payment.complaint_status = "valid";
    await payment.save();

    // Instant settlement: release seller payout immediately upon buyer confirmation.
    let settlement = null;
    try {
      if (payment.status === "holding") {
        settlement = await settlePaymentToSeller({ paymentId: payment.id });
      }
    } catch (e) {
      // If settlement fails (wallet misconfig / chain error), keep confirmation recorded
      // but surface the error so the operator can retry.
      return res.status(500).json({
        error: "Card confirmed, but settlement failed.",
        details: e.message,
      });
    }

    return res.json({
      message: "Card confirmed as valid.",
      settlement: settlement
        ? {
          did_settle: Boolean(settlement.didSettle),
          payout_tx_hash: settlement.payoutTxHash || null,
          payment_status: settlement.payment?.status || payment.status,
        }
        : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// Seller Dashboard Routes
// ---------------------------------------------------------
// ---------------------------------------------------------
// Admin API Routes for Card Approval/Rejection
// ---------------------------------------------------------
// POST /admin/cards/:id/approve - REST endpoint (kept for backward compatibility)
app.post("/admin/cards/:id/approve", requireAdmin, async (req, res) => {
  try {
    // Prevent caching
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("ETag", undefined);

    const card = await Card.findByPk(req.params.id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "pending_approval") {
      return res.status(400).json({ error: "Card is not pending approval" });
    }
    card.status = "active";
    await card.save();

    console.log(`[ADMIN] Card #${card.id} approved by admin`);
    res.json({ message: "Card approved and now active", card });
  } catch (error) {
    console.error("[ERROR] Approve card failed:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/admin/cards/:id/reject", requireAdmin, async (req, res) => {
  try {
    // Prevent caching
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("ETag", undefined);

    const card = await Card.findByPk(req.params.id);
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.status !== "pending_approval") {
      return res.status(400).json({ error: "Card is not pending approval" });
    }
    card.status = "rejected";
    await card.save();
    res.json({ message: "Card rejected", card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/seller/cards", authenticateJWT, async (req, res) => {
  if (req.user.role !== "seller")
    return res.status(403).json({ error: "Access denied" });
  try {
    const cards = await Card.findAll({
      where: { seller_id: req.user.id },
      include: [{ model: Payment, as: "payment" }],
      order: [["id", "DESC"]],
    });
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/seller/cards/:id/cancel", authenticateJWT, async (req, res) => {
  const cardIdRaw = req.params.id;
  const userIdRaw = req.user?.id;

  console.log(
    `[Cancel Request] Card ID: ${cardIdRaw}, User ID: ${userIdRaw}, Role: ${req.user?.role}`,
  );

  if (req.user?.role !== "seller") {
    return res
      .status(403)
      .json({ error: "Access denied. Only sellers can cancel listings." });
  }

  try {
    const cardId = Number(cardIdRaw);
    if (isNaN(cardId)) {
      return res.status(400).json({ error: `Invalid card ID: ${cardIdRaw}` });
    }

    const sellerId = Number(userIdRaw);
    if (isNaN(sellerId)) {
      return res
        .status(400)
        .json({ error: "Invalid user authentication data." });
    }

    // Find card by ID
    const card = await Card.findByPk(cardId);
    if (!card) {
      return res.status(404).json({ error: `Card #${cardId} not found.` });
    }

    // Verify ownership
    if (Number(card.seller_id) !== sellerId) {
      console.log(
        `[Cancel Error] Ownership mismatch. Card #${cardId} owned by ${card.seller_id}, requested by ${sellerId}`,
      );
      return res.status(403).json({
        error: "Permission denied. You are not the owner of this card.",
      });
    }

    // Idempotent check
    if (card.status === "cancelled") {
      return res.json({ message: "Card is already cancelled." });
    }

    // Status check
    if (card.status !== "active") {
      console.log(`[Cancel Error] Card #${cardId} is '${card.status}'`);
      return res.status(400).json({
        error: `Cannot cancel this card because it is already '${card.status}'.`,
      });
    }

    // Escrow check
    const existingPayment = await Payment.findOne({
      where: { card_id: card.id, status: { [Op.in]: ["pending", "holding"] } },
    });

    if (existingPayment) {
      console.log(
        `[Cancel Error] Card #${cardId} has active payment #${existingPayment.id} (Status: ${existingPayment.status})`,
      );
      return res.status(400).json({
        error: `Cannot cancel card while a buyer is processing a payment (Escrow status: ${existingPayment.status}).`,
      });
    }

    // Execute cancellation
    card.status = "cancelled";
    await card.save();

    console.log(
      `[Cancel Success] Card #${cardId} cancelled by seller ${sellerId}`,
    );
    res.json({ message: "Card listing cancelled successfully." });
  } catch (error) {
    console.error("[Cancel Exception]:", error);
    res.status(500).json({
      error: "An internal error occurred while cancelling the card.",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

async function getExchangeRates() {
  const [fiatRes, cryptoRes] = await Promise.all([
    axios.get("https://open.er-api.com/v6/latest/USD"),
    axios.get("https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD"),
  ]);

  return {
    ...fiatRes.data.rates,
    ETH: cryptoRes.data.USD,
  };
}

// Exchange Rates API
// ---------------------------------------------------------
app.get("/exchange-rates", async (req, res) => {
  console.log("[API] Fetching latest exchange rates...");
  try {
    const data = await getExchangeRates();
    console.log("[API] Exchange rates fetched successfully.");
    res.json(data);
  } catch (error) {
    console.error("[API] Exchange rate fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch exchange rates." });
  }
});

// Admin - Add Card (Manual API)
app.post(
  "/admin/add-card",
  requireAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      const { name, description = "", price } = req.body;
      const amount = parseAmount(price);

      if (!name || !amount || !req.file) {
        if (req.file?.path) fs.unlink(req.file.path, () => undefined);
        return res
          .status(400)
          .json({ error: "name, price and file are required." });
      }

      const card = await Card.create({
        name: name.trim(),
        description: description.trim(),
        price: amount,
        file_path: req.file.path,
        status: "active",
      });

      return res
        .status(201)
        .json({ message: "Card added successfully.", card_id: card.id });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },
);

// Public - Sell Card
app.post("/cards/sell", authenticateJWT, upload.single("file"), async (req, res) => {
  try {
    if (req.user.role !== "seller") return res.status(403).json({ error: "Access denied" });
    const { retailer, price, card_code, card_pin, seller_wallet_address, region, currency } = req.body;
    const amount = parseAmount(price);

    if (!retailer || !amount || !card_code || !seller_wallet_address) {
      if (req.file?.path) fs.unlink(req.file.path, () => undefined);
      return res.status(400).json({ error: "retailer, price, card_code and seller_wallet_address are required." });
    }

    const card = await Card.create({
      name: `${retailer} Gift Card`,
      description: `Gift card for ${retailer} (${region})`,
      price: amount,
      seller_asking_price: amount,
      denomination: 0,
      file_path: req.file ? `uploads/${req.file.filename}` : "",
      status: "pending_approval",
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
}
);

// Public - Get Active Cards
app.get("/cards", async (_req, res) => {
  try {
    const cards = await Card.findAll({
      where: { status: "active" },
      attributes: [
        "id",
        "name",
        "description",
        "price",
        "status",
        "retailer",
        "denomination",
        "region",
        "currency",
        "file_path",
      ],
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
    if (req.user.role !== "buyer")
      return res.status(403).json({ error: "Access denied" });
    const cardId = Number(req.body.card_id);
    const card = await Card.findByPk(cardId);
    if (!card || card.status !== "active") {
      return res.status(404).json({ error: "Card is not available." });
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: cardId, status: { [Op.in]: ["pending", "holding"] } },
    });

    if (existingPayment) {
      if (existingPayment.status === "holding") {
        return res
          .status(409)
          .json({ error: "This card is already being processed (Payment Received)." });
      }

      // If it's pending and belongs to the SAME user, let them resume
      if (existingPayment.buyer_id === req.user.id) {
        console.log(`[BUY] Resuming existing pending payment ${existingPayment.id} for user ${req.user.id}`);

        // RECALCULATE amount to handle cases where rates changed or old records have fiat values
        const rates = await getExchangeRates();
        const fiatCurrency = card.currency || "USD";
        const ethPriceInUsd = rates.ETH || 3000;
        const fiatRateToUsd = rates[fiatCurrency] || 1;
        const amountInEth = (card.price / fiatRateToUsd) / ethPriceInUsd;
        const finalEthAmount = Number(amountInEth.toFixed(8));

        existingPayment.amount = finalEthAmount;
        await existingPayment.save();

        return res.status(200).json({
          message: "Resuming existing payment flow (Rates updated).",
          payment_id: existingPayment.id,
          card_id: card.id,
          amount: finalEthAmount,
          pay_to: MAIN_BUSINESS_ACCOUNT,
        });
      }

      // If it belongs to someone else, check if it's stale (older than 15 mins)
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const createdAt = new Date(existingPayment.created_at || Date.now());

      if (createdAt < fifteenMinsAgo) {
        console.log(`[BUY] Clearing stale pending payment ${existingPayment.id} for card ${cardId}`);
        // We can just delete it or mark as cancelled. Let's mark as cancelled.
        // For simplicity in this demo, we'll just allow creating a NEW one by ignoring this one
        // but we should technically prevent multiple pendings for same card.
        // So we'll destroy the stale one.
        await existingPayment.destroy();
      } else {
        return res.status(409).json({
          error: "Another buyer is currently attempting to purchase this card. Please try again in 15 minutes.",
        });
      }
    }

    const rates = await getExchangeRates();
    const fiatCurrency = card.currency || "USD";
    const ethPriceInUsd = rates.ETH || 3000;
    const fiatRateToUsd = rates[fiatCurrency] || 1;

    // Convert card fiat price to USD, then to ETH
    const amountInUsd = card.price / fiatRateToUsd;
    const amountInEth = (card.price / fiatRateToUsd) / ethPriceInUsd;
    // We'll round to 6 decimal places for the ETH amount
    const finalEthAmount = Number(amountInEth.toFixed(8));
    console.log(`[BUY] Converting ${card.price} ${fiatCurrency} to ETH. Rate: 1 ETH = ${ethPriceInUsd} USD. Final: ${finalEthAmount} ETH`);

    if (!MAIN_BUSINESS_ACCOUNT) {
      console.error("[BUY] Payment failed: MAIN_BUSINESS_ACCOUNT is not configured on the server.");
      return res.status(500).json({ error: "The server is not configured with a destination wallet for payments. Please contact support." });
    }

    const intent = await Payment.create({
      amount: finalEthAmount,
      status: "pending",
      card_id: card.id,
      buyer_id: req.user.id,
      asset: "ETH",
      asset_decimals: 18,
      user_address: req.body.wallet_address || null,
    });

    return res.status(201).json({
      message: "Payment intent created.",
      payment_id: intent.id,
      card_id: card.id,
      fiat_amount: card.price,
      fiat_currency: card.currency,
      eth_amount: finalEthAmount,
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
        ignored.push({
          reason: "already_processed",
          hash,
          status: existing.status,
        });
        continue;
      }

      // 0.5% tolerance for crypto payments to handle minor rounding differences
      const tolerance = 0.005;
      const minAmount = amount * (1 - tolerance);
      const maxAmount = amount * (1 + tolerance);

      const pendingPayments = await Payment.findAll({
        where: {
          status: "pending",
          amount: { [Op.between]: [minAmount, maxAmount] },
          asset: asset,
          [Op.or]: [{ user_address: fromAddress }, { user_address: null }],
        },
        include: [{ model: Card, as: "card", where: { status: "active" } }],
        order: [["id", "ASC"]],
      });

      if (pendingPayments.length === 0) {
        ignored.push({
          reason: "no_matching_pending_intent",
          hash,
          amount,
          asset,
        });
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

      handled.push({
        payment_id: pending.id,
        card_id: pending.card_id,
        tx_hash: hash,
      });
    } catch (error) {
      ignored.push({
        reason: "processing_error",
        hash: activity?.hash,
        error: error.message,
      });
    }
  }

  return res
    .status(200)
    .json({ message: "Webhook processed.", handled, ignored });
});

// Admin - Refund (Manual API)
app.post("/admin/refund", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const txHash = String(
      body.tx_hash || body.external_id || "",
    ).trim();
    const paymentId = body.payment_id ? Number(body.payment_id) : null;

    const { payment, refundTxHash } = await refundPaymentByLookup({
      txHash: txHash || null,
      paymentId,
    });

    return res.json({
      message: "Refund executed.",
      payment_id: payment.id,
      refund_tx_hash: refundTxHash,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Admin - Platform Profit Analytics
app.get("/admin/profit/summary", requireAdmin, async (req, res) => {
  try {
    const totalProfit = await PlatformProfit.sum("admin_profit") || 0;
    const holdingProfit =
      (await PlatformProfit.sum("admin_profit", {
        where: { status: "holding" },
      })) || 0;
    const releasedProfit =
      (await PlatformProfit.sum("admin_profit", {
        where: { status: "released" },
      })) || 0;
    const withdrawnProfit =
      (await PlatformProfit.sum("admin_profit", {
        where: { status: "withdrawn" },
      })) || 0;

    const totalTransactions = await PlatformProfit.count();
    const totalSellerPayouts = await PlatformProfit.sum("seller_payout") || 0;
    const totalBuyerPayments =
      await PlatformProfit.sum("total_amount") || 0;

    res.json({
      summary: {
        total_profit: Number(totalProfit).toFixed(6),
        total_seller_payouts: Number(totalSellerPayouts).toFixed(6),
        total_buyer_payments: Number(totalBuyerPayments).toFixed(6),
        total_transactions: totalTransactions,
      },
      profit_breakdown: {
        holding: Number(holdingProfit).toFixed(6),
        released: Number(releasedProfit).toFixed(6),
        withdrawn: Number(withdrawnProfit).toFixed(6),
      },
      available_to_withdraw: Number(releasedProfit).toFixed(6),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin - Profit Details by Status
app.get("/admin/profit/details", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || "holding"; // holding, released, withdrawn

    const profits = await PlatformProfit.findAll({
      where: { status },
      include: [
        { model: Card, as: "card", attributes: ["id", "name", "price"] },
        {
          model: User,
          as: "seller",
          attributes: ["id", "email", "role"],
        },
      ],
      order: [["created_at", "DESC"]],
    });

    res.json({
      status,
      count: profits.length,
      total_profit: Number(
        profits.reduce((sum, p) => sum + (p.admin_profit || 0), 0),
      ).toFixed(6),
      records: profits,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin - Withdraw Profit
app.post("/admin/profit/withdraw", requireAdmin, async (req, res) => {
  try {
    const { amount, address } = req.body;

    if (!amount || !address) {
      return res
        .status(400)
        .json({ error: "Amount and address required" });
    }

    // Get released profits available for withdrawal
    const releasedProfit =
      (await PlatformProfit.sum("admin_profit", {
        where: { status: "released" },
      })) || 0;

    if (Number(amount) > releasedProfit) {
      return res
        .status(400)
        .json({
          error: "Insufficient released profit to withdraw",
          available: Number(releasedProfit).toFixed(6),
          requested: amount,
        });
    }

    // Execute transfer
    const withdrawTxHash = await transferFunds({
      to: address,
      amount: Number(amount),
      asset: "ETH",
      decimals: 18,
    });

    // Update profits as withdrawn (until we reach the requested amount)
    let remainingAmount = Number(amount);
    const profitsToWithdraw = await PlatformProfit.findAll({
      where: { status: "released" },
      order: [["created_at", "ASC"]],
    });

    for (const profit of profitsToWithdraw) {
      if (remainingAmount <= 0) break;

      const withdrawAmount = Math.min(remainingAmount, profit.admin_profit);
      profit.status = "withdrawn";
      profit.withdrawn_at = new Date();
      profit.withdraw_tx_hash = withdrawTxHash;
      await profit.save();

      remainingAmount -= withdrawAmount;
    }

    console.log(
      `[PROFIT] Withdrawn ${amount} ETH to ${address} (TX: ${withdrawTxHash})`,
    );

    res.json({
      message: "Profit withdrawn successfully",
      amount: amount,
      tx_hash: withdrawTxHash,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ERROR] Profit withdrawal failed:", error);
    res.status(500).json({ error: error.message });
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

    if (!payment || !payment.card)
      return res.status(404).json({ error: "Payment not found." });
    if (!["holding", "completed"].includes(payment.status)) {
      return res
        .status(403)
        .json({ error: "Download not allowed.", status: payment.status });
    }

    const absolutePath = path.resolve(payment.card.file_path);
    if (!absolutePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({ error: "Invalid file path." });
    }
    if (!fs.existsSync(absolutePath))
      return res.status(404).json({ error: "File not found." });

    return res.download(absolutePath);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------
// AdminJS Configuration
// ---------------------------------------------------------
async function setupAdminPanel() {
  const [
    { default: AdminJS, ComponentLoader },
    { default: AdminJSExpress },
    AdminJSSequelize,
  ] = await Promise.all([
    import("adminjs"),
    import("@adminjs/express"),
    import("@adminjs/sequelize"),
  ]);

  const componentLoader = new ComponentLoader();

  const Components = {
    // Absolute path: AdminJS resolves relative paths via stack traces, which can break on Windows
    // or when `setupAdminPanel` is not the direct caller. `__dirname` always points at this file.
    Dashboard: componentLoader.add(
      "Dashboard",
      path.join(__dirname, "dashboard.jsx"),
    ),
  };

  AdminJS.registerAdapter(AdminJSSequelize);

  const admin = new AdminJS({
    rootPath: "/admin",
    branding: {
      companyName: "GitCard Crypto Admin",
      logo: "/admin_logo.png",
      softwareBrothers: false, // Hide AdminJS branding for a cleaner look
      theme: {
        colors: {
          primary100: "#0f172a", // Dark slate for premium feel
          primary80: "#1e293b",
          primary60: "#334155",
          primary40: "#475569",
          primary20: "#64748b",
          accent: "#ea580c",     // Orange accent
          hoverBg: "#f8fafc",
          bg: "#f1f5f9",         // Light app background
          white: "#ffffff",
          grey100: "#020617",
          grey80: "#0f172a",
          grey60: "#334155",
          grey40: "#64748b",
          grey20: "#cbd5e1",
          border: "#e2e8f0",
          error: "#ef4444",
          success: "#10b981",
          info: "#3b82f6",
        },
        font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        shadows: {
          cardHover: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
          loginCard: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        },
        borderRadius: {
          default: "8px",
          card: "16px",
        },
        borders: {
          default: "1px solid #e2e8f0",
        },
      },
    },
    componentLoader,
    dashboard: {
      component: Components.Dashboard,
    },
    resources: [
      {
        resource: User,
        options: {
          navigation: { name: "Identity", icon: "User" },
          listProperties: ["id", "email", "role"],
          editProperties: ["email", "role", "password"],
        },
      },
      {
        resource: Card,
        options: {
          navigation: { name: "Catalog", icon: "Product" },
          listProperties: [
            "id",
            "name",
            "price",
            "status",
            "retailer",
            "seller_id",
            "card_code",
            "file_path",
          ],
          properties: {
            price: { label: "Price (ETH)" },
            seller_asking_price: { label: "Seller Asking Price (ETH)" },
            denomination: { isVisible: false },
          },
          showProperties: [
            "id",
            "name",
            "description",
            "price",
            "seller_asking_price",
            "status",
            "retailer",
            "seller_id",
            "card_code",
            "card_pin",
            "file_path",
          ],
          editProperties: [
            "name",
            "description",
            "price",
            "status",
            "retailer",
            "card_code",
            "card_pin",
          ],
          actions: {
            approve: {
              actionType: "record",
              component: false,
              icon: "Checkmark",
              guard:
                "Are you sure you want to approve this card and make it active?",
              isVisible: ({ record }) =>
                record.params.status === "pending_approval",
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;

                try {
                  // Use record.update to change the status.
                  // This handles the DB save and returns the correct RecordJSON format.
                  await record.update({
                    status: "active",
                  });

                  console.log(
                    `[AdminJS] ✓ Card #${record.params.id} approved successfully`,
                  );

                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: "Card approved and now active!",
                      type: "success",
                    },
                    redirectUrl: "/admin/resources/cards",
                  };
                } catch (error) {
                  console.error(`[AdminJS] ✗ Approve failed:`, error);
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Approval failed: ${error.message}`,
                      type: "error",
                    },
                  };
                }
              },
            },
            reject: {
              actionType: "record",
              component: false,
              icon: "Close",
              guard: "Reject this card listing?",
              isVisible: ({ record }) =>
                record.params.status === "pending_approval",
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;

                try {
                  await record.update({
                    status: "rejected",
                  });

                  console.log(
                    `[AdminJS] ✓ Card #${record.params.id} rejected successfully`,
                  );

                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: "Card listing rejected.",
                      type: "error", // Kept as error type for red UI feedback
                    },
                    redirectUrl: "/admin/resources/cards",
                  };
                } catch (error) {
                  console.error(`[AdminJS] ✗ Reject failed:`, error);
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Rejection failed: ${error.message}`,
                      type: "error",
                    },
                  };
                }
              },
            },
            view_file: {
              actionType: "record",
              icon: "View",
              isVisible: ({ record }) => !!record.params.file_path,
              handler: async (request, response, context) => {
                const { record } = context;
                const path = record.params.file_path;
                return {
                  redirectUrl: path.startsWith("http") ? path : `/${path}`,
                };
              },
            },
          },
        },
      },
      {
        resource: Payment,
        options: {
          navigation: { name: "Payments", icon: "Payment" },
          listProperties: [
            "id",
            "external_id",
            "amount",
            "admin_profit",
            "seller_payout_amount",
            "asset",
            "status",
            "complaint_status",
            "profit_status",
            "card_id",
            "buyer_id",
            "release_at",
          ],
          properties: {
            amount: { label: "Total Amount (ETH)" },
            seller_payout_amount: { label: "Seller Payout (ETH)" },
            admin_profit: { label: "Admin Profit (ETH)" },
            asset: { label: "Asset" },
            profit_status: { label: "Profit Status" },
            profit_locked_until: { label: "Profit Locked Until" },
            payout_tx_hash: { label: "Payout TX Hash" },
          },
          showProperties: [
            "id",
            "external_id",
            "amount",
            "seller_payout_amount",
            "admin_profit",
            "payout_tx_hash",
            "asset",
            "status",
            "complaint_status",
            "complaint_reason",
            "profit_status",
            "profit_locked_until",
            "card_id",
            "buyer_id",
            "release_at",
            "created_at",
          ],
          actions: {
            new: { isAccessible: false },
            delete: { isAccessible: false },
            resolve_valid: {
              actionType: "record",
              component: false,
              icon: "Checkmark",
              label: "✓ Release Fund To Seller",
              guard: "Resolve complaint as invalid and release seller payout?",
              isVisible: ({ record }) => {
                const status = record.param('status');
                const complaintStatus = record.param('complaint_status');
                return (
                  ["disputed", "holding"].includes(status) &&
                  ["complained", "under_review"].includes(complaintStatus)
                );
              },
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                const method = String(request?.method || "get").toLowerCase();
                try {
                  const paymentId = Number(record.param("id"));
                  console.log(
                    `[AdminJS] resolve_valid: Invoked via ${method.toUpperCase()} for payment #${paymentId}`,
                  );

                  const payment = await Payment.findByPk(paymentId);
                  if (!payment) {
                    throw new Error("Payment not found");
                  }

                  payment.complaint_status = "resolved";
                  await payment.save();

                  const settlement = await settlePaymentToSeller({ paymentId });
                  if (!settlement.didSettle && settlement.reason !== "Already settled.") {
                    throw new Error(settlement.reason || "Settlement failed");
                  }

                  payment.status = "completed";
                  await payment.save();

                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "RELEASE_FUND_TO_SELLER",
                    target_type: "Payment",
                    target_id: paymentId,
                    details: `Dispute resolved as invalid. complaint_status=resolved, status=completed. Funds released to seller. Reason given by buyer: ${payment.complaint_reason}. TX: ${settlement.payoutTxHash || payment.payout_tx_hash || "N/A"}`,
                  });

                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Funds released to seller. TX: ${settlement.payoutTxHash || payment.payout_tx_hash || "N/A"}`,
                      type: "success",
                    },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  console.error(`[AdminJS] resolve_valid error:`, error.message);
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Error: ${error.message}`,
                      type: "error",
                    },
                  };
                }
              },
            },
            refund: {
              actionType: "record",
              component: false,
              icon: "Undo",
              label: "↶ Refund Buyer",
              guard: "Refund this payment and cancel seller payout?",
              isVisible: ({ record }) => {
                const status = record.param('status');
                const complaintStatus = record.param('complaint_status');
                return (
                  ["disputed", "holding"].includes(status) &&
                  ["complained", "under_review"].includes(complaintStatus)
                );
              },
              handler: async (request, response, context) => {
                const { record, currentAdmin } = context;
                const method = String(request?.method || "get").toLowerCase();
                try {
                  const paymentId = Number(record.param("id"));
                  console.log(
                    `[AdminJS] refund: Invoked via ${method.toUpperCase()} for payment #${paymentId}`,
                  );

                  const payment = await Payment.findByPk(paymentId);
                  if (!payment) {
                    throw new Error("Payment not found");
                  }

                  const { payment: refundedPayment, refundTxHash } =
                    await refundPaymentByLookup({
                      paymentId,
                    });

                  refundedPayment.complaint_status = "refunded";
                  refundedPayment.status = "returned";
                  await refundedPayment.save();

                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "REFUND_BUYER",
                    target_type: "Payment",
                    target_id: paymentId,
                    details: `Dispute resolved as valid. complaint_status=refunded, status=returned. Buyer refunded. TX: ${refundTxHash}. Reason given by buyer: ${payment.complaint_reason}`,
                  });

                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Buyer refunded successfully. TX: ${refundTxHash}`,
                      type: "success",
                    },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  console.error(`[AdminJS] refund error:`, error.message);
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: `Error: ${error.message}`,
                      type: "error",
                    },
                  };
                }
              },
            },
            view_card_file: {
              actionType: "record",
              icon: "View",
              isVisible: ({ record }) => !!record.params.card_id,
              handler: async (request, response, context) => {
                const { record } = context;
                const payment = await Payment.findByPk(record.params.id, {
                  include: [{ model: Card, as: "card" }],
                });
                if (!payment || !payment.card || !payment.card.file_path) {
                  return {
                    notice: { message: "No file found for this card.", type: "error" },
                  };
                }
                const path = payment.card.file_path;
                return {
                  redirectUrl: path.startsWith("http") ? path : `/${path}`,
                };
              },
            },
            mark_under_review: {
              actionType: "record",
              component: false,
              icon: "Search",
              label: "Mark Under Review",
              isVisible: ({ record }) =>
                record.params.complaint_status === "complained",
              handler: async (request, _response, context) => {
                const { record, currentAdmin } = context;
                try {
                  await record.update({ complaint_status: "under_review" });
                  await AuditLog.create({
                    admin_email: currentAdmin.email,
                    action: "MARK_UNDER_REVIEW",
                    target_type: "Payment",
                    target_id: record.params.id,
                    details: `Dispute marked as under review by admin.`,
                  });
                  await record.load();
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: {
                      message: "Dispute is now under review.",
                      type: "info",
                    },
                    redirectUrl: "/admin/resources/payments",
                  };
                } catch (error) {
                  return {
                    record: record.toJSON(currentAdmin),
                    notice: { message: error.message, type: "error" },
                  };
                }
              },
            },
          },
        },
      },
      {
        resource: AuditLog,
        options: {
          navigation: { name: "System Logs", icon: "View" },
          actions: {
            new: { isAccessible: false },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
          },
        },
      },
      {
        resource: PlatformProfit,
        options: {
          navigation: { name: "Profit Analytics", icon: "BarChart" },
          listProperties: [
            "id",
            "payment_id",
            "total_amount",
            "seller_payout",
            "admin_profit",
            "asset",
            "status",
            "locked_until",
            "created_at",
          ],
          properties: {
            total_amount: { label: "Total Amount (ETH)" },
            seller_payout: { label: "Seller Payout (ETH)" },
            admin_profit: { label: "Admin Profit (ETH)" },
            asset: { label: "Asset" },
            status: { label: "Profit Status" },
            locked_until: { label: "Locked Until" },
            released_at: { label: "Released At" },
            withdrawn_at: { label: "Withdrawn At" },
          },
          showProperties: [
            "id",
            "payment_id",
            "card_id",
            "seller_id",
            "buyer_id",
            "total_amount",
            "seller_payout",
            "admin_profit",
            "asset",
            "status",
            "locked_until",
            "released_at",
            "withdrawn_at",
            "withdraw_tx_hash",
            "created_at",
          ],
          editProperties: ["status", "locked_until"],
        },
      },
    ],
  });

  // Build custom React components (dashboard, etc.) before the router serves AdminJS.
  // Without this: production can serve an empty/missing bundle (initialize() is async and not awaited),
  // and dev can point Rollup at the wrong .adminjs folder when cwd !== __dirname.
  const { componentsBundler, generateUserComponentEntry, ADMIN_JS_TMP_DIR } =
    await import("adminjs/bundler");
  await componentsBundler.createEntry({
    content: generateUserComponentEntry(admin, ADMIN_JS_TMP_DIR),
  });
  await componentsBundler.build();
  console.log("[AdminJS] User components bundle ready at", ADMIN_JS_TMP_DIR);

  if (process.env.NODE_ENV === "production") {
    await admin.initialize();
  }

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
    },
  );

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
        await settlePaymentToSeller({ paymentId: payment.id });
      } catch (err) {
        console.error(
          `Settlement failed for payment ${payment.id}:`,
          err.message,
        );
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
// Middleware for AdminJS - Prevent Caching & 304 Errors
// ---------------------------------------------------------
// Moved to top-level middleware to fix AdminJS refresh issues

// ---------------------------------------------------------
// Startup
// ---------------------------------------------------------
async function start() {
  await sequelize.authenticate();
  await sequelize.sync();
  console.log("Database synced");
  await setupAdminPanel();
  app.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`),
  );
}

start().catch((err) => {
  if (
    err.name === "SequelizeValidationError" ||
    err.name === "SequelizeUniqueConstraintError"
  ) {
    console.error("Startup failed with validation errors:");
    err.errors.forEach((e) =>
      console.error(`- ${e.message} (field: ${e.path}, value: ${e.value})`),
    );
  } else {
    console.error("Startup failed:", err);
  }
  process.exit(1);
});
