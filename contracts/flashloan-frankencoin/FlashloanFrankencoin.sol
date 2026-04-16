// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import {IMorpho} from '../morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/IMorphoCallbacks.sol';

import {IPositionV2} from '../frankencoin/IPositionV2.sol';
import {IFrankencoin} from '../frankencoin/IFrankencoin.sol';
import {IMintingHubV2} from '../frankencoin/IMintingHubV2.sol';

import {IFrankencoinFlashLoanCallback} from './IFrankencoinFlashLoanCallback.sol';

/**
 * @title FlashloanFrankencoin
 * @notice Permissionless ZCHF flash-loan provider backed by ephemeral Frankencoin PositionV2 clones.
 *
 * Collateral source : Morpho flash loan  — borrows the collateral token
 * Minting mechanism : Frankencoin hub    — hub.clone / adjust
 * No ownership, no persistent positions, no swaps.
 *
 * ── How a loan works ─────────────────────────────────────────────────────────
 *
 *  Given a source PositionV2 with sufficient minting capacity, `flashloan()`:
 *
 *  1. Derives the collateral needed to mint `amount` ZCHF at the source's
 *     liquidation price, scaled by its reserve contribution (effective LTV):
 *
 *           effectiveLTV = 1 − reservePPM / 1e6           (e.g. 80 % if reservePPM = 200_000)
 *           collNeeded   = ⌈ amount × 1e18 × 1e6 / (liqPrice × (1e6 − reservePPM)) ⌉
 *
 *     Example: amount = 32_000 ZCHF, liqPrice = 40_000 ZCHF/token, reservePPM = 200_000
 *       → effectiveLTV = 80 %
 *       → collNeeded   = 1 token
 *
 *  2. Flash-borrows `collNeeded` of the collateral token from Morpho.
 *
 *  3. Clones `source` via the MintingHub:
 *       collateral  = collNeeded
 *       initialMint = amount          (hub.clone mints exactly `amount` ZCHF to this contract)
 *       expiration  = block.timestamp (immediately expired; closed atomically in this tx)
 *
 *  4. Transfers `amount` ZCHF to `recipient`.
 *
 *  5. Calls `recipient.onFrankencoinFlashloan(source, amount, data)`.
 *     The recipient must approve this contract for `amount` ZCHF before returning.
 *
 *  6. Pulls `amount` ZCHF back from `recipient`.
 *
 *  7. Closes the ephemeral clone: `clone.adjust(0, 0, price)` burns `amount` ZCHF
 *     and returns `collNeeded` collateral to this contract.
 *
 *  8. Returns `collNeeded` collateral to Morpho.
 *
 * ── Reserve contribution ──────────────────────────────────────────────────────
 *  The reserve contribution (reservePPM) acts as an equity-backed safety buffer.
 *  It is NOT a fee charged to the borrower — the loan is symmetric (borrow X,
 *  repay X).  Instead, it limits the LTV: the higher the reserve requirement,
 *  the more collateral must be posted per unit of ZCHF borrowed.
 *
 * ── Security ─────────────────────────────────────────────────────────────────
 *  • Permissionless: any caller may initiate a flash loan.
 *  • Reentrancy guard prevents nested flash-loan calls through this contract.
 *  • The ephemeral clone is immediately expired and closed within the same
 *    transaction, leaving no residual on-chain state.
 *  • If the source position's `availableForMinting()` is insufficient, or the
 *    collateral approval or repayment fails, the entire transaction reverts.
 */
contract FlashloanFrankencoin is IMorphoFlashLoanCallback, ReentrancyGuard {
	using SafeERC20 for IERC20;

	// ── Immutables ────────────────────────────────────────────────────────────

	/// @notice Morpho core contract used to flash-borrow the collateral token.
	IMorpho public immutable morpho;

	/// @notice Frankencoin MintingHubV2 used to clone positions.
	IMintingHubV2 public immutable hub;

	/// @notice Frankencoin ZCHF token.
	IFrankencoin public immutable zchf;

	// ── Errors ────────────────────────────────────────────────────────────────

	error NotMorpho();
	error ZeroPriceOrAmount();
	error FullReserve(); // reservePPM == 1_000_000 would make LTV = 0

	// ── Events ────────────────────────────────────────────────────────────────

	/// @param source      PositionV2 cloned to provide the loan.
	/// @param recipient   Address that received the ZCHF.
	/// @param collToken   Collateral token flash-borrowed from Morpho.
	/// @param collAmount  Amount of collateral flash-borrowed.
	/// @param amount      ZCHF delivered to recipient.
	event Flashloan(
		address indexed source,
		address indexed recipient,
		address indexed collToken,
		uint256 collAmount,
		uint256 amount
	);

	// ── Constructor ───────────────────────────────────────────────────────────

	/**
	 * @param _morpho Morpho core contract address.
	 * @param _hub    Frankencoin MintingHubV2 address.
	 */
	constructor(address _morpho, address _hub) {
		morpho = IMorpho(_morpho);
		hub = IMintingHubV2(_hub);
		zchf = IMintingHubV2(_hub).zchf();
	}

	// ── Public entry point ────────────────────────────────────────────────────

	/**
	 * @notice Flash-loan `amount` ZCHF to `msg.sender`, backed by an ephemeral clone of `source`.
	 *
	 * @param source PositionV2 used as the clone template.
	 *               Must have `availableForMinting() >= amount` and must not be expired.
	 * @param amount ZCHF to deliver to `msg.sender` (also the exact repayment required).
	 * @param data   Arbitrary bytes forwarded verbatim to `msg.sender.onFrankencoinFlashloan`.
	 */
	function flashloan(address source, uint256 amount, bytes calldata data) external nonReentrant {
		IPositionV2 src = IPositionV2(source);

		uint256 liqPrice = src.price();
		if (liqPrice == 0 || amount == 0) revert ZeroPriceOrAmount();

		uint256 reservePPM = uint256(src.reserveContribution());
		if (reservePPM >= 1_000_000) revert FullReserve();

		// ── Collateral sizing ─────────────────────────────────────────────────
		// We want:  collNeeded × liqPrice / 1e18 × (1e6 - reservePPM) / 1e6 = amount
		// Solving:  collNeeded = ⌈ amount × 1e18 × 1e6 / (liqPrice × (1e6 - reservePPM)) ⌉
		//
		// This sets the effective LTV to (1 - reservePPM), e.g. 80 % when reservePPM = 200_000.
		// At the source's liquidation price the position can comfortably back `amount` ZCHF.
		uint256 denom = liqPrice * (1_000_000 - reservePPM); // no overflow: see natspec
		uint256 collNeeded = (amount * 1e18 * 1_000_000 + denom - 1) / denom;

		address collateral = address(src.collateral());
		bytes memory cbData = abi.encode(source, amount, msg.sender, data);
		morpho.flashLoan(address(collateral), collNeeded, cbData);

		emit Flashloan(source, msg.sender, address(collateral), collNeeded, amount);
	}

	// ── Morpho flash-loan callback ────────────────────────────────────────────

	/**
	 * @notice Called by Morpho after delivering `collAssets` of the collateral token.
	 *         Must repay `collAssets` before returning.
	 */
	function onMorphoFlashLoan(uint256 collAssets, bytes calldata cbData) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		(address source, uint256 amount, address recipient, bytes memory data) = abi.decode(
			cbData,
			(address, uint256, address, bytes)
		);

		IPositionV2 src = IPositionV2(source);
		IERC20 collToken = IERC20(address(src.collateral()));

		// ── 1. Clone source with flash-loaned collateral ──────────────────────
		//
		//    expiration = block.timestamp + 1: the clone expires at the very next block,
		//    satisfying PositionV2's requirement of expiration > block.timestamp.
		//    This is safe because the position is fully closed within this same
		//    transaction — no external actor can interact with it during its single-block
		//    window (and it is already expired by the time the next block is mined).
		//
		//    initialMint: we pass getMintAmount(amount) so that after the reserve
		//    contribution is deducted, address(this) receives exactly `amount` usable
		//    ZCHF. Passing `amount` directly would only deliver amount*(1-reservePPM)
		//    to this contract, making the transfer to the recipient revert.
		collToken.forceApprove(address(hub), collAssets);
		uint256 totalMint = src.getMintAmount(amount);
		address cloneAddr = hub.clone(source, collAssets, totalMint, uint40(block.timestamp + 1));
		IPositionV2 clone = IPositionV2(cloneAddr);

		// ── 2. Deliver ZCHF to recipient ──────────────────────────────────────
		IERC20(address(zchf)).safeTransfer(recipient, amount);

		// ── 3. Callback ───────────────────────────────────────────────────────
		//    The recipient performs its logic here and MUST approve this contract
		//    for `amount` ZCHF before this call returns.
		IFrankencoinFlashLoanCallback(recipient).onFrankencoinFlashloan(amount, data);

		// ── 4. Collect repayment from recipient ───────────────────────────────
		IERC20(address(zchf)).safeTransferFrom(recipient, address(this), amount);

		// ── 5. Close the ephemeral clone ──────────────────────────────────────
		//    adjust(0, 0, price) atomically:
		//      • burns `clone.minted()` ZCHF from address(this)
		//      • withdraws all collateral back to address(this)
		// @dev: not needed, position is allowed to move frankencoins
		// IERC20(address(zchf)).forceApprove(address(clone), clone.minted());
		clone.adjust(0, 0, clone.price());

		// ── 6. Return collateral to Morpho ────────────────────────────────────
		collToken.forceApprove(address(morpho), collAssets);
	}

	// ── Views ─────────────────────────────────────────────────────────────────

	/**
	 * @notice Pre-compute the collateral that would be flash-borrowed from Morpho
	 *         for a given `source` and `amount`.
	 *
	 *         Useful for callers that need to ensure the source has enough
	 *         `availableForMinting()` before submitting the transaction.
	 *
	 * @param source PositionV2 to inspect.
	 * @param amount Desired ZCHF loan size.
	 * @return collNeeded Collateral token amount that Morpho must supply.
	 */
	function requiredCollateral(address source, uint256 amount) external view returns (uint256 collNeeded) {
		IPositionV2 src = IPositionV2(source);
		uint256 liqPrice = src.price();
		uint256 reservePPM = uint256(src.reserveContribution());
		uint256 denom = liqPrice * (1_000_000 - reservePPM);
		collNeeded = (amount * 1e18 * 1_000_000 + denom - 1) / denom;
	}
}
