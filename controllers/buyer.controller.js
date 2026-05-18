const { Payment, Card } = require("../models");
const { getExchangeRates, computeReleaseAt } = require("../utils/helpers");
const { wallet } = require("../utils/blockchain");
const { settlePaymentToSeller } = require("./payment.controller");
const { Op } = require("sequelize");

const MAIN_BUSINESS_ACCOUNT = process.env.MAIN_BUSINESS_ACCOUNT || (wallet ? wallet.address : "");
const HOLD_HOURS = 24;

exports.getPayments = async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payments = await Payment.findAll({
      where: { buyer_id: req.user.id },
      include: [{ model: Card, as: "card" }],
      order: [["id", "DESC"]],
    });
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
};

exports.complainPayment = async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({
      where: { id: req.params.id, buyer_id: req.user.id },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["holding", "completed"].includes(payment.status)) {
      return res.status(400).json({ error: "Cannot complain about a payment in this status." });
    }
    if (payment.complaint_status === "valid") {
      return res.status(400).json({ error: "Payment already confirmed as valid." });
    }
    if (payment.complaint_status === "complained") {
      return res.json({ message: "Complaint already filed." });
    }

    const { reason } = req.body;
    payment.complaint_status = "complained";
    payment.status = "disputed";
    payment.complaint_reason = reason || "Other issue";
    await payment.save();

    res.json({ message: "Complaint filed. Seller payout is held for admin review." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.confirmPayment = async (req, res) => {
  if (req.user.role !== "buyer")
    return res.status(403).json({ error: "Access denied" });
  try {
    const payment = await Payment.findOne({
      where: { id: req.params.id, buyer_id: req.user.id },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["holding", "completed"].includes(payment.status)) {
      return res.status(400).json({ error: "Cannot confirm a payment in this status.", status: payment.status });
    }

    payment.complaint_status = "valid";
    await payment.save();

    let settlement = null;
    try {
      if (payment.status === "holding") {
        settlement = await settlePaymentToSeller({ paymentId: payment.id });
      }
    } catch (e) {
      return res.status(500).json({ error: "Card confirmed, but settlement failed.", details: e.message });
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
};

exports.buyCard = async (req, res) => {
  try {
    if (req.user.role !== "buyer")
      return res.status(403).json({ error: "Access denied" });
    const cardId = Number(req.body.card_id);
    const card = await Card.findByPk(cardId);
    if (!card || !['active', 'reserved'].includes(card.status)) {
      return res.status(404).json({ error: "Card is not available." });
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: cardId, status: { [Op.in]: ["pending", "holding"] } },
    });

    if (existingPayment) {
      if (existingPayment.status === "holding") {
        return res.status(409).json({ error: "This card is already being processed (Payment Received)." });
      }

      // Same buyer resuming their own reservation — always allow
      if (existingPayment.buyer_id === req.user.id) {
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
          eth_amount: finalEthAmount,
          pay_to: MAIN_BUSINESS_ACCOUNT,
          expires_at: existingPayment.expires_at,
        });
      }

      // A different buyer has an active payment — check if it's expired
      const createdAt = new Date(existingPayment.created_at || Date.now());
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

      if (createdAt < thirtyMinsAgo) {
        // Expired intent — release card back to active and destroy intent
        await existingPayment.destroy();
        card.status = "active";
        await card.save();
      } else {
        return res.status(409).json({
          error: "This card is temporarily reserved by another buyer. Please check back in 30 minutes.",
        });
      }
    } else if (card.status === 'reserved') {
      // Card marked reserved but no active payment found — restore it
      card.status = "active";
      await card.save();
    }

    const rates = await getExchangeRates();
    const fiatCurrency = card.currency || "USD";
    const ethPriceInUsd = rates.ETH || 3000;
    const fiatRateToUsd = rates[fiatCurrency] || 1;

    const amountInEth = (card.price / fiatRateToUsd) / ethPriceInUsd;
    const finalEthAmount = Number(amountInEth.toFixed(8));

    if (!MAIN_BUSINESS_ACCOUNT) {
      return res.status(500).json({ error: "The server is not configured with a destination wallet for payments." });
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes – matches reservation window
    const intent = await Payment.create({
      amount: finalEthAmount,
      status: "pending",
      card_id: card.id,
      buyer_id: req.user.id,
      asset: "ETH",
      asset_decimals: 18,
      user_address: req.body.wallet_address || null,
      fiat_amount: card.price,
      fiat_currency: card.currency,
      expires_at: expiresAt,
    });

    // Immediately reserve the card – hides it from marketplace and blocks cancellation
    card.status = "reserved";
    await card.save();
    console.log(`[RESERVATION] Card #${card.id} reserved by buyer #${req.user.id} until ${expiresAt.toISOString()}`);

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
      expires_at: expiresAt,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
