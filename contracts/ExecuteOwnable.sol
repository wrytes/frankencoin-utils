// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Ownable2Step, Ownable} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

/// @notice The action struct to be consumed by the DAO's `execute` function resulting in an external call.
/// @param to The address to call.
/// @param value The native token value to be sent with the call.
/// @param data The bytes-encoded function selector and calldata for the call.
struct Action {
	address to;
	uint256 value;
	bytes data;
}

/// @title ExecuteOwnable
/// @notice Reusable base contract providing owner-controlled arbitrary execution,
///         ETH acceptance, and token/ETH rescue functions.
/// @dev Inherit this contract to get an Aragon-style `execute()` function and
///      safe withdrawal helpers. Ownership is managed via Ownable2Step.
abstract contract ExecuteOwnable is Ownable2Step, ReentrancyGuard {
	using SafeERC20 for IERC20;

	// ---------------------------------------------------------------------------------------

	event Executed(bytes32 callId, uint256 failureMap);

	error TooManyActions();
	error ActionFailed(uint256 index);
	error InsufficientGas();
	error TransferFailed();

	uint256 private constant MAX_ACTIONS = 256;

	// ---------------------------------------------------------------------------------------

	constructor(address _owner) Ownable(_owner) {}

	receive() external payable {}

	// ---------------------------------------------------------------------------------------

	/// @notice Execute arbitrary actions on behalf of this contract.
	/// @dev Follows the Aragon IExecutor pattern. Useful for managing owned external contracts
	///      (e.g. Frankencoin positions: adjust, mint, repay, withdrawCollateral, etc.).
	/// @param _callId Arbitrary identifier for the call batch (e.g. nonce).
	/// @param _actions Array of actions to execute.
	/// @param _allowFailureMap Bitmap of action indices allowed to fail without reverting.
	function execute(
		bytes32 _callId,
		Action[] calldata _actions,
		uint256 _allowFailureMap
	) external onlyOwner nonReentrant returns (bytes[] memory execResults, uint256 failureMap) {
		if (_actions.length > MAX_ACTIONS) revert TooManyActions();

		execResults = new bytes[](_actions.length);

		for (uint256 i = 0; i < _actions.length; ) {
			uint256 gasBefore = gasleft();
			(bool success, bytes memory result) = _actions[i].to.call{value: _actions[i].value}(_actions[i].data);
			uint256 gasAfter = gasleft();

			if (!_hasBit(_allowFailureMap, uint8(i))) {
				if (!success) revert ActionFailed(i);
			} else {
				if (!success) {
					if (gasAfter < gasBefore / 64) revert InsufficientGas();
					failureMap = _flipBit(failureMap, uint8(i));
				}
			}

			execResults[i] = result;
			unchecked {
				++i;
			}
		}

		emit Executed(_callId, failureMap);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Withdraw ETH held by this contract.
	function withdrawETH(address payable to, uint256 amount) external onlyOwner {
		(bool success, ) = to.call{value: amount}('');
		if (!success) revert TransferFailed();
	}

	/// @notice Withdraw any ERC20 token held by this contract.
	function withdrawToken(IERC20 token, address to, uint256 amount) external onlyOwner {
		token.safeTransfer(to, amount);
	}

	// ---------------------------------------------------------------------------------------

	function _hasBit(uint256 bitmap, uint8 index) internal pure returns (bool) {
		return (bitmap >> index) & 1 == 1;
	}

	function _flipBit(uint256 bitmap, uint8 index) internal pure returns (uint256) {
		return bitmap ^ (1 << index);
	}
}
