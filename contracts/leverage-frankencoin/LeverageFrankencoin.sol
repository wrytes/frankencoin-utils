// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IMorpho} from '../morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/IMorphoCallbacks.sol';

import {IPositionV2} from '../frankencoin/IPositionV2.sol';
import {IMintingHubV2} from '../frankencoin/IMintingHubV2.sol';

/**
 * @title LeverageFrankencoin
 * @notice Leverage manager for a Frankencoin V2 position.
 *
 * Borrow mechanism : Frankencoin PositionV2  — adjust / mint / repay
 * Flash loans      : Morpho                  — always in the collateral token
 * Swap aggregator  : 1inch                   — raw calldata from off-chain API
 *
 * ── Price rules ──────────────────────────────────────────────────────────────
 *  LTV in Frankencoin = liqPrice / marketPrice  (NOT loan value / collateral value)
 *  Decreasing liqPrice : always allowed, immediate, no cooldown.
 *  Increasing liqPrice : triggers a 3-day cooldown; minting is guarded during
 *                        that window.  Pass newPrice = 0 to keep the current price.
 *
 * All operations that touch the position accept a `newPrice` parameter and use
 * position.adjust() atomically so collateral, debt and price are updated together.
 *
 * Operations
 * ----------
 * increase          – flash-loan collToken, add to position, mint loanToken, swap loan→coll
 * decrease          – flash-loan collToken, swap coll→loan, repay + withdraw atomically
 * close             – close position, equity returned in loanToken
 * closeInCollateral – close position, equity returned in collToken (exact-output swap)
 * roll              – migrate to a fresh clone via flash loan, no roller contract
 */
contract LeverageFrankencoin is Ownable, IMorphoFlashLoanCallback {
	using SafeERC20 for IERC20;

	// ── Immutables ────────────────────────────────────────────────────────────

	IMorpho private immutable morpho;
	IMintingHubV2 public immutable hub;
	IERC20 public immutable loanToken; // minted / repaid against the Frankencoin position (ZCHF)
	IERC20 public immutable collToken; // collateral token of the managed position
	address public immutable oneInchRouter;

	// ── Mutable state ─────────────────────────────────────────────────────────

	IPositionV2 public position; // current active Frankencoin position (updated on roll)

	// ── Opcodes ───────────────────────────────────────────────────────────────

	uint8 private constant INCREASE_LEVERAGE   = 0;
	uint8 private constant DECREASE_LEVERAGE   = 1;
	uint8 private constant ROLL_POSITION       = 2;
	uint8 private constant CLOSE_POSITION      = 3;
	uint8 private constant CLOSE_POSITION_COLL = 4;

	// ── Events ────────────────────────────────────────────────────────────────

	event CollateralIn(uint256 amount);
	event CollateralOut(uint256 amount);
	event PriceAdjusted(uint256 oldPrice, uint256 newPrice);
	/// @param opcode  0=increase · 1=decrease · 2=roll · 3=close · 4=closeInCollateral
	/// @param flash   collToken flash-loaned from Morpho
	/// @param swapIn  token amount sold in the 1inch swap
	/// @param swapOut token amount received from the 1inch swap
	event Executed(uint8 indexed opcode, uint256 flash, uint256 swapIn, uint256 swapOut);
	event Rolled(address indexed oldPosition, address indexed newPosition);

	// ── Errors ────────────────────────────────────────────────────────────────

	error NotMorpho();
	error InvalidOpcode(uint8 given);
	error SwapFailed();
	error InsufficientOutput(uint256 got, uint256 min);

	// ── Constructor ───────────────────────────────────────────────────────────

	/**
	 * @param _morpho        Morpho core contract (flash loans).
	 * @param _hub           Frankencoin MintingHubV2 (cloning on roll).
	 * @param _position      Existing PositionV2 this contract manages.
	 * @param _oneInchRouter 1inch AggregationRouter.
	 * @param _owner         Initial owner.
	 */
	constructor(
		address _morpho,
		address _hub,
		address _position,
		address _oneInchRouter,
		address _owner
	) Ownable(_owner) {
		morpho = IMorpho(_morpho);
		hub = IMintingHubV2(_hub);
		position = IPositionV2(_position);
		loanToken = IERC20(address(IMintingHubV2(_hub).zchf()));
		collToken = IERC20(address(IPositionV2(_position).collateral()));
		oneInchRouter = _oneInchRouter;
	}

	// ── Direct position management ────────────────────────────────────────────

	/// @notice Pull collateral from caller and add it to the position.
	function depositCollateral(uint256 amount) external onlyOwner {
		collToken.safeTransferFrom(msg.sender, address(this), amount);
		collToken.forceApprove(address(position), amount);
		position.adjust(position.minted(), _posColl() + amount, position.price());
		emit CollateralIn(amount);
	}

	/// @notice Withdraw collateral from the position to the caller.
	function withdrawCollateral(uint256 amount) external onlyOwner {
		position.withdrawCollateral(msg.sender, amount);
		emit CollateralOut(amount);
	}

	/// @notice Mint loanToken from the position to the caller.
	function mint(uint256 amount) external onlyOwner {
		position.mint(msg.sender, amount);
	}

	/// @notice Pull loanToken from caller and repay position debt.
	function repay(uint256 amount) external onlyOwner {
		loanToken.safeTransferFrom(msg.sender, address(this), amount);
		loanToken.forceApprove(address(position), amount);
		position.repay(amount);
	}

	/**
	 * @notice Change only the liquidation price without touching collateral or debt.
	 *         Decreasing: immediate, no cooldown.
	 *         Increasing: triggers a 3-day cooldown; minting is guarded during that window.
	 */
	function adjustPrice(uint256 newPrice) external onlyOwner {
		uint256 oldPrice = position.price();
		position.adjustPrice(newPrice);
		emit PriceAdjusted(oldPrice, newPrice);
	}

	/// @notice Recover any ERC-20 token accidentally sent to this contract.
	function recover(address token, address target, uint256 amount) external onlyOwner {
		IERC20(token).safeTransfer(target, amount);
	}

	// ── Leverage operations ───────────────────────────────────────────────────

	/**
	 * @notice Increase leverage.
	 *
	 * Flow (inside flash-loan callback):
	 *   1. adjust(minted + mintAmount, posColl + totalColl, newPrice)
	 *      Adds all collToken (flash-loaned + walletColl) and mints loanToken atomically.
	 *   2. All loanToken in contract (minted + walletLoan) swapped → collToken via 1inch.
	 *   3. collToken returned to Morpho (minCollOut must be ≥ flashAmount).
	 *
	 * Note: if newPrice > current price a 3-day cooldown starts and minting will be guarded.
	 *       The transaction will revert if the position blocks minting during cooldown.
	 *
	 * @param walletLoan  loanToken from caller's wallet (sold alongside minted loanToken).
	 * @param walletColl  collToken from caller's wallet (equity contribution).
	 * @param flashAmount collToken to flash-loan; determines the leverage multiplier.
	 * @param mintAmount  Additional loanToken to mint from the position.
	 * @param newPrice    New liquidation price. 0 = keep current.
	 * @param minCollOut  Minimum collToken from the swap (must be ≥ flashAmount).
	 * @param swapData    1inch calldata: loanToken → collToken, recipient = address(this).
	 */
	function increase(
		uint256 walletLoan,
		uint256 walletColl,
		uint256 flashAmount,
		uint256 mintAmount,
		uint256 newPrice,
		uint256 minCollOut,
		bytes calldata swapData
	) external onlyOwner {
		if (walletLoan > 0) loanToken.safeTransferFrom(msg.sender, address(this), walletLoan);
		if (walletColl > 0) collToken.safeTransferFrom(msg.sender, address(this), walletColl);
		bytes memory data = abi.encode(INCREASE_LEVERAGE, abi.encode(mintAmount, newPrice, minCollOut, swapData));
		morpho.flashLoan(address(collToken), flashAmount, data);
	}

	/**
	 * @notice Decrease leverage.
	 *
	 * Flow (inside flash-loan callback):
	 *   1. All collToken in contract (flash-loaned + walletColl) swapped → loanToken via 1inch.
	 *   2. adjust(newMinted, posColl − flashAmount, newPrice)
	 *      Repays available loanToken and withdraws flashAmount collateral atomically.
	 *   3. collToken returned to Morpho.
	 *
	 * Net effect: position has `flashAmount` less collateral, reduced debt, and optional new price.
	 * Decreasing price is always safe. Increasing price during decrease is unusual but allowed.
	 *
	 * @param walletLoan  loanToken from caller's wallet (repays more debt than the swap alone).
	 * @param walletColl  collToken from caller's wallet (sold alongside flash-loaned collToken).
	 * @param flashAmount collToken to flash-loan (withdrawn from position to repay Morpho).
	 * @param newPrice    New liquidation price. 0 = keep current.
	 * @param minLoanOut  Minimum loanToken from the collToken→loanToken swap.
	 * @param swapData    1inch calldata: collToken → loanToken, recipient = address(this).
	 */
	function decrease(
		uint256 walletLoan,
		uint256 walletColl,
		uint256 flashAmount,
		uint256 newPrice,
		uint256 minLoanOut,
		bytes calldata swapData
	) external onlyOwner {
		if (walletLoan > 0) loanToken.safeTransferFrom(msg.sender, address(this), walletLoan);
		if (walletColl > 0) collToken.safeTransferFrom(msg.sender, address(this), walletColl);
		bytes memory data = abi.encode(DECREASE_LEVERAGE, abi.encode(newPrice, minLoanOut, swapData));
		morpho.flashLoan(address(collToken), flashAmount, data);
	}

	/**
	 * @notice Close the position. Equity returned in loanToken.
	 *
	 * Flow (inside flash-loan callback):
	 *   1. All collToken in contract (flash-loaned + walletColl) swapped → loanToken via 1inch.
	 *   2. All position debt repaid (swap proceeds + walletLoan).
	 *   3. All remaining position collateral withdrawn (repays flash loan).
	 *   4. loanToken equity sent to owner.
	 *   5. collToken returned to Morpho.
	 *
	 * @param walletLoan loanToken from caller's wallet to cover any debt shortfall.
	 * @param walletColl collToken from caller's wallet sold alongside position collateral.
	 * @param minLoanOut Minimum loanToken from the swap.
	 * @param swapData   1inch calldata: collToken → loanToken, recipient = address(this).
	 */
	function close(
		uint256 walletLoan,
		uint256 walletColl,
		uint256 minLoanOut,
		bytes calldata swapData
	) external onlyOwner {
		if (walletLoan > 0) loanToken.safeTransferFrom(msg.sender, address(this), walletLoan);
		if (walletColl > 0) collToken.safeTransferFrom(msg.sender, address(this), walletColl);
		bytes memory data = abi.encode(CLOSE_POSITION, abi.encode(minLoanOut, swapData));
		morpho.flashLoan(address(collToken), _posColl(), data);
	}

	/**
	 * @notice Close the position. Equity returned in collToken.
	 *
	 * Use an exact-output 1inch swap: sell the minimum collToken needed to receive
	 * exactly `debt − walletLoan` loanToken. Unsold collateral becomes the equity.
	 *
	 * Flow (inside flash-loan callback):
	 *   1. Exact-output swap: minimum collToken → just enough loanToken to cover debt.
	 *   2. All position debt repaid (swap proceeds + walletLoan).
	 *   3. All remaining position collateral withdrawn (repays flash loan).
	 *   4. collToken equity (withdrawn − swap cost) sent to owner.
	 *   5. collToken returned to Morpho.
	 *
	 * @param walletLoan  loanToken from caller's wallet (reduces how much collateral is sold).
	 * @param walletColl  collToken from caller's wallet added to equity.
	 * @param minLoanOut  Minimum loanToken from the swap (must be ≥ debt − walletLoan).
	 * @param swapData    1inch calldata: collToken → loanToken exact-output, recipient = address(this).
	 */
	function closeInCollateral(
		uint256 walletLoan,
		uint256 walletColl,
		uint256 minLoanOut,
		bytes calldata swapData
	) external onlyOwner {
		if (walletLoan > 0) loanToken.safeTransferFrom(msg.sender, address(this), walletLoan);
		if (walletColl > 0) collToken.safeTransferFrom(msg.sender, address(this), walletColl);
		bytes memory data = abi.encode(CLOSE_POSITION_COLL, abi.encode(minLoanOut, swapData));
		morpho.flashLoan(address(collToken), _posColl(), data);
	}

	/**
	 * @notice Roll the current position into a fresh clone of `parent` via flash loan.
	 *
	 * Flow (inside flash-loan callback):
	 *   1. hub.clone(parent, assets, initialMint, newExpiration) — funds new clone with
	 *      flash-loaned collateral; receives initialMint loanToken.
	 *   2. `position` updated to new clone.
	 *   3. Old position debt repaid with available loanToken (minted + walletLoan).
	 *   4. All collateral withdrawn from now-empty old position.
	 *   5. collToken returned to Morpho.
	 *
	 * Requirement: `initialMint + walletLoan` ≥ old position's minted debt.
	 * Price: inherited from `parent`. Use adjustPrice() afterwards if needed.
	 *
	 * @param parent        Parent position to clone (sets mint cap, reserve, challenge period).
	 * @param initialMint   loanToken to mint in the new clone.
	 * @param walletLoan    Extra loanToken from caller's wallet for repayment shortfall.
	 * @param newExpiration Expiration timestamp for the new clone.
	 */
	function roll(
		address parent,
		uint256 initialMint,
		uint256 walletLoan,
		uint40 newExpiration
	) external onlyOwner {
		if (walletLoan > 0) loanToken.safeTransferFrom(msg.sender, address(this), walletLoan);
		bytes memory data = abi.encode(ROLL_POSITION, abi.encode(parent, initialMint, newExpiration));
		morpho.flashLoan(address(collToken), _posColl(), data);
	}

	// ── Morpho flash-loan callback ────────────────────────────────────────────

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		(uint8 opcode, bytes memory payload) = abi.decode(data, (uint8, bytes));

		// ── INCREASE ─────────────────────────────────────────────────────────
		if (opcode == INCREASE_LEVERAGE) {
			(uint256 mintAmount, uint256 newPrice, uint256 minCollOut, bytes memory swapData) = abi.decode(
				payload,
				(uint256, uint256, uint256, bytes)
			);

			// Atomic: add all collToken (flash-loaned + walletColl) + mint + optional price change
			uint256 totalColl = collToken.balanceOf(address(this));
			collToken.forceApprove(address(position), totalColl);
			_adjustPosition(position.minted() + mintAmount, _posColl() + totalColl, newPrice);
			// adjust() mints `mintAmount` loanToken to address(this) and pulls `totalColl`

			// Swap all loanToken in contract (minted + walletLoan) → collToken
			uint256 swapIn = loanToken.balanceOf(address(this));
			uint256 swapOut = _swap1inch(address(loanToken), address(collToken), swapIn, minCollOut, swapData);

			collToken.forceApprove(address(morpho), assets);
			emit Executed(INCREASE_LEVERAGE, assets, swapIn, swapOut);

		// ── DECREASE ─────────────────────────────────────────────────────────
		} else if (opcode == DECREASE_LEVERAGE) {
			(uint256 newPrice, uint256 minLoanOut, bytes memory swapData) = abi.decode(
				payload,
				(uint256, uint256, bytes)
			);

			// Swap all collToken in contract (flash-loaned + walletColl) → loanToken
			uint256 swapIn = collToken.balanceOf(address(this));
			uint256 swapOut = _swap1inch(address(collToken), address(loanToken), swapIn, minLoanOut, swapData);

			// Atomic: repay available loanToken (swapped + walletLoan) + withdraw flashAmount coll + optional price
			uint256 available = loanToken.balanceOf(address(this));
			uint256 debt = position.minted();
			uint256 newMinted = available >= debt ? 0 : debt - available;
			uint256 repayAmount = debt - newMinted;
			loanToken.forceApprove(address(position), repayAmount);
			_adjustPosition(newMinted, _posColl() - assets, newPrice);
			// adjust() burns `repayAmount` loanToken from address(this) and sends `assets` collToken here

			collToken.forceApprove(address(morpho), assets);
			emit Executed(DECREASE_LEVERAGE, assets, swapIn, swapOut);

		// ── CLOSE (equity in loanToken) ───────────────────────────────────────
		} else if (opcode == CLOSE_POSITION) {
			(uint256 minLoanOut, bytes memory swapData) = abi.decode(payload, (uint256, bytes));

			// Swap all collToken in contract (flash-loaned + walletColl) → loanToken
			uint256 swapIn = collToken.balanceOf(address(this));
			uint256 swapOut = _swap1inch(address(collToken), address(loanToken), swapIn, minLoanOut, swapData);

			// Repay all debt + withdraw all position collateral atomically
			uint256 debt = position.minted();
			loanToken.forceApprove(address(position), debt);
			_adjustPosition(0, 0, position.price()); // price kept; full close

			// Return loanToken equity to owner
			uint256 loanEquity = loanToken.balanceOf(address(this));
			if (loanEquity > 0) loanToken.safeTransfer(owner(), loanEquity);

			collToken.forceApprove(address(morpho), assets);
			emit Executed(CLOSE_POSITION, assets, swapIn, swapOut);

		// ── CLOSE IN COLLATERAL (equity in collToken) ─────────────────────────
		} else if (opcode == CLOSE_POSITION_COLL) {
			(uint256 minLoanOut, bytes memory swapData) = abi.decode(payload, (uint256, bytes));

			// Exact-output swap: sell minimum collToken to cover debt − walletLoan.
			// Approve full collToken balance so 1inch takes only what it needs.
			uint256 collBefore = collToken.balanceOf(address(this));
			uint256 loanBefore = loanToken.balanceOf(address(this));
			collToken.forceApprove(oneInchRouter, collBefore);
			(bool success, ) = oneInchRouter.call(swapData);
			if (!success) revert SwapFailed();
			uint256 swapIn  = collBefore - collToken.balanceOf(address(this));
			uint256 swapOut = loanToken.balanceOf(address(this)) - loanBefore;
			if (swapOut < minLoanOut) revert InsufficientOutput(swapOut, minLoanOut);

			// Repay all debt + withdraw all position collateral atomically
			uint256 debt = position.minted();
			loanToken.forceApprove(address(position), debt);
			_adjustPosition(0, 0, position.price()); // price kept; full close

			// Repay flash loan first, then send remaining collToken equity to owner
			collToken.forceApprove(address(morpho), assets);
			uint256 collEquity = collToken.balanceOf(address(this)) - assets;
			if (collEquity > 0) collToken.safeTransfer(owner(), collEquity);

			// Return any unused walletLoan surplus to owner
			uint256 loanSurplus = loanToken.balanceOf(address(this));
			if (loanSurplus > 0) loanToken.safeTransfer(owner(), loanSurplus);

			emit Executed(CLOSE_POSITION_COLL, assets, swapIn, swapOut);

		// ── ROLL ──────────────────────────────────────────────────────────────
		} else if (opcode == ROLL_POSITION) {
			(address parent, uint256 initialMint, uint40 newExpiration) = abi.decode(
				payload,
				(address, uint256, uint40)
			);

			IPositionV2 oldPos = position;
			uint256 oldDebt = oldPos.minted();

			// Clone parent with flash-loaned collateral; receives initialMint loanToken
			collToken.forceApprove(address(hub), assets);
			address newPos = hub.clone(parent, assets, initialMint, newExpiration);
			position = IPositionV2(newPos);

			// Repay old position debt (minted loanToken + walletLoan)
			uint256 available = loanToken.balanceOf(address(this));
			uint256 repayAmount = oldDebt < available ? oldDebt : available;
			loanToken.forceApprove(address(oldPos), repayAmount);
			oldPos.adjust(oldDebt - repayAmount, _posCollOf(oldPos), oldPos.price());

			// Withdraw all collateral from now-debt-free old position
			uint256 oldColl = _posCollOf(oldPos);
			if (oldColl > 0) oldPos.withdrawCollateral(address(this), oldColl);

			collToken.forceApprove(address(morpho), assets);
			emit Rolled(address(oldPos), newPos);
			emit Executed(ROLL_POSITION, assets, initialMint, oldDebt);

		} else revert InvalidOpcode(opcode);
	}

	// ── Internal helpers ──────────────────────────────────────────────────────

	/// @dev Collateral balance held by the current position.
	function _posColl() internal view returns (uint256) {
		return collToken.balanceOf(address(position));
	}

	/// @dev Collateral balance held by any given position.
	function _posCollOf(IPositionV2 pos) internal view returns (uint256) {
		return collToken.balanceOf(address(pos));
	}

	/**
	 * @dev Call position.adjust() with a resolved price.
	 *      newPrice = 0 keeps the current price.
	 *      Approvals for collateral and loanToken must be set by the caller before this.
	 */
	function _adjustPosition(uint256 newMinted, uint256 newCollateral, uint256 newPrice) internal {
		uint256 price = newPrice > 0 ? newPrice : position.price();
		position.adjust(newMinted, newCollateral, price);
	}

	/**
	 * @dev Execute a 1inch swap using pre-encoded calldata from the 1inch API.
	 *      Approves `amountIn` of `tokenIn`, executes the call, and measures
	 *      output via balance delta on `tokenOut`.
	 *
	 * @param tokenIn      Token to sell.
	 * @param tokenOut     Token to buy.
	 * @param amountIn     Amount of `tokenIn` to approve and sell.
	 * @param minAmountOut Minimum acceptable output.
	 * @param swapData     Raw calldata from 1inch API (recipient = address(this)).
	 * @return amountOut   Actual amount of `tokenOut` received.
	 */
	function _swap1inch(
		address tokenIn,
		address tokenOut,
		uint256 amountIn,
		uint256 minAmountOut,
		bytes memory swapData
	) internal returns (uint256 amountOut) {
		uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
		IERC20(tokenIn).forceApprove(oneInchRouter, amountIn);
		(bool success, ) = oneInchRouter.call(swapData);
		if (!success) revert SwapFailed();
		amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
		if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
	}
}
