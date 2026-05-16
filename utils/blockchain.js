const { ethers } = require("ethers");
require("dotenv").config();

const providerUrl =
  process.env.RPC_URL ||
  `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || ""}`;

const provider = new ethers.JsonRpcProvider(providerUrl);
const privateKey = process.env.METAMASK_PRIVATE_KEY;
const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;

const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || "";

async function transferFunds({ to, amount, asset, decimals }) {
  if (!wallet) throw new Error("Wallet is not configured.");

  if (asset === "USDC") {
    if (!USDC_CONTRACT_ADDRESS)
      throw new Error("USDC_CONTRACT_ADDRESS not set.");
    const erc20Abi = [
      "function transfer(address to, uint256 amount) returns (bool)",
    ];
    const token = new ethers.Contract(USDC_CONTRACT_ADDRESS, erc20Abi, wallet);
    const units = ethers.parseUnits(String(amount), Number(decimals || 6));
    const tx = await token.transfer(to, units);
    await tx.wait();
    return tx.hash;
  }

  const tx = await wallet.sendTransaction({
    to,
    value: ethers.parseEther(String(amount)),
  });
  await tx.wait();
  return tx.hash;
}

module.exports = {
  provider,
  wallet,
  transferFunds,
  USDC_CONTRACT_ADDRESS
};
