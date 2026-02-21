// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FlashUSDT is ERC20, Ownable {
    struct FlashBalance {
        uint256 amount;
        uint64 expiresAt;
    }

    mapping(address => FlashBalance[]) private _flashBalances;
    string public contractMetadataURI;

    bool private _bypassHook;

    event FlashMinted(address indexed to, uint256 amount, uint64 expiresAt);
    event ExpiredBalanceBurned(address indexed account, uint256 amount, uint64 burnedAt);
    event ContractMetadataUpdated(string uri);

    constructor(address initialOwner, string memory metadataUri)
        ERC20("Flash USDT", "fUSDT")
        Ownable(initialOwner)
    {
        contractMetadataURI = metadataUri;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function setContractMetadataURI(string calldata uri) external onlyOwner {
        contractMetadataURI = uri;
        emit ContractMetadataUpdated(uri);
    }

    function mintFlash(address to, uint256 amount, uint64 expiresAt) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");
        require(expiresAt > block.timestamp, "Expiry must be in future");

        _syncExpiry(to);
        _appendTranche(to, amount, expiresAt);
        _mint(to, amount);

        emit FlashMinted(to, amount, expiresAt);
    }

    function flashBalancesOf(address account) external view returns (FlashBalance[] memory) {
        return _flashBalances[account];
    }

    function activeBalanceOf(address account) public view returns (uint256 total) {
        FlashBalance[] storage tranches = _flashBalances[account];
        for (uint256 i = 0; i < tranches.length; i++) {
            if (block.timestamp < tranches[i].expiresAt) {
                total += tranches[i].amount;
            }
        }
    }

    function expiredBalanceOf(address account) public view returns (uint256 total) {
        FlashBalance[] storage tranches = _flashBalances[account];
        for (uint256 i = 0; i < tranches.length; i++) {
            if (block.timestamp >= tranches[i].expiresAt) {
                total += tranches[i].amount;
            }
        }
    }

    function burnExpired(address account) external returns (uint256 burnedAmount) {
        return _syncExpiry(account);
    }

    function sweepExpired(address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            _syncExpiry(accounts[i]);
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        if (_bypassHook) {
            super._update(from, to, value);
            return;
        }

        if (from == address(0)) {
            // Mint path: tranche state is handled in mintFlash.
            super._update(from, to, value);
            return;
        }

        if (to == address(0)) {
            // Burn path: keep tranche state aligned with burned amount.
            _syncExpiry(from);
            _consumeFromTranches(from, value);
            super._update(from, to, value);
            return;
        }

        // Transfer path: burn expired on both sides, then preserve tranche expiries in movement.
        _syncExpiry(from);
        _syncExpiry(to);
        _moveTranches(from, to, value);

        super._update(from, to, value);
    }

    function _syncExpiry(address account) internal returns (uint256 burnedAmount) {
        FlashBalance[] storage tranches = _flashBalances[account];
        uint256 i = 0;

        while (i < tranches.length) {
            if (block.timestamp >= tranches[i].expiresAt) {
                burnedAmount += tranches[i].amount;
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                i++;
            }
        }

        if (burnedAmount > 0) {
            _bypassHook = true;
            super._update(account, address(0), burnedAmount);
            _bypassHook = false;
            emit ExpiredBalanceBurned(account, burnedAmount, uint64(block.timestamp));
        }
    }

    function _moveTranches(address from, address to, uint256 amount) internal {
        FlashBalance[] storage tranches = _flashBalances[from];
        uint256 remaining = amount;
        uint256 i = 0;

        while (remaining > 0 && i < tranches.length) {
            uint256 take = tranches[i].amount <= remaining ? tranches[i].amount : remaining;
            _appendTranche(to, take, tranches[i].expiresAt);

            tranches[i].amount -= take;
            remaining -= take;

            if (tranches[i].amount == 0) {
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                i++;
            }
        }

        require(remaining == 0, "Insufficient active flash balance");
    }

    function _consumeFromTranches(address from, uint256 amount) internal {
        FlashBalance[] storage tranches = _flashBalances[from];
        uint256 remaining = amount;
        uint256 i = 0;

        while (remaining > 0 && i < tranches.length) {
            uint256 take = tranches[i].amount <= remaining ? tranches[i].amount : remaining;
            tranches[i].amount -= take;
            remaining -= take;

            if (tranches[i].amount == 0) {
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                i++;
            }
        }

        require(remaining == 0, "Insufficient active flash balance");
    }

    function _appendTranche(address account, uint256 amount, uint64 expiresAt) internal {
        FlashBalance[] storage tranches = _flashBalances[account];

        // Merge into latest tranche when expiry matches to reduce storage growth.
        if (tranches.length > 0 && tranches[tranches.length - 1].expiresAt == expiresAt) {
            tranches[tranches.length - 1].amount += amount;
            return;
        }

        tranches.push(FlashBalance({amount: amount, expiresAt: expiresAt}));
    }
}
