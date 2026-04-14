// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISavings} from '../frankencoin/ISavings.sol';

contract SavingsToken is ERC20 {
	using Math for uint256;
	using SafeERC20 for IERC20;

	IERC20 public immutable zchf;
	ISavings public immutable savings;

	uint256 public totalClaimed;
	uint256 private price = 1 ether;

	// ---------------------------------------------------------------------------------------

	event Saved(address indexed saver, uint256 amountIn, uint256 sharesMinted, uint256 price);
	event Withdrawn(address indexed saver, uint256 sharesBurned, uint256 amountOut, uint256 price);

	// ---------------------------------------------------------------------------------------
	// name: "Savings for Frankencoin ZCHF", symbol: "sZCHF"

	constructor(IERC20 _zchf, ISavings _savings, string memory name, string memory symbol) ERC20(name, symbol) {
		zchf = _zchf;
		savings = _savings;
	}

	// ---------------------------------------------------------------------------------------

	function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
		return interfaceId == type(ERC20).interfaceId;
	}

	// ---------------------------------------------------------------------------------------
	// input token is ZCHF, output token is stZCHF

	function save(uint256 amount) public returns (uint256) {
		return saveTo(msg.sender, amount);
	}

	// match savings module signature
	function save(address owner, uint192 amount) public {
		saveTo(owner, uint256(amount));
	}

	function saveTo(address account, uint256 amount) public returns (uint256) {
		_update();

		zchf.safeTransferFrom(msg.sender, address(this), amount);
		savings.save(uint192(amount));

		uint256 shares = (amount * 1 ether) / price;
		_mint(account, shares);

		emit Saved(account, amount, shares, price);
		return shares;
	}

	// ---------------------------------------------------------------------------------------
	// input token is stZCHF, output token is ZCHF

	function withdraw(uint256 shares) public returns (uint256) {
		return withdrawTo(msg.sender, shares);
	}

	// match savings module signature
	function withdraw(address target, uint192 amount) public returns (uint256) {
		return withdrawTo(target, uint256(amount));
	}

	function withdrawTo(address target, uint256 shares) public returns (uint256) {
		_update();

		_burn(msg.sender, shares);

		// @dev: calc amountOut, but make sure to withdraw max if all shares are burned
		uint256 amountOut = (shares * price) / 1 ether;
		amountOut = savings.withdraw(target, totalSupply() == 0 ? type(uint192).max : uint192(amountOut));

		emit Withdrawn(target, shares, amountOut, price);
		return amountOut;
	}

	// ---------------------------------------------------------------------------------------

	function _update() internal {
		uint256 interest = uint256(savings.accruedInterest(address(this)));

		if (interest > 0 && totalSupply() > 0) {
			totalClaimed += interest;
			price += (interest * 1 ether) / totalSupply();
		}
	}

	// ---------------------------------------------------------------------------------------

	function convertToAsset() public view returns (uint256) {
		uint256 totS = totalSupply();
		if (totS == 0) return price;
		uint256 interest = uint256(savings.accruedInterest(address(this)));
		return price + (interest * 1 ether) / totalSupply();
	}

	function totalBalance() public view returns (uint256) {
		return savings.savings(address(this)).saved + savings.accruedInterest(address(this));
	}

	function saverBalance(address account) public view returns (uint256) {
		uint256 totS = totalSupply();
		if (totS == 0) return 0;
		return (totalBalance() * balanceOf(account)) / totS;
	}

	function isUnlocked() public view returns (bool) {
		return savings.currentTicks() >= savings.savings(address(this)).ticks;
	}

	function untilUnlocked() public view returns (uint256) {
		if (isUnlocked()) return 0;
		uint256 diff = savings.savings(address(this)).ticks - savings.currentTicks();
		return (diff / savings.currentRatePPM());
	}
}
