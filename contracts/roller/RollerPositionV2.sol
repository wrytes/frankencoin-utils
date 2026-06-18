// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IMorpho} from '../morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from '../morpho/IMorphoCallbacks.sol';

import {IOwnable} from '../utils/IOwnable.sol';
import {IAuthorizePositionV2} from '../authorize/IAuthorizePositionV2.sol';
import {IMintingHubV2} from '../frankencoin/IMintingHubV2.sol';
import {IPositionV2} from '../frankencoin/IPositionV2.sol';

contract RollerPositionV2 is IMorphoFlashLoanCallback {
	using SafeERC20 for IERC20;

	IMorpho private immutable morpho;
	IERC20 private immutable zchf;
	IMintingHubV2 private immutable hub;

	event Rolled(
		address indexed source,
		address indexed target,
		address newPosition,
		uint256 collateral,
		uint256 repaid
	);

	struct RollData {
		address vault;
		address source;
		address target;
		uint40 expiration;
	}

	error NotMorpho();
	error NotOwner();
	error OwnerMismatch();
	error NoCollateral();
	error InsufficientMint(uint256 desired, uint256 available);

	// ---------------------------------------------------------------------------------------

	constructor(address _morpho, address _zchf, address _hubV2) {
		morpho = IMorpho(_morpho);
		zchf = IERC20(_zchf);
		hub = IMintingHubV2(_hubV2);
	}

	// ---------------------------------------------------------------------------------------

	/**
	 * @notice Roll a source position into a fresh clone of target via a collateral flash loan.
	 *
	 * Prerequisite: the vault that owns `source` must have called setAuthorize(address(this), true)
	 * before this call, and revoke it afterwards. Expected atomic workflow:
	 *   1. vault.setAuthorize(roller, true)
	 *   2. roller.execute(source, target, expiration)
	 *   3. vault.setAuthorize(roller, false)
	 */
	function execute(address vault, address source, address target, uint256 expiration) external {
		if (IOwnable(vault).owner() != msg.sender) revert NotOwner();
		if (IOwnable(source).owner() != vault) revert OwnerMismatch();

		(address coll, uint256 bal) = _collateralOf(source);

		RollData memory d = RollData(vault, source, target, uint40(expiration));
		morpho.flashLoan(coll, bal, abi.encode(d));
	}

	function _collateralOf(address source) internal view returns (address coll, uint256 bal) {
		coll = address(IPositionV2(source).collateral());
		bal = IERC20(coll).balanceOf(source);
		if (bal == 0) revert NoCollateral();
	}

	function _getRepayment(address source) internal view returns (uint256) {
		IPositionV2 pos = IPositionV2(source);
		return (pos.minted() * (1_000_000 - uint256(pos.reserveContribution()))) / 1_000_000;
	}

	function _getTotalMint(address target, uint256 amount, uint40 expiration) internal view returns (uint256) {
		IPositionV2 pos = IPositionV2(target);
		uint256 feePPM = (uint256(pos.annualInterestPPM()) * (expiration - block.timestamp)) / 365 days;
		uint256 payoutPPM = 1_000_000 - uint256(pos.reserveContribution()) - feePPM;
		return ((amount + 1) * 1_000_000 - 1) / payoutPPM + 1;
	}

	// ---------------------------------------------------------------------------------------

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		RollData memory d = abi.decode(data, (RollData));

		IAuthorizePositionV2 vault = IAuthorizePositionV2(d.vault);
		IPositionV2 source = IPositionV2(d.source);
		IERC20 collateral = IERC20(address(source.collateral()));

		uint256 repayment = _getRepayment(d.source);
		uint256 totalMint = _getTotalMint(d.target, repayment, d.expiration);

		// clone new position for vault using flash-loaned collateral; zchf minted to address(this)
		collateral.forceApprove(address(hub), assets);
		address newPos = hub.clone(d.vault, d.target, assets, totalMint, d.expiration);

		// verify received zchf (net of reserve + fee) covers repayment
		uint256 bal = zchf.balanceOf(d.vault);
		if (bal < repayment) revert InsufficientMint(repayment, bal);

		// repay source debt
		vault.adjust(d.source, 0, assets, source.price());

		// move collateral
		vault.withdrawCollateral(d.source, address(this), assets);

		// approve morpho for flash loan repayment
		collateral.forceApprove(address(morpho), assets);

		emit Rolled(d.source, d.target, newPos, assets, repayment);
	}
}
