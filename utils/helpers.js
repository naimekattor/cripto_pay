const axios = require("axios");

function generate4DigitCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function normalizeAsset(asset, category) {
  const upper = (asset || "").toUpperCase();
  if (upper === "USDC") return "USDC";
  if (upper === "ETH") return "ETH";
  if (!upper && (category === "external" || category === "internal")) {
    return "ETH";
  }
  return upper || "";
}

function supportedIncomingAsset(asset) {
  return asset === "ETH" || asset === "USDC";
}

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

function withinExpectedAmount(expected, actual, asset) {
  const tolerance = asset === "USDC" ? 0.000001 : 0.0000000001;
  return Math.abs(Number(expected) - Number(actual)) <= tolerance;
}

function computeReleaseAt(holdHours = 24) {
  const releaseDate = new Date();
  releaseDate.setHours(releaseDate.getHours() + holdHours);
  return releaseDate;
}

async function getExchangeRates() {
  const [fiatRes, cryptoRes] = await Promise.all([
    axios.get("https://open.er-api.com/v6/latest/USD"),
    axios.get("https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD"),
  ]);

  return {
    ...fiatRes.data.rates,
    ETH: cryptoRes.data.USD,
  };
}

module.exports = {
  generate4DigitCode,
  normalizeAsset,
  supportedIncomingAsset,
  parseAmount,
  withinExpectedAmount,
  computeReleaseAt,
  getExchangeRates
};
