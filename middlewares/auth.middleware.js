const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "your-very-secure-jwt-secret-key-here";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(" ")[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(403).json({ error: "Invalid token" });
      req.user = user;
      next();
    });
  } else {
    return res.status(401).json({ error: "Authentication token required" });
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next();
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role === "admin") return next();
    } catch (e) {}
  }
  return res.status(401).json({ error: "Unauthorized admin request." });
}

module.exports = {
  authenticateJWT,
  requireAdmin,
  JWT_SECRET
};
