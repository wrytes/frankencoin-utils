// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ISavings} from '../frankencoin/ISavings.sol';

interface ISavingsToken is IERC20 {
	// View functions
	function zchf() external view returns (IERC20);

	function savings() external view returns (ISavings);

	function totalClaimed() external view returns (uint256);

	function convertToAsset() external view returns (uint256);

	function totalBalance() external view returns (uint256);

	function saverBalance(address account) external view returns (uint256);

	function isUnlocked() external view returns (bool);

	function untilUnlocked() external view returns (uint256);

	// State-changing functions
	function save(uint256 amount) external returns (uint256);

	function saveTo(address account, uint256 amount) external returns (uint256);

	function withdraw(uint256 amount) external returns (uint256);

	function withdrawTo(address target, uint256 amount) external returns (uint256);

	// Events
	event Saved(address indexed saver, uint256 amountIn, uint256 sharesMinted, uint256 price);
	event Withdrawn(address indexed saver, uint256 sharesBurned, uint256 amountOut, uint256 price);
}
