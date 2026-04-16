// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {IFrankencoinFlashloan} from './IFrankencoinFlashloan.sol';

interface IFlashloanFrankencoin {
	function flashloan(address source, uint256 amount, bytes calldata data) external;
}

contract MockFlashloanRecipient is IFrankencoinFlashloan {
	IERC20 public immutable zchf;
	address public flashloan;

	event FlashloanReceived(address indexed caller, uint256 amount, bytes data);

	constructor(address _zchf) {
		zchf = IERC20(_zchf);
	}

	function trigger(address _flashloan, address source, uint256 amount, bytes calldata data) external {
		flashloan = _flashloan;
		IFlashloanFrankencoin(_flashloan).flashloan(source, amount, data);
	}

	function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external override {
		require(msg.sender == flashloan, 'unauthorized');
		emit FlashloanReceived(msg.sender, amount, data);
		zchf.approve(msg.sender, amount);
	}
}
