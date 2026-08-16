// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @notice EIP-712 order intent signed off-chain by its owner and matched/settled by TradeReactor.process().
/// @dev Field order and names must match IntentHash.sol's INTENT_TYPE_HASH exactly, as they feed the EIP-712 struct hash.
struct Intent {
	address owner;
	address filler; // 0x0 = any filler may execute
	address tokenOut; // token the owner sends
	uint256 amountOut; // max amount of tokenOut
	address tokenIn; // token the owner receives
	uint256 amountIn; // amount of tokenIn wanted for the full amountOut
	uint256 creation; // timestamp at which the intent was created
	uint256 expiration; // timestamp at which the intent expires
	bytes data;
}

/// @notice Aktionariat's intent-based secondary-market settlement engine.
/// @dev Deployed at 0x699B77B40bEF9eBA25C39B480c20c38cF7AbaD81 on mainnet.
/// EIP-712 domain: name "TradeIntent", version "1", chainId, verifyingContract = this contract,
/// salt = keccak256("aktionariat").
interface ITradeReactor {
	error OfferTooLow();
	error InvalidFiller();
	error TokenMismatch();
	error SpreadTooLow(uint256 bid, uint256 ask, uint16 minSpread);
	error OverFilled();
	error IntentExpired(uint256 signatureDeadline);
	error InvalidSignatureLength();
	error InvalidSignature();
	error InvalidSigner();

	event IntentSignal(
		address owner,
		address filler,
		address tokenOut,
		uint256 amountOut,
		address tokenIn,
		uint256 amountIn,
		uint256 creation,
		uint256 expiration,
		bytes data,
		bytes signature
	);

	function VERSION() external view returns (uint16);

	function filledAmount(bytes32 intentHash) external view returns (uint256);

	/// @notice Publicly records an intent on-chain so a filler can pick it up. Purely optional — intents can also
	/// be communicated off-chain directly to a filler and handed straight to process().
	function signalIntent(Intent calldata intent, bytes calldata signature) external;

	function getAsk(Intent calldata intent, uint256 amount) external pure returns (uint256);

	function getBid(Intent calldata intent, uint256 amount) external pure returns (uint256);

	function verifyPriceMatch(Intent calldata buyerIntent, Intent calldata sellerIntent) external pure;

	function getTotalExecutionPrice(
		Intent calldata buyerIntent,
		Intent calldata sellerIntent,
		uint256 tradedAmount
	) external pure returns (uint256);

	function getFilledAmount(Intent calldata intent) external view returns (uint256);

	/// @notice Settles a matched seller/buyer pair atomically. Callable by anyone (permissionless) as long as both
	/// signatures are valid, the intents haven't expired, and (if set) msg.sender matches each intent's `filler`.
	/// `totalFee` is chosen by the caller (the filler) and paid to msg.sender out of the buyer's proceeds; the
	/// seller only gets `totalExecutionPrice - totalFee`, so a malicious filler on a filler=0x0 intent can extract
	/// up to the full execution price as "fee".
	function process(
		Intent calldata sellerIntent,
		bytes calldata sellerSig,
		Intent calldata buyerIntent,
		bytes calldata buyerSig,
		uint256 tradedTokens,
		uint256 totalFee
	) external;

	function verify(Intent calldata intent, bytes calldata signature) external view;

	function cancelIntent(Intent calldata intent) external;

	function cleanupExpiredIntentData(Intent[] calldata intents) external;
}
