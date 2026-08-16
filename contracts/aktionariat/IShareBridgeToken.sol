// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice Aktionariat's ShareBridgeToken — the compliance-gated ERC20 used for tokenized shares (e.g. BOSS).
/// @dev Deployed behind an AdminUpgradeabilityProxy; BOSS proxy is 0x2e880962A9609aA3eAB4DEF919FE9e917E99073B.
/// Transfers are validated against `canTransfer`, itself backed by `processor`/`realm`/`trustedIntermediaries`.
interface IShareBridgeToken {
	function name() external view returns (string memory);

	function symbol() external view returns (string memory);

	function decimals() external view returns (uint8);

	function totalSupply() external view returns (uint256);

	function balanceOf(address holder) external view returns (uint256);

	function allowance(address holder, address spender) external view returns (uint256);

	function approve(address spender, uint256 value) external returns (bool);

	function transfer(address to, uint256 value) external returns (bool);

	function transferFrom(address from, address to, uint256 value) external returns (bool);

	/// @notice Simulates whether `_amount` can move from `_from` to `_to` under the current compliance rules.
	/// @return allowed True if the transfer would be permitted.
	/// @return arg1 Implementation-defined (e.g. rule-specific limit or fee), 0 when unused.
	/// @return arg2 Implementation-defined (e.g. rule-specific limit or fee), 0 when unused.
	function canTransfer(address _from, address _to, uint256 _amount) external view returns (bool allowed, uint256 arg1, uint256 arg2);

	function owner() external view returns (address);

	function processor() external view returns (address);

	function realm() external view returns (address);

	function trustedIntermediaries() external view returns (address[] memory);
}
