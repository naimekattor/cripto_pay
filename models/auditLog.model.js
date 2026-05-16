const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const AuditLog = sequelize.define(
  "AuditLog",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    admin_email: { type: DataTypes.STRING },
    action: { type: DataTypes.STRING },
    target_type: { type: DataTypes.STRING },
    target_id: { type: DataTypes.INTEGER },
    details: { type: DataTypes.TEXT },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "audit_logs", timestamps: false }
);

module.exports = AuditLog;
