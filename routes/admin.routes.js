const express = require("express");
const router = express.Router();
const adminController = require("../controllers/admin.controller");
const { requireAdmin } = require("../middlewares/auth.middleware");
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

router.post("/cards/:id/approve", requireAdmin, adminController.approveCard);
router.post("/cards/:id/reject", requireAdmin, adminController.rejectCard);
router.post("/add-card", requireAdmin, upload.single("file"), adminController.addCard);
router.post("/refund", requireAdmin, adminController.refundPayment);
router.get("/profit/summary", requireAdmin, adminController.getProfitSummary);
router.get("/profit/details", requireAdmin, adminController.getProfitDetails);
router.post("/profit/withdraw", requireAdmin, adminController.withdrawProfit);

module.exports = router;
