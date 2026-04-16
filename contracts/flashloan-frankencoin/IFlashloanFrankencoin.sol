// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFlashloanFrankencoin
/// @notice Interface for initiating a Frankencoin ZCHF flash loan.
interface IFlashloanFrankencoin {
	/// @notice Flash-loan `amount` ZCHF to `msg.sender`, backed by an ephemeral clone of `source`.
	///
	///         `msg.sender` must implement `IFrankencoinFlashLoanCallback`. The ZCHF is
	///         delivered before the callback and must be approved for repayment before returning.
	///
	/// @param source PositionV2 used as the clone template (must have minted() == 0 and
	///               availableForMinting() >= getMintAmount(amount)).
	/// @param amount ZCHF to deliver to msg.sender (also the exact repayment required).
	/// @param data   Arbitrary bytes forwarded verbatim to onFrankencoinFlashloan.
	function flashloan(address source, uint256 amount, bytes calldata data) external;
}
