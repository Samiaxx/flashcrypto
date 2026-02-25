const electron = require("electron");
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  if (process.env.ELECTRON_RESPAWNED === "1") {
    throw new Error("Electron failed to start in desktop mode.");
  }

  const env = { ...process.env, ELECTRON_RESPAWNED: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [process.argv[1], ...process.argv.slice(2)], {
    stdio: "inherit",
    env
  });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { ethers } = require("ethers");

const configPath = path.join(__dirname, "..", "config", "config.json");
const fallbackConfigPath = path.join(__dirname, "..", "config", "config.example.json");
const envPath = path.join(__dirname, "..", ".env");

dotenv.config({ path: envPath });

function loadConfig() {
  const source = fs.existsSync(configPath) ? configPath : fallbackConfigPath;
  const raw = fs.readFileSync(source, "utf-8");
  const baseConfig = JSON.parse(raw);

  let abi = baseConfig.contractAbi;
  if (process.env.CONTRACT_ABI) {
    try {
      abi = JSON.parse(process.env.CONTRACT_ABI);
    } catch {
      throw new Error("CONTRACT_ABI in .env must be valid JSON.");
    }
  }

  return {
    ...baseConfig,
    rpcUrl: process.env.RPC_URL || baseConfig.rpcUrl,
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : baseConfig.chainId,
    contractAddress: process.env.CONTRACT_ADDRESS || baseConfig.contractAddress,
    tokenSymbol: process.env.TOKEN_SYMBOL || baseConfig.tokenSymbol,
    tokenDecimals: process.env.TOKEN_DECIMALS
      ? Number(process.env.TOKEN_DECIMALS)
      : baseConfig.tokenDecimals,
    contractAbi: abi
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 860,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

const historyFilePath = path.join(app.getPath("userData"), "tx-history.json");

function readHistory() {
  try {
    if (!fs.existsSync(historyFilePath)) return [];
    return JSON.parse(fs.readFileSync(historyFilePath, "utf-8"));
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  fs.writeFileSync(historyFilePath, JSON.stringify(entries, null, 2), "utf-8");
}

function normalizeError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  const msg = err.shortMessage || err.reason || err.message || "Unknown error";

  const data =
    err?.data ||
    err?.error?.data ||
    err?.info?.error?.data ||
    err?.info?.data ||
    "";

  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const ownableUnauthorizedSelector = ethers
      .id("OwnableUnauthorizedAccount(address)")
      .slice(0, 10)
      .toLowerCase();

    if (selector === ownableUnauthorizedSelector && data.length >= 138) {
      const addr = `0x${data.slice(-40)}`;
      return `Only contract owner can mint. Sender ${addr} is not authorized.`;
    }
  }

  if (msg.includes("cannot slice beyond data bounds")) {
    return "Contract call failed: check contract address and ABI (function may not exist on target contract).";
  }
  if (msg.includes("execution reverted (no data present")) {
    return "Contract reverted without reason. Common causes: wrong ABI/signature, sender is not contract owner, or contract rules rejected this mint.";
  }
  return msg;
}

function validateRuntimeConfig(cfg) {
  if (!ethers.isAddress(cfg.contractAddress)) {
    throw new Error(
      `Invalid CONTRACT_ADDRESS: "${cfg.contractAddress}". Use a valid 42-character EVM address.`
    );
  }
  if (!Array.isArray(cfg.contractAbi) || cfg.contractAbi.length === 0) {
    throw new Error("Invalid CONTRACT_ABI: ABI must be a non-empty array.");
  }
}

async function validateContractTargetOnChain(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const code = await provider.getCode(cfg.contractAddress);
  if (!code || code === "0x") {
    throw new Error(
      `Configured CONTRACT_ADDRESS has no contract code on chain ${cfg.chainId}: ${cfg.contractAddress}`
    );
  }
}

function buildMintCallArgs(contract, to, parsedAmount, expirationMs) {
  const fn = contract.interface.getFunction("mintFlash");
  if (!fn) throw new Error("mintFlash function not found in ABI.");

  if (fn.inputs.length === 3) {
    if (!Number.isFinite(expirationMs) || expirationMs < 60000) {
      throw new Error("Expiration must be at least 1 minute.");
    }
    const expiresAtUnix = BigInt(Math.floor((Date.now() + expirationMs) / 1000));
    return [to, parsedAmount, expiresAtUnix];
  }

  if (fn.inputs.length === 2) {
    return [to, parsedAmount];
  }

  throw new Error("Unsupported mintFlash signature. Expected 2 or 3 inputs.");
}

async function estimateGasAndFee(privateKey, to, amount, expirationMs, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(cfg.contractAddress, cfg.contractAbi, wallet);

  const parsedAmount = ethers.parseUnits(String(amount), cfg.tokenDecimals);
  const mintArgs = buildMintCallArgs(contract, to, parsedAmount, expirationMs);
  const txReq = await contract.mintFlash.populateTransaction(...mintArgs);
  const gasEstimate = await provider.estimateGas({ ...txReq, from: wallet.address });
  const feeData = await provider.getFeeData();

  const gasPrice = feeData.gasPrice || 0n;
  const estimatedFeeWei = gasEstimate * gasPrice;

  return {
    from: wallet.address,
    gasEstimate: gasEstimate.toString(),
    gasPriceGwei: gasPrice > 0n ? ethers.formatUnits(gasPrice, "gwei") : "N/A",
    estimatedFeeBnb: gasPrice > 0n ? ethers.formatEther(estimatedFeeWei) : "N/A"
  };
}

async function assertOwnerIfAvailable(contract, walletAddress) {
  if (typeof contract.owner !== "function") return;
  const ownerAddr = await contract.owner();
  if (ethers.isAddress(ownerAddr) && ownerAddr.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(`Only owner can mint. Contract owner is ${ownerAddr}, sender is ${walletAddress}.`);
  }
}

async function sendMintFlash(privateKey, to, amount, expirationMs, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(cfg.contractAddress, cfg.contractAbi, wallet);

  const parsedAmount = ethers.parseUnits(String(amount), cfg.tokenDecimals);
  const mintArgs = buildMintCallArgs(contract, to, parsedAmount, expirationMs);
  await assertOwnerIfAvailable(contract, wallet.address);

  // Static preflight surfaces revert reasons before broadcast.
  await contract.mintFlash.staticCall(...mintArgs);

  const tx = await contract.mintFlash(...mintArgs);

  const createdAt = Date.now();
  const expiresAt = createdAt + expirationMs;

  const historyEntry = {
    id: `${tx.hash}-${createdAt}`,
    hash: tx.hash,
    to,
    amount: String(amount),
    symbol: cfg.tokenSymbol,
    createdAt,
    expiresAt,
    status: "pending"
  };

  const current = readHistory();
  writeHistory([historyEntry, ...current].slice(0, 200));

  tx.wait()
    .then((receipt) => {
      const updated = readHistory().map((item) => {
        if (item.id !== historyEntry.id) return item;
        return {
          ...item,
          status: receipt.status === 1 ? "confirmed" : "failed",
          blockNumber: receipt.blockNumber
        };
      });
      writeHistory(updated);
    })
    .catch((err) => {
      const updated = readHistory().map((item) => {
        if (item.id !== historyEntry.id) return item;
        return {
          ...item,
          status: "failed",
          error: normalizeError(err)
        };
      });
      writeHistory(updated);
    });

  return { hash: tx.hash, createdAt, expiresAt };
}

async function getTokenBalance(walletAddress, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const erc20ReadAbi = ["function balanceOf(address) view returns (uint256)"];
  const contract = new ethers.Contract(cfg.contractAddress, erc20ReadAbi, provider);
  const rawBalance = await contract.balanceOf(walletAddress);
  const formatted = ethers.formatUnits(rawBalance, cfg.tokenDecimals);
  return {
    wallet: walletAddress,
    raw: rawBalance.toString(),
    formatted
  };
}

async function burnExpiredBalance(privateKey, account, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const burnAbi = ["function burnExpired(address account) returns (uint256)"];
  const contract = new ethers.Contract(cfg.contractAddress, burnAbi, wallet);

  const tx = await contract.burnExpired(account);
  return { hash: tx.hash };
}

ipcMain.handle("app:get-config", async () => {
  const cfg = loadConfig();
  validateRuntimeConfig(cfg);
  await validateContractTargetOnChain(cfg);
  return {
    rpcUrl: cfg.rpcUrl,
    chainId: cfg.chainId,
    contractAddress: cfg.contractAddress,
    tokenSymbol: cfg.tokenSymbol,
    tokenDecimals: cfg.tokenDecimals
  };
});

ipcMain.handle("tx:estimate", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
    await validateContractTargetOnChain(cfg);
    if (!ethers.isAddress(payload.to)) throw new Error("Invalid destination wallet address.");
    if (!payload.privateKey || !payload.privateKey.startsWith("0x")) {
      throw new Error("Private key must include 0x prefix.");
    }
    if (Number(payload.amount) <= 0) throw new Error("Amount must be greater than zero.");
    return {
      ok: true,
      data: await estimateGasAndFee(payload.privateKey, payload.to, payload.amount, payload.expirationMs, cfg)
    };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
});

ipcMain.handle("tx:send", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
    await validateContractTargetOnChain(cfg);
    if (!ethers.isAddress(payload.to)) throw new Error("Invalid destination wallet address.");
    if (!payload.privateKey || !payload.privateKey.startsWith("0x")) {
      throw new Error("Private key must include 0x prefix.");
    }
    if (Number(payload.amount) <= 0) throw new Error("Amount must be greater than zero.");
    if (!Number.isFinite(payload.expirationMs) || payload.expirationMs < 60000) {
      throw new Error("Expiration must be at least 1 minute.");
    }

    const tx = await sendMintFlash(
      payload.privateKey,
      payload.to,
      payload.amount,
      payload.expirationMs,
      cfg
    );
    return { ok: true, data: tx };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
});

ipcMain.handle("tx:history", async () => readHistory());

ipcMain.handle("tx:burn-expired", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
    await validateContractTargetOnChain(cfg);
    if (!payload.privateKey || !payload.privateKey.startsWith("0x")) {
      throw new Error("Private key must include 0x prefix.");
    }
    if (!ethers.isAddress(payload.account)) {
      throw new Error("Invalid wallet address for burnExpired.");
    }
    const data = await burnExpiredBalance(payload.privateKey, payload.account, cfg);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
});

ipcMain.handle("token:balance", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
    await validateContractTargetOnChain(cfg);
    if (!ethers.isAddress(payload.wallet)) throw new Error("Invalid wallet address.");
    return { ok: true, data: await getTokenBalance(payload.wallet, cfg) };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
