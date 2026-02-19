const statusPanel = document.getElementById("statusPanel");
const historyEl = document.getElementById("history");
const networkInfoEl = document.getElementById("networkInfo");

const privateKeyInput = document.getElementById("privateKey");
const toAddressInput = document.getElementById("toAddress");
const amountInput = document.getElementById("amount");
const expValueInput = document.getElementById("expValue");
const expUnitInput = document.getElementById("expUnit");

const estimateBtn = document.getElementById("estimateBtn");
const sendBtn = document.getElementById("sendBtn");

let appConfig = null;

function setStatus(message, type = "info") {
  statusPanel.textContent = message;
  statusPanel.className = "status";
  if (type === "error") statusPanel.classList.add("error");
  if (type === "success") statusPanel.classList.add("success");
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

function renderHistory(items) {
  if (!items || items.length === 0) {
    historyEl.innerHTML = "<p>No transactions yet.</p>";
    return;
  }

  historyEl.innerHTML = items
    .map((item) => {
      return `
      <div class="history-item">
        <div>
          <strong>${item.amount} ${item.symbol}</strong> to ${item.to}
          <span class="pill ${item.status}">${item.status}</span>
        </div>
        <div class="meta">Hash: ${item.hash}</div>
        <div class="meta">Created: ${new Date(item.createdAt).toLocaleString()}</div>
        <div class="meta">Expires in: ${formatCountdown(item.expiresAt)}</div>
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
  await refreshHistory();
});

async function init() {
  appConfig = await window.flashApi.getConfig();
  networkInfoEl.textContent = `RPC: ${appConfig.rpcUrl} | Chain ID: ${appConfig.chainId} | Contract: ${appConfig.contractAddress}`;
  await refreshHistory();
  setStatus("Ready");
  setInterval(refreshHistory, 30000);
}

init().catch((err) => {
  setStatus(`Initialization error: ${err.message || err}`, "error");
});
