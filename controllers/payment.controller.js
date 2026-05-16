const { Payment, Card, PlatformProfit } = require("../models");
const { transferFunds, wallet } = require("../utils/blockchain");
const { normalizeAsset, getExchangeRates } = require("../utils/helpers");

const MAIN_BUSINESS_ACCOUNT = process.env.MAIN_BUSINESS_ACCOUNT || (wallet ? wallet.address : "");

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

  const rates = await getExchangeRates();
  const ethPriceInUsd = rates.ETH || 3000;

  let sellerPayoutAmount = payment.amount;

  if (card && card.sellerReceives) {
    const fiatCurrency = card.currency || "USD";
    const fiatRateToUsd = rates[fiatCurrency] || 1;
    const sellerNetInEth = (card.sellerReceives / fiatRateToUsd) / ethPriceInUsd;
    sellerPayoutAmount = Number(sellerNetInEth.toFixed(8));

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
  payment.profit_locked_until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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
    existingProfit.seller_payout = sellerPayoutAmount;
    existingProfit.admin_profit = adminProfitAmount;
    await existingProfit.save();
  }

  console.log(
    `[SETTLEMENT] Payment #${payment.id}: Total ${payment.amount} ETH | Seller: ${sellerPayoutAmount} ETH | Admin: ${adminProfitAmount} ETH | TX: ${payoutTxHash}`,
  );

  return { payment, didSettle: true, payoutTxHash };
}

module.exports = {
  refundPaymentByLookup,
  settlePaymentToSeller
};
