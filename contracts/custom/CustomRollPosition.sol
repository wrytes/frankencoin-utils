// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho, MarketParams, Id} from '../morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/IMorphoCallbacks.sol';

import {IPositionV2} from '../frankencoin/IPositionV2.sol';
import {IOwnable} from '../utils/IOwnable.sol';

/// @title CustomRollPosition
/// @notice Rolls a Frankencoin V2 position into a leveraged Morpho position via a Morpho flash
///         loan of its collateral: the flash-loaned collateral is deposited into a Morpho market,
///         its loan token is borrowed and swapped (Uniswap V3) into the position's debt token to
///         close the position, and the collateral released by the close repays the flash loan.
///         The resulting Morpho position (collateral + debt) is opened directly under the owner's
///         address, not this contract, so the owner must authorize this contract to act on its
///         behalf on Morpho (`morpho.setAuthorization(address(this), true)`) before calling
///         execute() — and may revoke it afterwards. This contract must already own the position
///         (see claimOwnership) before execute() is called.
contract CustomRollPosition is Ownable, IMorphoFlashLoanCallback {
	using SafeERC20 for IERC20;

	IMorpho private immutable morpho;
	ISwapRouter private immutable uniswap;

	struct RollParams {
		address position;
		bytes32 market;
		address debtToken;
		bytes path; // exact-output path: loanToken -> ... -> debtToken (reversed swap direction)
		uint256 amountInMaximum; // slippage bound for the exact-output swap
		uint256 borrowAmount; // loan token amount to borrow from the morpho market
	}

	event Rolled(
		address indexed position,
		bytes32 indexed market,
		uint256 flash,
		uint256 debt,
		uint256 borrowed,
		uint256 repaid
	);

	error NotMorpho();
	error WrongEncodePathInputs();
	error WrongInputToken(address input, address needed);
	error AmountInMaximumExceedsBorrow(uint256 given, uint256 borrowed);

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
	 * @notice Roll `position` into `market` using a Morpho flash loan of its full collateral
	 *         balance. This contract must already own `position`, and the owner must already have
	 *         authorized this contract on Morpho. On success, the owner holds a Morpho position in
	 *         `market`: the closed position's collateral supplied, and `borrowAmount` of the
	 *         market's loan token borrowed, net of whatever the exact-output swap didn't spend —
	 *         that leftover is immediately repaid to reduce the new debt.
	 * @param position         Frankencoin V2 position to roll.
	 * @param market           Morpho market id to roll the collateral into. Its collateralToken
	 *                         must match the position's collateral.
	 * @param borrowAmount     Amount of the market's loan token to borrow.
	 * @param tokens           Uniswap V3 swap hops, in swap direction: loan token -> ... -> debt token.
	 * @param fees             Pool fee per hop, `tokens.length - 1` entries.
	 * @param amountInMaximum  Slippage bound for the exact-output swap: the most loan token
	 *                         allowed to be spent to acquire the debt amount. Must be <= `borrowAmount`.
	 */
	function execute(
		address position,
		bytes32 market,
		uint256 borrowAmount,
		address[] calldata tokens,
		uint24[] calldata fees,
		uint256 amountInMaximum
	) external onlyOwner {
		if (tokens.length < 2 || tokens.length - 1 != fees.length) revert WrongEncodePathInputs();
		if (amountInMaximum > borrowAmount) revert AmountInMaximumExceedsBorrow(amountInMaximum, borrowAmount);

		MarketParams memory marketParams = morpho.idToMarketParams(Id.wrap(market));
		IERC20 collateral = IERC20(address(IPositionV2(position).collateral()));
		if (marketParams.collateralToken != address(collateral))
			revert WrongInputToken(marketParams.collateralToken, address(collateral));
		if (tokens[0] != marketParams.loanToken) revert WrongInputToken(tokens[0], marketParams.loanToken);

		uint256 flashAmount = collateral.balanceOf(position);
		address debtToken = tokens[tokens.length - 1];
		bytes memory path = _encodeExactOutputPath(tokens, fees);

		bytes memory data = abi.encode(RollParams(position, market, debtToken, path, amountInMaximum, borrowAmount));
		morpho.flashLoan(address(collateral), flashAmount, data);
	}

	// ── Morpho flash-loan callback ────────────────────────────────────────────

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		RollParams memory p = abi.decode(data, (RollParams));
		MarketParams memory marketParams = morpho.idToMarketParams(Id.wrap(p.market));
		IPositionV2 position = IPositionV2(p.position);
		IERC20 collateral = IERC20(address(position.collateral()));
		IERC20 debtToken = IERC20(p.debtToken);
		IERC20 loanToken = IERC20(marketParams.loanToken);

		// deposit the flash-loaned collateral into the morpho market, on behalf of the owner
		collateral.forceApprove(address(morpho), assets);
		morpho.supplyCollateral(marketParams, assets, owner(), new bytes(0));

		// borrow the market's loan token on behalf of the owner (requires prior setAuthorization),
		// received here to fund the swap below
		morpho.borrow(marketParams, p.borrowAmount, 0, owner(), address(this));

		// debt: total minted minus the reserve contribution ppm, which is what needs to be
		// held by this contract before adjust() burns `minted` via the position's reserve.
		uint256 minted = position.minted();
		uint256 debt = (minted * (1_000_000 - uint256(position.reserveContribution()))) / 1_000_000;

		loanToken.forceApprove(address(uniswap), p.amountInMaximum);
		uniswap.exactOutput(
			ISwapRouter.ExactOutputParams({
				path: p.path,
				recipient: address(this),
				deadline: block.timestamp + 300,
				amountOut: debt,
				amountInMaximum: p.amountInMaximum
			})
		);

		// repay whatever loan token the exact-output swap didn't spend, reducing the owner's new morpho debt
		uint256 repaid = loanToken.balanceOf(address(this));
		if (repaid > 0) {
			loanToken.forceApprove(address(morpho), repaid);
			morpho.repay(marketParams, repaid, 0, owner(), new bytes(0));
		}

		// repay the position's debt; releases its full collateral balance to this contract (the owner)
		debtToken.forceApprove(address(position), debt);
		position.adjust(0, 0, position.price());

		// repay the flash loan using the collateral released by the position
		collateral.forceApprove(address(morpho), assets);

		emit Rolled(p.position, p.market, assets, debt, p.borrowAmount, repaid);
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
