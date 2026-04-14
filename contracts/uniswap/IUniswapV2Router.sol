// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUniswapV2Router {
	// Exact input swaps
	function swapExactTokensForTokens(
		uint amountIn,
		uint amountOutMin,
		address[] calldata path,
		address to,
		uint deadline
	) external returns (uint[] memory amounts);

	// Exact output swaps
	function swapTokensForExactTokens(
		uint amountOut,
		uint amountInMax,
		address[] calldata path,
		address to,
		uint deadline
	) external returns (uint[] memory amounts);
}
