const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cron = require("node-cron");
const axios = require("axios");
const { ethers } = require("ethers");
const app = express();
require("dotenv").config();
app.use(express.json());

const PORT = 3000;

const provider = new ethers.JsonRpcProvider(
  `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
);
// const provider = new ethers.JsonRpcProvider(
//   `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
// );
const privateKey = process.env.METAMASK_PRIVATE_KEY;
const wallet = new ethers.Wallet(privateKey, provider);
// --- 1. DATABASE SETUP ---
const db = new sqlite3.Database("./payments.db", (err) => {
  if (err) console.error("DB Connection Error:", err.message);
  else console.log("Connected to SQLite database.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    amount REAL,
    currency TEXT,
    status TEXT,
    release_at DATETIME,
    user_address TEXT,  -- Added this
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
});

// --- 2. THE CRON JOB (The "24h Timer") ---
// Runs every hour to check if it's time to release funds
cron.schedule("0 * * * *", async () => {
  const now = new Date().toISOString();

  db.all(
    `SELECT * FROM payments WHERE status = 'holding' AND release_at <= ?`,
    [now],
    async (err, rows) => {
      for (let payment of rows) {
        try {
          // Actual Blockchain Transfer
          const tx = await wallet.sendTransaction({
            to: "YOUR_DIFFERENT_ACCOUNT_ADDRESS",
            value: ethers.parseEther(payment.amount.toString()),
          });
          await tx.wait(); // Wait for confirmation

          db.run(`UPDATE payments SET status = 'completed' WHERE id = ?`, [
            payment.id,
          ]);
          console.log("Funds transferred to main account!");
        } catch (error) {
          console.error("Transfer failed:", error);
        }
      }
    },
  );
});

// --- 3. ROUTES ---

// Route to initiate a payment
app.post("/create-payment", async (req, res) => {
  const { amount, currency } = req.body;

  try {
    // STEP: Call your 3rd party API here (e.g., NOWPayments/Cryptomus)
    // const response = await axios.post('...', { amount, currency });

    const mockExternalId = "PAY_" + Math.random().toString(36).substr(2, 9);
    const releaseDate = new Date();
    releaseDate.setHours(releaseDate.getHours() + 24); // Set 24h from now

    db.run(
      `INSERT INTO payments (external_id, amount, currency, status, release_at) VALUES (?, ?, ?, ?, ?)`,
      [mockExternalId, amount, currency, "pending", releaseDate.toISOString()],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          message: "Payment created",
          payment_id: mockExternalId,
          note: "Status is pending until webhook confirms payment",
        });
      },
    );
  } catch (error) {
    res.status(500).json({ error: "Failed to connect to provider" });
  }
});

// Route to trigger a RETURN (Manual or Logic-based)
app.post("/return-payment", async (req, res) => {
  const { payment_id } = req.body;

  db.get(
    `SELECT * FROM payments WHERE external_id = ?`,
    [payment_id],
    async (err, row) => {
      if (row && row.status === "holding") {
        try {
          // Send the money back to the user_address we saved in the webhook
          const tx = await wallet.sendTransaction({
            to: row.user_address,
            value: ethers.parseUnits(row.amount.toString(), "ether"),
          });
          await tx.wait();

          db.run(
            `UPDATE payments SET status = 'returned' WHERE external_id = ?`,
            [payment_id],
          );
          res.send(`Payment ${payment_id} returned to user.`);
        } catch (error) {
          res.status(500).send("Refund failed: " + error.message);
        }
      } else {
        res.status(400).send("Payment not eligible for return.");
      }
    },
  );
});
app.post("/alchemy-webhook", (req, res) => {
  // 1. Log the body so you can see exactly what Alchemy sends in your terminal
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));

  const { event } = req.body;

  // 2. Safety check: Ensure this is actual activity and not a test ping
  if (event && event.activity && event.activity.length > 0) {
    event.activity.forEach((tx) => {
      const amount = tx.value;
      const fromAddress = tx.fromAddress;
      const hash = tx.hash;

      const releaseAt = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();

      // We use the transaction hash as the external_id to keep it unique
      db.run(
        `INSERT OR REPLACE INTO payments (external_id, amount, status, release_at, user_address) VALUES (?, ?, ?, ?, ?)`,
        [hash, amount, "holding", releaseAt, fromAddress],
        (err) => {
          if (err) console.error("DB Update Error:", err.message);
          else console.log(`Transaction ${hash} is now on 24h hold.`);
        },
      );
    });
  }

  // 3. Always return 200 OK to Alchemy immediately
  res.status(200).send("Received");
});
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
