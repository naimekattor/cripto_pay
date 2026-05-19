const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

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
            "expired",
          ],
        ],
      },
    },
    card_id: { type: DataTypes.INTEGER },
    buyer_id: { type: DataTypes.INTEGER },
    release_at: { type: DataTypes.DATE },
    expires_at: { type: DataTypes.DATE },
    fiat_amount: { type: DataTypes.FLOAT },
    fiat_currency: { type: DataTypes.STRING },
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
            "valid",
          ],
        ],
      },
    },
    complaint_reason: { type: DataTypes.STRING },
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
    isRevealed: { type: DataTypes.BOOLEAN, defaultValue: false },
    revealedAt: { type: DataTypes.DATE, allowNull: true },
    autoRevealed: { type: DataTypes.BOOLEAN, defaultValue: false },
    autoRevealedAt: { type: DataTypes.DATE, allowNull: true },
    purchasedAt: { type: DataTypes.DATE, allowNull: true },
    revealSource: { type: DataTypes.STRING, allowNull: true },
  },
  { tableName: "payments", timestamps: false }
);

module.exports = Payment;
