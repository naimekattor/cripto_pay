const { User } = require("./models");
const sequelize = require("./config/database");

async function test() {
  try {
    await sequelize.authenticate();
    console.log("Connection has been established successfully.");
    const count = await User.count();
    console.log("User count:", count);
    process.exit(0);
  } catch (error) {
    console.error("Unable to connect to the database:", error);
    process.exit(1);
  }
}

test();
