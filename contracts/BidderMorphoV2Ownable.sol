// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Ownable, Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';

import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho} from './morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from './morpho/IMorphoCallbacks.sol';

import {IFrankencoin} from './frankencoin/IFrankencoin.sol';
import {IMintingHubV2Bidder} from './frankencoin/IMintingHubV2Bidder.sol';
import {IPositionV2} from './frankencoin/IPositionV2.sol';

/// @title BidderMorphoV2Ownable
/// @notice Executes bids on MintingHub V2 using Morpho flash loans and Uniswap V3 swaps.
/// @dev This contract leverages Morpho flash loans to acquire assets for bidding,
/// performs swaps via Uniswap V3 to repay the loan, and captures profit from the price spread.
/// Ownable2Step is used for profit distribution.
contract BidderMorphoV2Ownable is Ownable2Step, IMorphoFlashLoanCallback {
	using Math for uint256;
	using SafeERC20 for IERC20;

	// immutables
	IMorpho private immutable morpho;
	ISwapRouter private immutable uniswap;
	IERC20 private immutable zchf;
	IMintingHubV2Bidder private immutable hub;

	// variables
	uint32 public feePPM;

	// private
	address private _sender;
	uint32 private _index;
	address private _collateral;
	uint256 private _size;
	bytes private _path;

	// events
	event SetFee(uint32 feePPM);
	event Executed(address indexed collateral, uint256 flashBid, uint256 swapIn, uint256 swapOut);

	// errors
	error NotMorpho();
	error NoCollateral();
	error NoPrice();
	error WrongEncodePathInputs();

	// ---------------------------------------------------------------------------------------

	constructor(
		address _morpho,
		address _uniswap,
		address _zchf,
		address _hubV2,
		address _owner,
		uint32 _feePPM
	) Ownable(_owner) {
		morpho = IMorpho(_morpho);
		uniswap = ISwapRouter(_uniswap);
		zchf = IERC20(_zchf);
		hub = IMintingHubV2Bidder(_hubV2);
		_setFeePPM(_feePPM);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Encodes a Uniswap V3 multihop path from token and fee arrays.
	/// @dev Produces a bytes-encoded swap path compatible with Uniswap V3 routers and pools.
	/// @param tokens An array of token addresses representing the swap route (must be length = fees.length + 1).
	/// @param fees An array of pool fees (in hundredths of a bip, e.g., 500 = 0.05%) between each token pair.
	/// @return path The ABI-encoded swap path (token0 + fee0 + token1 + fee1 + ... + tokenN).
	function encodePath(address[] memory tokens, uint24[] memory fees) public pure returns (bytes memory) {
		if (tokens.length < 2 || tokens.length - 1 != fees.length) revert WrongEncodePathInputs();

		bytes memory path = new bytes(0);
		for (uint256 i = 0; i < fees.length; i++) {
			path = abi.encodePacked(path, tokens[i], fees[i]);
		}

		return abi.encodePacked(path, tokens[tokens.length - 1]);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Sets the fee in parts per million (PPM).
	/// @dev Calls the internal _setFeePPM function. Only callable by the contract owner.
	/// @param _fee The new fee to set, in PPM (1,000,000 PPM = 100%).
	function setFeePPM(uint32 _fee) external onlyOwner {
		_setFeePPM(_fee);
	}

	/// @notice Internal function to set the fee, capped at 1,000,000 PPM (100%).
	/// @dev Emits a {SetFee} event with the final fee value.
	/// @param _fee The proposed fee value in PPM.
	function _setFeePPM(uint32 _fee) internal {
		if (_fee > 1_000_000) feePPM = 1_000_000;
		else feePPM = _fee;
		emit SetFee(feePPM);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Executes a challenge using raw token/fee arrays by encoding the path internally.
	/// @dev Encodes the swap path from `tokens` and `fees`, then calls the internal `_execute`.
	/// @param index The challenge index to execute.
	/// @param amount The collateral amount to take (0 for max).
	/// @param tokens An array of token addresses for the swap path.
	/// @param fees An array of Uniswap pool fees between each hop.
	function execute(uint32 index, uint256 amount, address[] memory tokens, uint24[] memory fees) external {
		_path = encodePath(tokens, fees);
		_execute(index, amount);
	}

	/// @notice Executes a challenge using a pre-encoded swap path.
	/// @dev Assumes the caller provides a correctly encoded Uniswap V3 path.
	/// @param index The challenge index to execute.
	/// @param amount The collateral amount to take (0 for max).
	/// @param path A bytes-encoded Uniswap V3 swap path.
	function execute(uint32 index, uint256 amount, bytes memory path) external {
		_path = path;
		_execute(index, amount);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Executes a challenge by initiating a flash loan and preparing internal state.
	/// @dev Retrieves challenge and auction data from the hub, calculates required flash loan size,
	/// and stores necessary parameters in contract storage for use during the flash loan callback.
	/// The flash loan is executed through Morpho and must be repaid within the callback.
	/// @param index The index of the challenge to execute.
	/// @param amount The collateral amount to claim; if 0 or greater than the total, full size is used.
	function _execute(uint32 index, uint256 amount) internal {
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

		// store data
		_sender = msg.sender;
		_index = index;
		_collateral = address(position.collateral());
		_size = size;

		// flashLoan callback uses internal state; no data encoding needed
		bytes memory emptyData = new bytes(0);

		// execute zchf flash loan action
		morpho.flashLoan(address(zchf), assets, emptyData);

		// transfer profits with owner and sender
		uint256 balance = zchf.balanceOf(address(this));
		uint256 split = (balance * feePPM) / 1_000_000;
		zchf.transfer(owner(), split);
		zchf.transfer(_sender, balance - split);

		// clear data
		delete _sender;
		delete _index;
		delete _collateral;
		delete _size;
		delete _path;
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Callback function executed after receiving a flash loan from Morpho.
	/// @dev This function is called by Morpho upon flash loan execution.
	/// The logic inside should use the borrowed `assets` and ensure repayment within the same transaction.
	/// @param assets The amount of tokens received in the flash loan.
	/// param data Ignored calldata (unused); parameters are handled via internal state.
	function onMorphoFlashLoan(uint256 assets, bytes calldata /* data */) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		// take bid (loan --> collateral)
		hub.bid(_index, _size, false);

		// swap flashloan collateral --> loan
		ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
			path: _path,
			recipient: address(this),
			deadline: block.timestamp + 600,
			amountIn: _size,
			amountOutMinimum: assets // min. flashloan repayment
		});

		// forceApprove and execute swap
		IERC20(_collateral).forceApprove(address(uniswap), _size);
		uint256 amountOut = uniswap.exactInput(params);

		// forceApprove for flashloan repayment
		zchf.forceApprove(address(morpho), assets);

		// emits event
		emit Executed(_collateral, assets, _size, amountOut);
	}
}
