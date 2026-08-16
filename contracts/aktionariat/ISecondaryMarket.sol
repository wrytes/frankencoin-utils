// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Intent} from './ITradeReactor.sol';

/// @notice Aktionariat's per-token secondary market — the contract that actually emits `Trade`, wraps
/// TradeReactor with an issuer-configurable trading fee, and (optionally) restricts who may settle trades.
/// @dev Deployed per-token, e.g. the BOSS market is 0x1e31565D4fAA26322067481F3Bb69A341b45Cf4D. Each instance
/// is immutably bound to one TOKEN/CURRENCY pair and one REACTOR.
interface ISecondaryMarket {
	event TradingFeeCollected(address currency, uint256 actualFee, address spreadRecipient, uint256 returnedSpread);
	event TradingFeeWithdrawn(address currency, address target, uint256 amount);
	event LicenseFeePaid(address currency, address target, uint256 amount);
	event MarketStatusChanged(bool isOpen, uint256 timestamp);
	event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
	event Trade(
		address indexed seller,
		address indexed buyer,
		bytes32 sellIntentHash,
		bytes32 buyIntentHash,
		address token,
		uint256 tokenAmount,
		address currency,
		uint256 currencyAmount,
		uint256 fees
	);

	error LargerSpreadNeeded(uint256 feesCollected, uint256 requiredMinimum);
	error WrongFiller();
	error WrongTokens();
	error WrongRouter(address expected, address actual);
	error InvalidConfiguration();
	error MarketClosed();
	error AlreadyFilled();
	error UserCancelled();
	error Ownable_NotOwner(address sender);

	function VERSION() external view returns (uint16);

	function ALL() external view returns (uint16);

	function CANCELLED() external view returns (uint256);

	function LICENSE_FEE_RECIPIENT() external view returns (address);

	function CURRENCY() external view returns (address);

	function TOKEN() external view returns (address);

	function REACTOR() external view returns (address);

	/// @notice 0x0 means anyone may call process(); otherwise only this address may.
	function router() external view returns (address);

	function tradingFeeBips() external view returns (uint16);

	function licenseShare() external view returns (uint16);

	function isOpen() external view returns (bool);

	function owner() external view returns (address);

	function open() external;

	function close() external;

	function setRouter(address router_) external;

	function setLicenseFee(uint16 licenseShare_) external;

	function setTradingFee(uint16 tradingFeeBips_) external;

	function transferOwnership(address newOwner) external;

	function createBuyOrder(
		address owner_,
		uint256 amountOut,
		uint256 amountIn,
		uint24 validitySeconds
	) external view returns (Intent memory);

	function createSellOrder(
		address owner_,
		uint256 amountOut,
		uint256 amountIn,
		uint24 validitySeconds
	) external view returns (Intent memory);

	function getIntentHash(Intent calldata intent) external pure returns (bytes32);

	function placeOrder(Intent calldata intent, bytes calldata signature) external;

	function verifySignature(Intent calldata intent, bytes calldata sig) external view;

	function validateOrder(
		Intent calldata intent,
		bytes calldata sig
	) external view returns (uint256 unfilled, uint256 balance, uint256 allowance);

	function executableAmounts(Intent[] calldata intents) external view returns (uint256[] memory);

	function executableAmount(Intent calldata intent) external view returns (uint256);

	function executableTrade(Intent calldata sellerIntent, Intent calldata buyerIntent) external view returns (uint256);

	/// @notice Settles a matched pair, gated by `router` if set. Computes totalFee itself as
	/// `totalExecutionPrice * tradingFeeBips / 10000` (no caller-supplied fee, unlike TradeReactor.process())
	/// and emits `Trade`. Does NOT validate the agreed price against any external reference — it only requires
	/// that the two intents' own signed bid/ask are internally consistent (bid >= ask).
	function process(
		Intent calldata seller,
		bytes calldata sellerSig,
		Intent calldata buyer,
		bytes calldata buyerSig,
		uint256 tradedAmount
	) external;

	function cancelIntent(Intent calldata intent) external;

	function withdrawFees() external;

	function withdrawFees(address currency, uint256 amount) external;
}
