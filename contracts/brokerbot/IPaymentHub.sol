// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Permit} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol';
import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';
import {IBrokerbot} from './IBrokerbot.sol';

interface IPaymentHub {
	error Address_NotTransferNorContract(address target);
	error InsufficientPayment(uint256 required, uint256 provided);
	error PaymentHub_InvalidSender(address sender);
	error PaymentHub_SwapError(uint256 amountBase, uint256 swappedAmount);
	error PaymentHub_TransferFailed();
	error SafeERC20FailedOperation(address token);
	error SellWithPermitDisabled();

	struct PermitInfo {
		uint256 exFee;
		uint256 deadline;
		uint8 v;
		bytes32 r;
		bytes32 s;
	}

	function VERSION() external view returns (uint256);

	function approveERC20(address erc20In) external;

	function hasSettingKeepEther(IBrokerbot brokerbot) external pure returns (bool);

	function getPriceERC20(uint256 amount, bytes calldata path, bool exactOutput) external returns (uint256);

	function getPriceInERC20(uint256 amountInBase, bytes calldata path) external returns (uint256);

	function multiPay(IERC20 token, address[] calldata recipients, uint256[] calldata amounts) external;

	function multiPayAndNotify(
		IERC20 token,
		IBrokerbot[] calldata brokerbots,
		uint256[] calldata amounts,
		bytes calldata ref
	) external;

	// Buy with ZCHF (base token) directly
	function payAndNotify(
		IBrokerbot brokerbot,
		uint256 amountInBase,
		bytes calldata ref
	) external returns (uint256 shares);

	// Buy with any ERC20, swapped to base via Uniswap
	function payAndNotify(
		IERC20 token,
		IBrokerbot brokerbot,
		uint256 amount,
		bytes calldata ref
	) external returns (uint256 shares);

	function payFromERC20(
		uint256 amountOut,
		uint256 amountInMaximum,
		address erc20In,
		bytes calldata path,
		address recipient
	) external returns (uint256 amountIn);

	function payFromERC20AndNotify(
		IBrokerbot brokerbot,
		uint256 amountBase,
		address erc20,
		uint256 amountInMaximum,
		bytes calldata path,
		bytes calldata ref
	) external returns (uint256 amountIn, uint256 amountOut);

	function payFromEther(
		address recipient,
		uint256 amountInBase,
		bytes calldata path
	) external payable returns (uint256 amountIn);

	function payFromEtherAndNotify(
		IBrokerbot brokerbot,
		uint256 amountBase,
		bytes calldata ref,
		bytes calldata path
	) external payable returns (uint256 priceInEther, uint256 sharesOut);

	function sellSharesAndSwap(
		IBrokerbot brokerbot,
		IERC20 shares,
		uint256 amountToSell,
		bytes calldata ref,
		ISwapRouter.ExactInputParams calldata params,
		bool unwrapWeth
	) external returns (uint256);

	function sellSharesWithPermit(
		IBrokerbot brokerbot,
		IERC20Permit shares,
		address seller,
		address recipient,
		uint256 amountToSell,
		bytes calldata ref,
		PermitInfo calldata permitInfo
	) external returns (uint256);

	function sellSharesWithPermitAndSwap(
		IBrokerbot brokerbot,
		IERC20Permit shares,
		address seller,
		uint256 amountToSell,
		bytes calldata ref,
		PermitInfo calldata permitInfo,
		ISwapRouter.ExactInputParams calldata params,
		bool unwrapWeth
	) external returns (uint256);

	function transferEther(address to) external payable;

	receive() external payable;
}
