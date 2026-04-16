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
 * Flow per loan:
 *  1. Compute collateral needed via requiredCollateral(source, amount).
 *  2. Flash-borrow that collateral from Morpho.
 *  3. Clone source with the collateral; hub mints getMintAmount(amount) ZCHF here.
 *  4. Transfer amount ZCHF to msg.sender and invoke onFrankencoinFlashloan.
 *  5. Pull amount ZCHF back; close the clone via adjust(0,0,price).
 *  6. Return collateral to Morpho.
 */
contract FlashloanFrankencoin is IMorphoFlashLoanCallback, ReentrancyGuard {
	using SafeERC20 for IERC20;

	IMorpho public immutable morpho;
	IMintingHubV2 public immutable hub;
	IFrankencoin public immutable zchf;

	error NotMorpho();
	error ZeroPriceOrAmount();
	error FullReserve();
	error PositionExpired();
	error InsufficientMintingCapacity();

	event Flashloan(
		address indexed source,
		address indexed recipient,
		uint256 collAmount,
		uint256 totalMint,
		uint256 amount
	);

	constructor(address _morpho, address _hub) {
		morpho = IMorpho(_morpho);
		hub = IMintingHubV2(_hub);
		zchf = IMintingHubV2(_hub).zchf();
	}

	// ── Public entry point ────────────────────────────────────────────────────

	function flashloan(address source, uint256 amount, bytes calldata data) external nonReentrant {
		IPositionV2 src = IPositionV2(source);

		(uint256 collNeeded, uint256 totalMint) = requiredCollateral(source, amount);
		address collateral = address(src.collateral());

		morpho.flashLoan(collateral, collNeeded, abi.encode(source, totalMint, amount, msg.sender, data));

		emit Flashloan(source, msg.sender, collNeeded, totalMint, amount);
	}

	// ── Morpho callback ───────────────────────────────────────────────────────

	function onMorphoFlashLoan(uint256 collAssets, bytes calldata cbData) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		(address source, uint256 totalMint, uint256 amount, address recipient, bytes memory data) = abi.decode(
			cbData,
			(address, uint256, uint256, address, bytes)
		);

		IPositionV2 src = IPositionV2(source);
		IERC20 collToken = IERC20(address(src.collateral()));

		// 1. Clone — expiration block.timestamp+1 satisfies PositionV2's strict inequality
		collToken.forceApprove(address(hub), collAssets);
		IPositionV2 clone = IPositionV2(hub.clone(source, collAssets, totalMint, uint40(block.timestamp + 1)));

		// 2. Deliver ZCHF → callback → collect repayment
		IERC20(address(zchf)).safeTransfer(recipient, amount);
		IFrankencoinFlashLoanCallback(recipient).onFrankencoinFlashloan(amount, data);
		IERC20(address(zchf)).safeTransferFrom(recipient, address(this), amount);

		// 3. Close clone: burns minted ZCHF, returns collateral here
		clone.adjust(0, 0, clone.price());

		// 4. Return collateral to Morpho
		collToken.forceApprove(address(morpho), collAssets);
	}

	// ── View ──────────────────────────────────────────────────────────────────

	/// @notice Collateral and total mint amount required for a given source and loan size.
	function requiredCollateral(
		address source,
		uint256 amount
	) public view returns (uint256 collateral, uint256 totalMint) {
		IPositionV2 src = IPositionV2(source);
		uint256 price = src.price();
		uint256 reserveContribution = src.reserveContribution();

		if (price == 0 || amount == 0) revert ZeroPriceOrAmount();
		if (reserveContribution >= 1_000_000) revert FullReserve();
		if (IPositionV2(src.original()).expiration() <= block.timestamp) revert PositionExpired();

		uint256 denom = price * (1_000_000 - uint256(reserveContribution));
		uint256 coll = (amount * 1e18 * 1_000_000 + denom - 1) / denom;

		collateral = coll < src.minimumCollateral() ? src.minimumCollateral() : coll;
		totalMint = (collateral * price + 1e18 - 1) / 1e18;
		if (src.availableForMinting() < totalMint) revert InsufficientMintingCapacity();
	}
}
