const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    role: {
      type: DataTypes.STRING,
      validate: { isIn: [["buyer", "seller", "admin"]] },
      defaultValue: "buyer",
    },
    is_buyer: { type: DataTypes.BOOLEAN, defaultValue: false },
    is_seller: { type: DataTypes.BOOLEAN, defaultValue: false },
    is_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
    verification_code: { type: DataTypes.STRING, allowNull: true },
    verification_code_expires: { type: DataTypes.DATE, allowNull: true },
    reset_password_code: { type: DataTypes.STRING, allowNull: true },
    reset_password_expires: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  },
  { tableName: "users", timestamps: false }
);

module.exports = User;
