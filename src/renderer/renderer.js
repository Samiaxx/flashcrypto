const statusPanel = document.getElementById("statusPanel");
const historyEl = document.getElementById("history");
const networkInfoEl = document.getElementById("networkInfo");
const tokenBalanceValueEl = document.getElementById("tokenBalanceValue");
const tokenPriceValueEl = document.getElementById("tokenPriceValue");
const fiatValueValueEl = document.getElementById("fiatValueValue");
const valuationUpdatedEl = document.getElementById("valuationUpdated");
const importPanelEl = document.getElementById("importPanel");
const importContractEl = document.getElementById("importContract");
const importSymbolEl = document.getElementById("importSymbol");
const importDecimalsEl = document.getElementById("importDecimals");
const importRecipientEl = document.getElementById("importRecipient");
const copyContractBtn = document.getElementById("copyContractBtn");
const copySymbolBtn = document.getElementById("copySymbolBtn");
const copyDecimalsBtn = document.getElementById("copyDecimalsBtn");
const copyRecipientBtn = document.getElementById("copyRecipientBtn");

const privateKeyInput = document.getElementById("privateKey");
const toAddressInput = document.getElementById("toAddress");
const amountInput = document.getElementById("amount");
const expValueInput = document.getElementById("expValue");
const expUnitInput = document.getElementById("expUnit");

const estimateBtn = document.getElementById("estimateBtn");
const sendBtn = document.getElementById("sendBtn");
const burnBtn = document.getElementById("burnBtn");

let appConfig = null;
let valuationTimer = null;

function setStatus(message, type = "info") {
  statusPanel.textContent = message;
  statusPanel.className = "status";
  if (type === "error") statusPanel.classList.add("error");
  if (type === "success") statusPanel.classList.add("success");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function shortHash(hash) {
  if (!hash || hash.length < 14) return hash || "";
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function expirationToMs(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (unit === "minutes") return n * 60 * 1000;
  if (unit === "hours") return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function formatCountdown(expiresAt) {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "expired";

  const sec = Math.floor(diff / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatNumber(value, maxFraction = 6) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFraction
  });
}

function setValuationStatus(message) {
  valuationUpdatedEl.textContent = message;
}

function setValuationValues(balanceText, priceText, valueText) {
  tokenBalanceValueEl.textContent = balanceText;
  tokenPriceValueEl.textContent = priceText;
  fiatValueValueEl.textContent = valueText;
}

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    setStatus(`${label} copied.`, "success");
  } catch {
    setStatus(`Failed to copy ${label}.`, "error");
  }
}

function showImportPanel(recipient) {
  importContractEl.value = appConfig?.contractAddress || "";
  importSymbolEl.value = appConfig?.tokenSymbol || "USDT";
  importDecimalsEl.value = String(appConfig?.tokenDecimals ?? 18);
  importRecipientEl.value = recipient || "";
  importPanelEl.classList.remove("hidden");
  importPanelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function fetchUsdtPriceUsd() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }
    );

    if (!res.ok) throw new Error(`Price API error (${res.status})`);
    const json = await res.json();
    const price = Number(json?.tether?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Price feed unavailable");
    return price;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshValuation() {
  const wallet = toAddressInput.value.trim();
  if (!wallet) {
    setValuationValues("-", "-", "-");
    setValuationStatus("Enter recipient wallet to load valuation.");
    return;
  }

  setValuationStatus("Loading balance and live price...");
  const [balRes, priceUsd] = await Promise.all([
    window.flashApi.getBalance(wallet),
    fetchUsdtPriceUsd()
  ]);

  if (!balRes.ok) {
    setValuationValues("-", "-", "-");
    setValuationStatus(`Balance unavailable: ${balRes.error}`);
    return;
  }

  const balance = Number(balRes.data.formatted);
  const valueUsd = balance * priceUsd;

  setValuationValues(
    `${formatNumber(balance, 6)} ${appConfig?.tokenSymbol || ""}`.trim(),
    `$${formatNumber(priceUsd, 4)}`,
    `$${formatNumber(valueUsd, 2)}`
  );
  setValuationStatus(`Updated ${new Date().toLocaleTimeString()}`);
}

function scheduleValuationRefresh(delayMs = 0) {
  if (valuationTimer) clearTimeout(valuationTimer);
  valuationTimer = setTimeout(() => {
    refreshValuation().catch((err) => {
      setValuationValues("-", "-", "-");
      setValuationStatus(`Valuation failed: ${err.message || err}`);
    });
  }, delayMs);
}

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyEl.innerHTML = "<p class=\"history-to\">No transactions yet.</p>";
    return;
  }

  historyEl.innerHTML = items
    .map((item) => {
      const safeAmount = escapeHtml(item.amount);
      const safeSymbol = escapeHtml(item.symbol);
      const safeTo = escapeHtml(item.to);
      const safeHash = escapeHtml(item.hash);
      return `
      <div class="history-item">
        <div class="history-item-head">
          <div class="history-amount">${safeAmount} ${safeSymbol}</div>
          <span class="pill ${item.status}">${item.status}</span>
        </div>
        <div class="history-to">Recipient: ${safeTo}</div>
        <div class="history-meta">Hash: ${shortHash(safeHash)} (${safeHash})</div>
        <div class="history-to">Created: ${new Date(item.createdAt).toLocaleString()}</div>
        <div class="history-to">Expires in: ${formatCountdown(item.expiresAt)}</div>
      </div>
    `;
    })
    .join("");
}

async function refreshHistory() {
  const history = await window.flashApi.history();
  renderHistory(history);
}

function payloadFromForm() {
  return {
    privateKey: privateKeyInput.value.trim(),
    to: toAddressInput.value.trim(),
    amount: amountInput.value.trim(),
    expirationMs: expirationToMs(expValueInput.value, expUnitInput.value)
  };
}

estimateBtn.addEventListener("click", async () => {
  const payload = payloadFromForm();

  if (!payload.privateKey || !payload.to || !payload.amount) {
    setStatus("Private key, recipient address, and amount are required.", "error");
    return;
  }

  setStatus("Estimating gas...");
  const res = await window.flashApi.estimate(payload);
  if (!res.ok) {
    setStatus(`Estimate failed: ${res.error}`, "error");
    return;
  }

  const d = res.data;
  setStatus(
    `From ${d.from} | Gas: ${d.gasEstimate} | Gas price: ${d.gasPriceGwei} gwei | Estimated fee: ${d.estimatedFeeBnb} BNB`,
    "success"
  );
});

sendBtn.addEventListener("click", async () => {
  const payload = payloadFromForm();

  if (!payload.privateKey || !payload.to || !payload.amount) {
    setStatus("Private key, recipient address, and amount are required.", "error");
    return;
  }

  if (!Number.isFinite(payload.expirationMs)) {
    setStatus("Expiration value is invalid.", "error");
    return;
  }

  setStatus("Sending transaction...");
  const res = await window.flashApi.send(payload);

  if (!res.ok) {
    setStatus(`Send failed: ${res.error}`, "error");
    return;
  }

  setStatus(`Transaction submitted: ${res.data.hash}`, "success");
  showImportPanel(payload.to);
  await refreshHistory();
  scheduleValuationRefresh(1500);
});

burnBtn.addEventListener("click", async () => {
  const privateKey = privateKeyInput.value.trim();
  const account = toAddressInput.value.trim();

  if (!privateKey || !account) {
    setStatus("Private key and recipient address are required for burn.", "error");
    return;
  }

  setStatus("Sending burnExpired transaction...");
  const res = await window.flashApi.burnExpired(privateKey, account);
  if (!res.ok) {
    setStatus(`Burn failed: ${res.error}`, "error");
    return;
  }

  setStatus(`Burn submitted: ${res.data.hash}`, "success");
  scheduleValuationRefresh(2000);
});

toAddressInput.addEventListener("blur", () => scheduleValuationRefresh(0));
toAddressInput.addEventListener("change", () => scheduleValuationRefresh(0));
copyContractBtn.addEventListener("click", () => copyText(importContractEl.value, "Contract address"));
copySymbolBtn.addEventListener("click", () => copyText(importSymbolEl.value, "Symbol"));
copyDecimalsBtn.addEventListener("click", () => copyText(importDecimalsEl.value, "Decimals"));
copyRecipientBtn.addEventListener("click", () => copyText(importRecipientEl.value, "Recipient address"));

async function init() {
  appConfig = await window.flashApi.getConfig();
  networkInfoEl.textContent = `RPC ${appConfig.rpcUrl} | Chain ${appConfig.chainId} | Contract ${appConfig.contractAddress}`;
  await refreshHistory();
  scheduleValuationRefresh(0);
  importPanelEl.classList.add("hidden");
  setStatus("Ready");
  setInterval(refreshHistory, 30000);
  setInterval(() => scheduleValuationRefresh(0), 60000);
}

init().catch((err) => {
  setStatus(`Initialization error: ${err.message || err}`, "error");
});
