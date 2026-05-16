const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Card = sequelize.define(
  "Card",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    price: { type: DataTypes.FLOAT, allowNull: false },
    seller_asking_price: { type: DataTypes.FLOAT, allowNull: false },
    file_path: { type: DataTypes.STRING, allowNull: true },
    status: {
      type: DataTypes.STRING,
      defaultValue: "pending_approval",
      validate: {
        isIn: [["pending_approval", "active", "sold", "cancelled", "rejected", "invalid"]],
      },
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
    validationStatus: {
      type: DataTypes.STRING,
      defaultValue: "PENDING",
      validate: { isIn: [["PENDING", "VALID", "INVALID"]] },
    },
    sellerReceives: { type: DataTypes.FLOAT },
    buyerPays: { type: DataTypes.FLOAT },
    platformProfit: { type: DataTypes.FLOAT },
    isValid: { type: DataTypes.BOOLEAN, defaultValue: false },
    platformChargePercentage: { type: DataTypes.FLOAT, defaultValue: 10 },
  },
  { tableName: "cards", timestamps: false }
);

Card.beforeSave(async (card) => {
  // If price (buyerPays) or platformChargePercentage is updated, recalculate fields
  // We use seller_asking_price as the base denomination
  if (card.changed('platformChargePercentage') || card.changed('seller_asking_price')) {
    // Note: In a real app, we might need the retailer rates here too.
    // For now, we'll maintain the logic that buyerPays is the market price,
    // and platformProfit is determined by the percentage.
    
    // If buyerPays is not set yet (new record), we'll let the controller handle it first,
    // but the hook will ensure consistency on updates.
    if (card.seller_asking_price && card.platformChargePercentage !== undefined) {
       const charge = card.seller_asking_price * (card.platformChargePercentage / 100);
       card.platformProfit = charge;
       // We assume buyerPays is already set by controller or admin
       if (card.buyerPays) {
         card.sellerReceives = card.buyerPays - charge;
       }
    }
  }
});

module.exports = Card;
