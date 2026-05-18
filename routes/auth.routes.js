const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { authenticateJWT } = require("../middlewares/auth.middleware");

router.post("/register", authController.register);
router.post("/verify", authController.verify);
router.post("/resend-verification", authController.resendVerification);
router.post("/login", authController.login);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

// Multi-role endpoints
router.post("/switch-role", authenticateJWT, authController.switchRole);
router.post("/upgrade-role", authenticateJWT, authController.upgradeRole);

module.exports = router;
