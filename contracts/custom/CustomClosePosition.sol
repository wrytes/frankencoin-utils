// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho} from '../morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/IMorphoCallbacks.sol';

import {IPositionV2} from '../frankencoin/IPositionV2.sol';
import {IOwnable} from '../utils/IOwnable.sol';

/// @title CustomClosePosition
/// @notice Closes a Frankencoin V2 position via a Morpho flash loan of its collateral and a
///         Uniswap V3 swap into the position's debt token. This contract must already own the
///         position (see claimOwnership) before execute() is called.
contract CustomClosePosition is Ownable, IMorphoFlashLoanCallback {
	using SafeERC20 for IERC20;

	IMorpho private immutable morpho;
	ISwapRouter private immutable uniswap;

	struct CloseParams {
		address position;
		address debtToken;
		bytes path; // exact-output path: debtToken -> ... -> collateral (reversed swap direction)
		uint256 amountInMaximum; // slippage bound for the exact-output swap
	}

	event Closed(address indexed position, uint256 flash, uint256 debt, uint256 equity);

	error NotMorpho();
	error WrongEncodePathInputs();
	error WrongInputToken(address input, address needed);
	error AmountInMaximumExceedsFlash(uint256 given, uint256 flash);

	constructor(address _morpho, address _uniswap, address _owner) Ownable(_owner) {
		morpho = IMorpho(_morpho);
		uniswap = ISwapRouter(_uniswap);
	}

	// ── Basic ─────────────────────────────────────────────────────────────────

	/// @notice Send this contract's full balance of `token` to the owner.
	function claimToken(address token) external onlyOwner {
		IERC20(token).safeTransfer(owner(), IERC20(token).balanceOf(address(this)));
	}

	/// @notice Reclaim ownership of `target` (e.g. a position) to the owner.
	function claimOwnership(address target) external onlyOwner {
		IOwnable(target).transferOwnership(owner());
	}

	// ── Core ──────────────────────────────────────────────────────────────────

	/**
	 * @notice Close `position` using a Morpho flash loan of its full collateral balance.
	 *         This contract must already own `position`.
	 * @param position         Frankencoin V2 position to close.
	 * @param tokens           Uniswap V3 swap hops, in swap direction: collateral -> ... -> debt token.
	 * @param fees             Pool fee per hop, `tokens.length - 1` entries.
	 * @param amountInMaximum  Slippage bound for the exact-output swap: the most collateral
	 *                         allowed to be spent to acquire the debt amount. Must be <= the
	 *                         position's collateral balance (the flash-loaned amount).
	 */
	function execute(
		address position,
		address[] calldata tokens,
		uint24[] calldata fees,
		uint256 amountInMaximum
	) external onlyOwner {
		if (tokens.length < 2 || tokens.length - 1 != fees.length) revert WrongEncodePathInputs();

		IERC20 collateral = IERC20(address(IPositionV2(position).collateral()));
		if (tokens[0] != address(collateral)) revert WrongInputToken(tokens[0], address(collateral));

		uint256 flashAmount = collateral.balanceOf(position);
		if (amountInMaximum > flashAmount) revert AmountInMaximumExceedsFlash(amountInMaximum, flashAmount);

		address debtToken = tokens[tokens.length - 1];
		bytes memory path = _encodeExactOutputPath(tokens, fees);

		bytes memory data = abi.encode(CloseParams(position, debtToken, path, amountInMaximum));
		morpho.flashLoan(address(collateral), flashAmount, data);
	}

	// ── Morpho flash-loan callback ────────────────────────────────────────────

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		CloseParams memory p = abi.decode(data, (CloseParams));
		IPositionV2 position = IPositionV2(p.position);
		IERC20 collateral = IERC20(address(position.collateral()));
		IERC20 debtToken = IERC20(p.debtToken);

		// debt: total minted minus the reserve contribution ppm, which is what needs to be
		// held by this contract before adjust() burns `minted` via the position's reserve.
		uint256 minted = position.minted();
		uint256 debt = (minted * (1_000_000 - uint256(position.reserveContribution()))) / 1_000_000;

		collateral.forceApprove(address(uniswap), p.amountInMaximum);
		uniswap.exactOutput(
			ISwapRouter.ExactOutputParams({
				path: p.path,
				recipient: address(this),
				deadline: block.timestamp + 300,
				amountOut: debt,
				amountInMaximum: p.amountInMaximum
			})
		);

		debtToken.forceApprove(address(position), debt);
		position.adjust(0, 0, position.price());

		// repay the flash loan, remaining collateral is equity
		collateral.forceApprove(address(morpho), assets);
		uint256 equity = collateral.balanceOf(address(this)) - assets;
		if (equity > 0) collateral.safeTransfer(owner(), equity);

		emit Closed(p.position, assets, debt, equity);
	}

	// ── Internal helpers ──────────────────────────────────────────────────────

	/// @dev Encode `tokens`/`fees` (given in swap direction) into a Uniswap V3 exact-output
	///      path, which must be reversed: last token first, first token last.
	function _encodeExactOutputPath(
		address[] calldata tokens,
		uint24[] calldata fees
	) internal pure returns (bytes memory path) {
		path = abi.encodePacked(tokens[tokens.length - 1]);
		for (uint256 i = tokens.length - 1; i > 0; i--) {
			path = abi.encodePacked(path, fees[i - 1], tokens[i - 1]);
		}
	}
}
