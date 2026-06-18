// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAuthorizePositionV2 {
	event SetAuthorize(address indexed account, bool enabled);

	error NotAuthorized();

	function isAuthorized(address account) external view returns (bool);

	function setAuthorize(address account, bool enabled) external;

	function mint(address position, address target, uint256 amount) external;

	function repay(address position, uint256 amount) external returns (uint256);

	function adjust(address position, uint256 newMinted, uint256 newCollateral, uint256 newPrice) external;

	function adjustPrice(address position, uint256 newPrice) external;

	function withdrawCollateral(address position, address target, uint256 amount) external;

	function claimToken(address token, address to, uint256 amount) external;

	function claimOwnership(address position) external;
}
