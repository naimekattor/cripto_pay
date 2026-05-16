const { Sequelize } = require("sequelize");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "payments.db");

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: DB_PATH,
  logging: false, // Set to console.log for debugging
});

module.exports = sequelize;
