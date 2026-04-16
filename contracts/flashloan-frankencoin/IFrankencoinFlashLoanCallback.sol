// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFrankencoinFlashLoanCallback
/// @notice Interface that recipients of a Frankencoin ZCHF flash loan must implement.
///
/// The implementor receives ZCHF, performs its logic, then approves the
/// `FlashloanFrankencoin` contract for the repayment amount before returning.
interface IFrankencoinFlashLoanCallback {
	/// @notice Invoked after `amount` ZCHF has been transferred to `msg.sender`.
	///
	///         Before this function returns, the recipient MUST approve the calling
	///         `FlashloanFrankencoin` contract for at least `amount` ZCHF so the
	///         repayment pull can succeed.
	///
	/// @param amount ZCHF delivered to this contract (equals the repayment required).
	/// @param data   Arbitrary bytes forwarded from the original `flashloan()` call.
	function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external;
}
