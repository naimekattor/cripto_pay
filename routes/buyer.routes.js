const express = require("express");
const router = express.Router();
const buyerController = require("../controllers/buyer.controller");
const { authenticateJWT } = require("../middlewares/auth.middleware");

router.get("/payments", authenticateJWT, buyerController.getPayments);
router.post("/payments/:id/complain", authenticateJWT, buyerController.complainPayment);
router.post("/payments/:id/confirm", authenticateJWT, buyerController.confirmPayment);
router.post("/payments/:id/reveal", authenticateJWT, buyerController.revealPayment);
router.post("/buy", authenticateJWT, buyerController.buyCard);

module.exports = router;
