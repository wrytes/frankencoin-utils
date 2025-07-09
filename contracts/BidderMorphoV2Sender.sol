// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho} from './morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from './morpho/IMorphoCallbacks.sol';

import {IFrankencoin} from './frankencoin/IFrankencoin.sol';
import {IMintingHubV2Bidder} from './frankencoin/IMintingHubV2Bidder.sol';
import {IPositionV2} from './frankencoin/IPositionV2.sol';

contract BidderMorphoV2Sender is IMorphoFlashLoanCallback {
	using Math for uint256;
	using SafeERC20 for IERC20;

	// immutables
	IMorpho private immutable morpho;
	ISwapRouter private immutable uniswap;
	IERC20 private immutable zchf;
	IMintingHubV2Bidder public immutable hub;

	// events
	event Executed(uint256 bid, uint256 swapIn, uint256 swapOut);

	// errors
	error NotMorpho();
	error NoCollateral();
	error NoPrice();
	error WrongEncodePathInputs();

	// ---------------------------------------------------------------------------------------

	constructor(address _morpho, address _uniswap, address _zchf, address _hubV2) {
		morpho = IMorpho(_morpho);
		uniswap = ISwapRouter(_uniswap);
		zchf = IERC20(_zchf);
		hub = IMintingHubV2Bidder(_hubV2);
	}

	// ---------------------------------------------------------------------------------------

	function encodePath(address[] memory tokens, uint24[] memory fees) public pure returns (bytes memory) {
		if (tokens.length < 2 || tokens.length - 1 != fees.length) revert WrongEncodePathInputs();

		bytes memory path = new bytes(0);
		for (uint256 i = 0; i < fees.length; i++) {
			path = abi.encodePacked(path, tokens[i], fees[i]);
		}

		return abi.encodePacked(path, tokens[tokens.length - 1]);
	}

	// ---------------------------------------------------------------------------------------
	// @dev: Path encoding should be performed off-chain.
	// The smart contract doesn't perform path validation checks,
	// as invalid paths will cause the transaction to revert anyway.

	function execute(uint32 index, uint256 amount, bytes calldata path) external {
		// get challenge data
		(, , IPositionV2 position, uint256 size) = hub.challenges(index);
		if (size == 0) revert NoCollateral();

		// get auction price
		uint256 price = hub.price(index);
		if (price == 0) revert NoPrice();

		// conditional overwrite of coll. size
		if (amount > 0 && amount < size) size = amount;

		// calc flash amount
		uint256 assets = (size * price) / 1 ether;

		// execute zchf flash
		bytes memory data = abi.encode(msg.sender, index, address(position.collateral()), size, path);
		morpho.flashLoan(address(zchf), assets, data);
	}

	// ---------------------------------------------------------------------------------------

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		// decode
		(address sender, uint32 index, address collateral, uint256 size, bytes memory path) = abi.decode(
			data,
			(address, uint32, address, uint256, bytes)
		);

		// take bid (loan --> collateral)
		hub.bid(index, size, false);

		// swap flashloan collateral --> loan
		ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
			path: path,
			recipient: address(this),
			deadline: block.timestamp + 600,
			amountIn: size,
			amountOutMinimum: assets // min. flashloan repayment
		});

		// forceApprove and execute swap
		IERC20(collateral).forceApprove(address(uniswap), size);
		uint256 amountOut = uniswap.exactInput(params);

		// transfer profit
		zchf.transfer(sender, amountOut - assets);

		// forceApprove for flashloan repayment
		zchf.forceApprove(address(morpho), assets);

		emit Executed(assets, size, amountOut);
	}
}
