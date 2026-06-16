// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IPositionV2} from '../frankencoin/IPositionV2.sol';

interface IOwnable {
	function transferOwnership(address newOwner) external;
}

/// @title AuthorizePositionV2
/// @notice Vault controller that holds ownership of one or more Frankencoin V2 positions and
///         delegates control to a set of authorized callers (e.g. bots or co-owners).
contract AuthorizePositionV2 is Ownable2Step {
	using SafeERC20 for IERC20;

	mapping(address => bool) private authorized;

	event SetAuthorize(address indexed account, bool enabled);

	error NotAuthorized();

	modifier onlyAuthorized() {
		if (!isAuthorized(msg.sender)) revert NotAuthorized();
		_;
	}

	constructor(address _owner) Ownable(_owner) {}

	// ---------------------------------------------------------------------------------------

	/// @notice Returns true for the owner and any explicitly authorized address.
	function isAuthorized(address account) public view returns (bool) {
		return account == owner() || authorized[account];
	}

	/// @notice Grant or revoke authorization for an address.
	function setAuthorize(address account, bool enabled) external onlyOwner {
		authorized[account] = enabled;
		emit SetAuthorize(account, enabled);
	}

	// ---------------------------------------------------------------------------------------

	function mint(address position, address target, uint256 amount) external onlyAuthorized {
		IPositionV2(position).mint(target, amount);
	}

	function repay(address position, uint256 amount) external onlyAuthorized returns (uint256) {
		return IPositionV2(position).repay(amount);
	}

	function adjust(
		address position,
		uint256 newMinted,
		uint256 newCollateral,
		uint256 newPrice
	) external onlyAuthorized {
		IPositionV2(position).adjust(newMinted, newCollateral, newPrice);
	}

	function adjustPrice(address position, uint256 newPrice) external onlyAuthorized {
		IPositionV2(position).adjustPrice(newPrice);
	}

	function withdrawCollateral(address position, address target, uint256 amount) external onlyAuthorized {
		IPositionV2(position).withdrawCollateral(target, amount);
	}

	function claimToken(address token, address to, uint256 amount) external onlyAuthorized {
		IERC20(token).safeTransfer(to, amount);
	}

	function claimOwnership(address position) external onlyOwner {
		IOwnable(position).transferOwnership(owner());
	}
}
