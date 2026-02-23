# Flash USDT Desktop Implementation Checklist

This checklist maps your spec to the current codebase and marks what has been executed.

## 1) `config/config.json` and `.env` (network/contract wiring)
- [x] RPC endpoint is configurable (`rpcUrl` / `RPC_URL`)
- [x] Chain ID is configurable (`chainId` / `CHAIN_ID`)
- [x] Contract address is configurable (`contractAddress` / `CONTRACT_ADDRESS`)
- [x] ABI is configurable (`contractAbi` / `CONTRACT_ABI`)
- [x] Token decimals/symbol are configurable (`tokenDecimals`, `tokenSymbol`)

Files:
- `config/config.json`
- `config/config.example.json`
- `.env`
- `.env.example`

## 2) `src/main.js` (backend/Web3 execution)
- [x] Loads runtime config from JSON + env overrides
- [x] Validates address/amount/private key format
- [x] Supports both ABI signatures:
  - `mintFlash(address,uint256)`
  - `mintFlash(address,uint256,uint64)` (expiry-aware)
- [x] Estimates gas and fee (`tx:estimate`)
- [x] Sends tx (`tx:send`) and returns hash quickly
- [x] Tracks receipt async and updates history status:
  - `pending`
  - `confirmed`
  - `failed`
- [x] Persists local history (`tx-history.json`)
- [x] Removed preflight-gating path to restore direct send behavior

File:
- `src/main.js`

## 3) `src/preload.js` (secure renderer bridge)
- [x] Exposes only needed IPC methods:
  - `getConfig`
  - `estimate`
  - `send`
  - `history`
- [x] Removed unused `preflight` method

File:
- `src/preload.js`

## 4) `src/renderer/renderer.js` (UI transaction flow)
- [x] Validates required fields before sending
- [x] Uses direct send flow (no blocking preflight)
- [x] Shows status messages for estimate/send success/failure
- [x] Renders tx history with status pill + countdown display
- [x] Keeps periodic history refresh

File:
- `src/renderer/renderer.js`

## 5) GUI requirements status
- [x] Wallet address input
- [x] Token amount input
- [x] Expiration selector
- [x] Send button
- [x] Status panel
- [x] Transaction history/logs panel

Files:
- `src/renderer/index.html`
- `src/renderer/styles.css`

## 6) Notes about expiry behavior
- [x] If deployed contract enforces expiry on-chain, app passes expiry when ABI supports 3 args.
- [x] If deployed contract is 2-arg mint, app still works and UI shows local countdown.

Relevant files:
- `src/main.js`
- `src/renderer/renderer.js`
