const express = require("express");
const router = express.Router();
const sellerController = require("../controllers/seller.controller");
const { authenticateJWT } = require("../middlewares/auth.middleware");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeOriginal = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeOriginal}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

router.get("/cards", authenticateJWT, sellerController.getCards);
router.post("/cards/:id/cancel", authenticateJWT, sellerController.cancelCard);
router.post("/cards/sell", authenticateJWT, upload.single("file"), sellerController.sellCard);

module.exports = router;
