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
        isIn: [["pending_approval", "active", "sold", "cancelled", "rejected"]],
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
  },
  { tableName: "cards", timestamps: false }
);

module.exports = Card;
