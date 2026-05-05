const { Sequelize, DataTypes, Op } = require("sequelize");
const path = require("path");

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(__dirname, "payments.db"),
  logging: false,
});

const Card = sequelize.define("Card", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  status: { type: DataTypes.STRING, defaultValue: "active" },
  seller_id: { type: DataTypes.INTEGER },
}, { tableName: "cards", timestamps: false });

const Payment = sequelize.define("Payment", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  status: { type: DataTypes.STRING, defaultValue: "pending" },
  card_id: { type: DataTypes.INTEGER },
}, { tableName: "payments", timestamps: false });

async function test() {
  try {
    const cardId = 5;
    const sellerId = 2;
    
    const card = await Card.findByPk(cardId);
    console.log("Card found:", card ? card.id : "null", "Status:", card?.status, "Seller:", card?.seller_id);
    
    if (Number(card.seller_id) !== sellerId) {
      console.log("Ownership mismatch");
      return;
    }

    const existingPayment = await Payment.findOne({
      where: { card_id: card.id, status: { [Op.in]: ["pending", "holding"] } },
    });
    console.log("Existing payment:", existingPayment ? existingPayment.id : "none");

    card.status = "cancelled";
    // await card.save(); // Don't actually save in test unless we want to
    console.log("Success would have happened");
  } catch (e) {
    console.error("Test failed:", e);
  } finally {
    await sequelize.close();
  }
}

test();
