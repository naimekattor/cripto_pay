const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

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
  { tableName: "platform_profits", timestamps: false }
);

module.exports = PlatformProfit;
