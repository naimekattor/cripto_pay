const { Payment, Card, PlatformProfit, User } = require("../models");
const { transferFunds, wallet } = require("../utils/blockchain");
const { normalizeAsset, getExchangeRates } = require("../utils/helpers");
const { sendEmail } = require("../utils/email");

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

  // Mark card as sold
  if (card) {
    card.status = "sold";
    await card.save();
  }

  // Send confirmation email to seller
  try {
    const seller = card ? await User.findByPk(card.seller_id) : null;
    if (seller && seller.email) {
      const cardName = card ? card.name : `Card #${payment.card_id}`;
      const fiatSymbol = card?.currency === 'GBP' ? '£' : card?.currency === 'CAD' ? 'CA$' : '$';
      const fiatAmt = card?.sellerReceives ? `${fiatSymbol}${card.sellerReceives.toFixed(2)} (${card.currency || 'USD'})` : 'N/A';
      await sendEmail({
        to: seller.email,
        subject: `✅ Your Gift Card Has Sold – Payout Confirmed`,
        html: `
          <div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 16px;">
            <div style="background: #0f172a; border-radius: 12px; padding: 24px 32px; margin-bottom: 24px;">
              <h1 style="color: #ffffff; font-size: 22px; margin: 0;">🎉 Payout Confirmed</h1>
              <p style="color: #94a3b8; margin: 8px 0 0;">Your escrow has completed successfully.</p>
            </div>
            <table style="width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden;">
              <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Gift Card</td><td style="padding: 14px 20px; font-weight: 700; color: #0f172a;">${cardName}</td></tr>
              <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Payout (Fiat Value)</td><td style="padding: 14px 20px; font-weight: 700; color: #16a34a;">${fiatAmt}</td></tr>
              <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Payout (ETH Sent)</td><td style="padding: 14px 20px; font-weight: 700; color: #0f172a;">${sellerPayoutAmount.toFixed(8)} ETH</td></tr>
              <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Transaction Ref</td><td style="padding: 14px 20px; font-family: monospace; font-size: 11px; color: #475569; word-break: break-all;">${payoutTxHash}</td></tr>
              <tr><td style="padding: 14px 20px; color: #64748b; font-size: 13px;">Status</td><td style="padding: 14px 20px;"><span style="background: #dcfce7; color: #15803d; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700;">Escrow Completed</span></td></tr>
            </table>
            <p style="margin-top: 24px; color: #94a3b8; font-size: 12px; text-align: center;">GiftCard Crypto – Your crypto payout has been transferred to your wallet. Thank you for selling with us.</p>
          </div>
        `,
      });
    }
  } catch (emailErr) {
    console.error(`[EMAIL] Failed to send seller confirmation for payment #${payment.id}:`, emailErr.message);
  }

  return { payment, didSettle: true, payoutTxHash };
}

module.exports = {
  refundPaymentByLookup,
  settlePaymentToSeller
};
