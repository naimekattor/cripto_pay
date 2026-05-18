const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { User } = require("../models");
const { sendEmail } = require("../utils/email");
const { generate4DigitCode } = require("../utils/helpers");
const { JWT_SECRET } = require("../middlewares/auth.middleware");

exports.register = async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ error: "Email, password, and role are required." });
    }
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      // Check password to see if it's the correct owner trying to add/upgrade a role
      const match = await bcrypt.compare(password, existing.password_hash);
      if (!match) {
        return res.status(409).json({ error: "Email already in use." });
      }

      // Check if they already have this role
      const hasRole = (role === "buyer" && existing.is_buyer) || (role === "seller" && existing.is_seller);
      if (hasRole) {
        return res.status(400).json({ error: `Account already has ${role} role.` });
      }

      // Upgrade role
      if (role === "buyer") existing.is_buyer = true;
      if (role === "seller") existing.is_seller = true;
      await existing.save();

      return res.status(200).json({ 
        message: `Successfully attached ${role} role to your existing account!`, 
        id: existing.id,
        upgraded: true
      });
    }

    const verification_code = generate4DigitCode();
    const verification_code_expires = new Date(Date.now() + 3600000);

    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password_hash,
      role,
      is_buyer: role === "buyer" || role === "admin",
      is_seller: role === "seller" || role === "admin",
      verification_code,
      verification_code_expires,
      is_verified: false
    });

    await sendEmail({
      to: email,
      subject: "Verify your account - GiftCard Crypto",
      text: `Your verification code is: ${verification_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>Welcome to GiftCard Crypto!</h2>
              <p>Please use the following 4-digit code to verify your account:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2563eb; margin: 20px 0;">
                ${verification_code}
              </div>
              <p>This code will expire in 1 hour.</p>
            </div>`
    });

    res.status(201).json({ message: "User registered. Please check your email for the verification code.", id: user.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.verify = async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.is_verified) return res.status(400).json({ error: "User already verified" });

    if (user.verification_code !== code) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    if (new Date() > user.verification_code_expires) {
      return res.status(400).json({ error: "Verification code expired" });
    }

    user.is_verified = true;
    user.verification_code = null;
    user.verification_code_expires = null;
    await user.save();

    res.json({ message: "Email verified successfully. You can now log in." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_verified) return res.status(400).json({ error: "User already verified" });

    const verification_code = generate4DigitCode();
    const verification_code_expires = new Date(Date.now() + 3600000);

    user.verification_code = verification_code;
    user.verification_code_expires = verification_code_expires;
    await user.save();

    await sendEmail({
      to: email,
      subject: "Your new verification code - GiftCard Crypto",
      text: `Your new verification code is: ${verification_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>New Verification Code</h2>
              <p>Use the following 4-digit code to verify your account:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #2563eb; margin: 20px 0;">
                ${verification_code}
              </div>
              <p>This code will expire in 1 hour.</p>
            </div>`
    });

    res.json({ message: "A new verification code has been sent to your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (!user.is_verified) {
      return res.status(403).json({ error: "unverified", message: "Please verify your email before logging in." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const roles = [];
    if (user.is_buyer) roles.push("buyer");
    if (user.is_seller) roles.push("seller");
    if (user.role === "admin") roles.push("admin");

    if (roles.length === 0) {
      roles.push(user.role);
    }

    let activeRole = user.role;
    if (!roles.includes(activeRole)) {
      activeRole = roles[0];
    }

    const token = jwt.sign({ 
      id: user.id, 
      role: activeRole, 
      roles, 
      activeRole 
    }, JWT_SECRET, {
      expiresIn: "24h",
    });
    res.json({ token, role: activeRole, roles, activeRole, email: user.email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return res.status(404).json({ error: "If that email exists, we've sent a reset code." });
    }

    const reset_password_code = generate4DigitCode();
    const reset_password_expires = new Date(Date.now() + 3600000);

    user.reset_password_code = reset_password_code;
    user.reset_password_expires = reset_password_expires;
    await user.save();

    await sendEmail({
      to: email,
      subject: "Password Reset Request - GiftCard Crypto",
      text: `Your password reset code is: ${reset_password_code}`,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2>Password Reset Request</h2>
              <p>We received a request to reset your password. Use the following 4-digit code:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #dc2626; margin: 20px 0;">
                ${reset_password_code}
              </div>
              <p>This code will expire in 1 hour. If you didn't request this, please ignore this email.</p>
            </div>`
    });

    res.json({ message: "Password reset code sent to your email." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.reset_password_code !== code) {
      return res.status(400).json({ error: "Invalid reset code" });
    }

    if (new Date() > user.reset_password_expires) {
      return res.status(400).json({ error: "Reset code expired" });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    user.password_hash = password_hash;
    user.reset_password_code = null;
    user.reset_password_expires = null;
    await user.save();

    res.json({ message: "Password reset successfully. You can now log in with your new password." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.switchRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || (role !== "buyer" && role !== "seller" && role !== "admin")) {
      return res.status(400).json({ error: "Invalid role selected." });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const roles = [];
    if (user.is_buyer) roles.push("buyer");
    if (user.is_seller) roles.push("seller");
    if (user.role === "admin") roles.push("admin");

    if (!roles.includes(role)) {
      return res.status(403).json({ error: `You do not have access to the ${role} role.` });
    }

    user.role = role;
    await user.save();

    const token = jwt.sign({ 
      id: user.id, 
      role: role, 
      roles, 
      activeRole: role 
    }, JWT_SECRET, { expiresIn: "24h" });

    res.json({ token, roles, activeRole: role, email: user.email });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.upgradeRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || (role !== "buyer" && role !== "seller")) {
      return res.status(400).json({ error: "Valid role ('buyer' or 'seller') is required." });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    let updated = false;
    if (role === "buyer" && !user.is_buyer) {
      user.is_buyer = true;
      updated = true;
    } else if (role === "seller" && !user.is_seller) {
      user.is_seller = true;
      updated = true;
    }

    if (updated) {
      await user.save();
    }

    const roles = [];
    if (user.is_buyer) roles.push("buyer");
    if (user.is_seller) roles.push("seller");
    if (user.role === "admin") roles.push("admin");

    user.role = role;
    await user.save();

    const token = jwt.sign({ 
      id: user.id, 
      role: role, 
      roles, 
      activeRole: role 
    }, JWT_SECRET, { expiresIn: "24h" });

    res.json({ token, roles, activeRole: role, email: user.email, message: `Successfully upgraded to ${role}.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
