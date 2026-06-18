// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRollerPositionV2 {
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
	error OwnerMismatch();
	error NoCollateral();
	error InsufficientMint(uint256 desired, uint256 available);

	function execute(address vault, address source, address target, uint256 expiration) external;

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
