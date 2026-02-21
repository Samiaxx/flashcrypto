const { app, BrowserWindow, ipcMain } = require("electron");
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
  if (msg.includes("cannot slice beyond data bounds")) {
    return "Contract call failed: check contract address and ABI (function may not exist on target contract).";
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

async function preflightMintFlash(privateKey, to, amount, expirationMs, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(cfg.contractAddress, cfg.contractAbi, wallet);
  const parsedAmount = ethers.parseUnits(String(amount), cfg.tokenDecimals);
  const mintArgs = buildMintCallArgs(contract, to, parsedAmount, expirationMs);

  // Simulate transaction execution without broadcasting.
  await contract.mintFlash.staticCall(...mintArgs);
  return { ok: true, from: wallet.address };
}

async function sendMintFlash(privateKey, to, amount, expirationMs, cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(cfg.contractAddress, cfg.contractAbi, wallet);

  const parsedAmount = ethers.parseUnits(String(amount), cfg.tokenDecimals);
  const mintArgs = buildMintCallArgs(contract, to, parsedAmount, expirationMs);
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

  // Do not block UI response while waiting for confirmation.
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

ipcMain.handle("app:get-config", async () => {
  const cfg = loadConfig();
  validateRuntimeConfig(cfg);
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

ipcMain.handle("tx:preflight", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
    if (!ethers.isAddress(payload.to)) throw new Error("Invalid destination wallet address.");
    if (!payload.privateKey || !payload.privateKey.startsWith("0x")) {
      throw new Error("Private key must include 0x prefix.");
    }
    if (Number(payload.amount) <= 0) throw new Error("Amount must be greater than zero.");
    return {
      ok: true,
      data: await preflightMintFlash(
        payload.privateKey,
        payload.to,
        payload.amount,
        payload.expirationMs,
        cfg
      )
    };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
});

ipcMain.handle("tx:send", async (_event, payload) => {
  const cfg = loadConfig();
  try {
    validateRuntimeConfig(cfg);
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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
