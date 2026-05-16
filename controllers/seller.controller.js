const { Card, Payment } = require("../models");
const { parseAmount } = require("../utils/helpers");
const { Op } = require("sequelize");
const fs = require("fs");

exports.getCards = async (req, res) => {
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
};

exports.cancelCard = async (req, res) => {
  if (req.user?.role !== "seller") {
    return res.status(403).json({ error: "Access denied. Only sellers can cancel listings." });
  }

  try {
    const cardId = Number(req.params.id);
    const sellerId = Number(req.user.id);

    const card = await Card.findByPk(cardId);
    if (!card) return res.status(404).json({ error: `Card #${cardId} not found.` });

    if (Number(card.seller_id) !== sellerId) {
      return res.status(403).json({ error: "Permission denied. You are not the owner of this card." });
    }

    if (card.status === "cancelled") return res.json({ message: "Card is already cancelled." });

    if (card.status !== "active") {
      return res.status(400).json({ error: `Cannot cancel this card because it is already '${card.status}'.` });
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: card.id, status: { [Op.in]: ["pending", "holding"] } },
    });

    if (existingPayment) {
      return res.status(400).json({ error: `Cannot cancel card while a buyer is processing a payment.` });
    }

    card.status = "cancelled";
    await card.save();

    res.json({ message: "Card listing cancelled successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.sellCard = async (req, res) => {
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
};
