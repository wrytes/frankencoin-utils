// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {IFrankencoinFlashLoanCallback} from './IFrankencoinFlashLoanCallback.sol';
import {IFlashloanFrankencoin} from './IFlashloanFrankencoin.sol';

contract MockFlashloanRecipient is IFrankencoinFlashLoanCallback {
	IERC20 public immutable zchf;
	IFlashloanFrankencoin public immutable flashloan;

	event FlashloanReceived(address indexed caller, uint256 amount, bytes data);

	constructor(address _zchf, address _flashloan) {
		zchf = IERC20(_zchf);
		flashloan = IFlashloanFrankencoin(_flashloan);
	}

	function trigger(address source, uint256 amount, bytes calldata data) external {
		flashloan.flashloan(source, amount, data);
	}

	function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external override {
		require(msg.sender == address(flashloan), 'unauthorized');
		emit FlashloanReceived(msg.sender, amount, data);
		zchf.approve(msg.sender, amount);
	}
}
