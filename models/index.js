const User = require("./user.model");
const Card = require("./card.model");
const Payment = require("./payment.model");
const AuditLog = require("./auditLog.model");
const PlatformProfit = require("./platformProfit.model");
const Setting = require("./setting.model");

Card.belongsTo(User, { foreignKey: "seller_id", as: "seller" });
Card.hasOne(Payment, { foreignKey: "card_id", as: "payment" });
Payment.belongsTo(Card, { foreignKey: "card_id", as: "card" });
Payment.belongsTo(User, { foreignKey: "buyer_id", as: "buyer" });
PlatformProfit.belongsTo(Payment, { foreignKey: "payment_id", as: "payment" });
PlatformProfit.belongsTo(Card, { foreignKey: "card_id", as: "card" });
PlatformProfit.belongsTo(User, { foreignKey: "seller_id", as: "seller" });
PlatformProfit.belongsTo(User, { foreignKey: "buyer_id", as: "buyer" });
AuditLog.belongsTo(User, { foreignKey: "admin_email", targetKey: "email", as: "admin" });
AuditLog.belongsTo(Payment, { foreignKey: "target_id", constraints: false, as: "payment" });

module.exports = {
  User,
  Card,
  Payment,
  AuditLog,
  PlatformProfit,
  Setting
};
