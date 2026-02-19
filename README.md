# Flash USDT Desktop (Electron)

Windows desktop application that connects to a BEP20 contract on BNB Smart Chain and calls `mintFlash(to, amount)`.

## Important

- This app only sends transactions to the configured contract.
- Expiration in this UI is a local timer for display/history. Real token expiry must be enforced by the smart contract.
- Private keys are entered locally in the app and used only for signing the transaction in memory.

## Tech Stack

- Electron (desktop UI)
- ethers.js (Web3 / contract calls)

## Project Structure

- `src/main.js`: Electron main process, RPC+contract interaction, IPC handlers, local tx history storage.
- `src/preload.js`: Secure bridge between renderer and main process.
- `src/renderer/index.html`: UI layout.
- `src/renderer/renderer.js`: UI behavior and IPC calls.
- `src/renderer/styles.css`: UI styles.
- `config/config.json`: Active runtime config.
- `config/config.example.json`: Example config template.
- `.env`: Optional runtime overrides for config values.

## Setup

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Create `.env` if needed (or copy `.env.example`).
4. Start app:

```bash
npm start
```

## Build Windows EXE

```bash
npm run dist
```

Build output is generated under `dist/` as a portable `.exe` and unpacked binaries.

## Configuration

Edit `config/config.json` or override with `.env`:

- `RPC_URL`
- `CHAIN_ID`
- `CONTRACT_ADDRESS`
- `TOKEN_SYMBOL`
- `TOKEN_DECIMALS`
- `CONTRACT_ABI` (JSON string)

JSON config keys:

- `rpcUrl`: BNB RPC endpoint.
- `chainId`: `56` for BNB Mainnet.
- `contractAddress`: target contract address.
- `tokenDecimals`: parse amount precision for `mintFlash`.
- `contractAbi`: ABI used to load contract methods.

## Data Flow

1. User enters private key, recipient address, amount, and expiry preference.
2. Renderer sends payload via IPC to main process.
3. Main process validates input and calls `mintFlash` with ethers.
4. Tx hash is returned and history is persisted in local app data.
5. Receipt updates tx status (`pending` -> `confirmed` / `failed`).

## Error Handling

- Wallet address validation via `ethers.isAddress`.
- Amount must be greater than 0.
- Private key must be hex string with `0x` prefix.
- RPC and revert errors are captured and displayed in the UI.

## Optional Extensions

- Add encrypted key vault (e.g., keytar + OS credential store).
- Add batch sending CSV workflow.
- Add testnet/mainnet switch in UI.
- Add BscScan link rendering in history.