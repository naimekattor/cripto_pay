const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Setting = sequelize.define(
  "Setting",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING, unique: true, allowNull: false },
    value: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.STRING },
  },
  { tableName: "settings", timestamps: false }
);

module.exports = Setting;
