// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IPositionV2} from './frankencoin/IPositionV2.sol';
import {IPositionRoller} from './frankencoin/IPositionRoller.sol';
import {ExecuteOwnable} from './ExecuteOwnable.sol';

/// @title PositionV2Streamer
/// @notice Owns Frankencoin V2 positions and allows bots to roll expiring positions into
///         whitelisted target positions in exchange for an ETH reward.
/// @dev The owner whitelists valid target positions and configures stream parameters via
///      `setConfig()`. Any caller may invoke `stream()` once the source position is within
///      the global threshold window, receiving `streamReward` ETH as incentive.
contract PositionV2Streamer is ExecuteOwnable {
	using SafeERC20 for IERC20;

	// ---------------------------------------------------------------------------------------

	/// @notice The Frankencoin position roller contract.
	IPositionRoller public immutable roller;

	/// @notice ETH reward (in wei) paid to the bot per successful `stream()` call.
	uint256 public streamReward;

	/// @notice Seconds before expiration during which a position is eligible to roll.
	uint40 public streamThreshold;

	/// @notice Duration in seconds added to block.timestamp to compute the target expiration after rolling.
	uint40 public streamPeriod;

	/// @notice Whitelisted target positions. Only whitelisted targets can be rolled into.
	mapping(address => bool) public whitelistedTargets;

	// ---------------------------------------------------------------------------------------

	event SetConfig(uint256 reward, uint40 threshold, uint40 period);
	event SetWhitelistTarget(address indexed target, bool enabled);
	event Streamed(address indexed caller, address indexed source, address indexed target, uint256 reward);

	error TargetNotWhitelisted(address target);
	error TooEarlyToStream(uint40 expiration, uint40 threshold);
	error InsufficientETHBalance();
	error RewardTransferFailed();

	// ---------------------------------------------------------------------------------------

	constructor(
		address _roller,
		address _owner,
		uint256 _streamReward,
		uint40 _streamThreshold,
		uint40 _streamPeriod
	) ExecuteOwnable(_owner) {
		roller = IPositionRoller(_roller);
		_setConfig(_streamReward, _streamThreshold, _streamPeriod);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Update all stream configuration in one call.
	/// @param _reward ETH reward (in wei) paid to the bot per `stream()` call.
	/// @param _threshold Seconds before expiration during which rolling is allowed.
	/// @param _period Duration in seconds added to block.timestamp for the target expiration after rolling.
	function setConfig(uint256 _reward, uint40 _threshold, uint40 _period) external onlyOwner {
		_setConfig(_reward, _threshold, _period);
	}

	function _setConfig(uint256 _reward, uint40 _threshold, uint40 _period) internal {
		streamReward = _reward;
		streamThreshold = _threshold;
		streamPeriod = _period;
		emit SetConfig(_reward, _threshold, _period);
	}

	/// @notice Add or remove a target position from the whitelist.
	/// @param target The target position address.
	/// @param enabled True to whitelist, false to remove.
	function setWhitelistTarget(address target, bool enabled) external onlyOwner {
		whitelistedTargets[target] = enabled;
		emit SetWhitelistTarget(target, enabled);
	}

	// ---------------------------------------------------------------------------------------

	/// @notice Roll an expiring source position into a whitelisted target position.
	/// @dev Callable by anyone once the source position is within the stream threshold window.
	///      Approves the source collateral to the roller, executes the roll, and pays the
	///      caller `streamReward` ETH as incentive.
	/// @param source The position about to expire, owned by this contract.
	/// @param target A whitelisted target position to roll into.
	function stream(address source, address target) external nonReentrant {
		if (whitelistedTargets[target] == false) revert TargetNotWhitelisted(target);

		uint40 sourceExpiration = IPositionV2(source).expiration();
		if (uint40(block.timestamp) + streamThreshold < sourceExpiration) {
			revert TooEarlyToStream(sourceExpiration, streamThreshold);
		}

		IERC20 collateral = IERC20(address(IPositionV2(source).collateral()));
		collateral.forceApprove(address(roller), type(uint256).max);
		roller.rollFullyWithExpiration(
			IPositionV2(source),
			IPositionV2(target),
			uint40(block.timestamp) + streamPeriod
		);
		collateral.forceApprove(address(roller), 0);

		if (streamReward > 0) {
			if (address(this).balance < streamReward) revert InsufficientETHBalance();
			(bool success, ) = msg.sender.call{value: streamReward}('');
			if (!success) revert RewardTransferFailed();
		}

		emit Streamed(msg.sender, source, target, streamReward);
	}
}
