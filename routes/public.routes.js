const express = require("express");
const router = express.Router();
const { Card, Payment } = require("../models");
const { getExchangeRates, normalizeAsset, parseAmount, supportedIncomingAsset, computeReleaseAt } = require("../utils/helpers");
const { wallet } = require("../utils/blockchain");
const { Op } = require("sequelize");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

// Get Active Cards
router.get("/cards", async (_req, res) => {
  try {
    const cards = await Card.findAll({
      where: { status: "active" },
      attributes: [
        "id", "name", "description", "price", "status", "retailer",
        "denomination", "region", "currency", "file_path",
      ],
      order: [["id", "DESC"]],
    });
    return res.json(cards);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Exchange Rates
router.get("/exchange-rates", async (req, res) => {
  try {
    const data = await getExchangeRates();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch exchange rates." });
  }
});

// Download Card
router.get("/download/:tx_hash", async (req, res) => {
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

// Health Check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", wallet: wallet?.address || null });
});

// Alchemy Webhook
router.post("/alchemy-webhook", async (req, res) => {
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

module.exports = router;
