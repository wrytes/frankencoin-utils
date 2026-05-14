// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {IFlashloanFrankencoin} from '../flashloan-frankencoin/IFlashloanFrankencoin.sol';
import {IFrankencoinFlashLoanCallback} from '../flashloan-frankencoin/IFrankencoinFlashLoanCallback.sol';
import {IPositionV2} from '../frankencoin/IPositionV2.sol';
import {IMintingHubV2} from '../frankencoin/IMintingHubV2.sol';
import {IBrokerbot} from '../brokerbot/IBrokerbot.sol';
import {IPaymentHub} from '../brokerbot/IPaymentHub.sol';

interface IOwnable {
	function transferOwnership(address newOwner) external;
}

/**
 * @title  LeverageRealUnit
 * @notice Stateless, permissionless executor that opens a leveraged Frankencoin
 *         PositionV2 backed by REALU (RealUnit, 0 decimals) in one transaction.
 *
 *         All values are derived on-chain from the clone source position and the
 *         BrokerBot price. The user supplies only ZCHF equity, an expiration, and
 *         the addresses of the source position and market contracts.
 *
 *         Core formula (all prices in ZCHF with 18 decimals):
 *           netPPM      = 1_000_000 − resPPM − feePPM
 *           tokens      = floor( inputAmount / (marketPrice − liqPrice × netPPM / 1e6) )
 *           mintGross   = tokens × liqPrice
 *           mintNet     = mintGross × netPPM / 1e6        ← flashloan amount
 *           swapCost    = brokerbot.getBuyPrice(tokens)   ← ZCHF to acquire REALU
 *
 *         See docs/leverage-mechanism-02.md for the full derivation.
 */
contract LeverageRealUnit is IFrankencoinFlashLoanCallback {
	using SafeERC20 for IERC20;

	// ── Deployed addresses (mainnet) ──────────────────────────────────────────

	IFlashloanFrankencoin public constant FLASHLOAN = IFlashloanFrankencoin(0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1);
	IMintingHubV2 public constant HUB = IMintingHubV2(0xDe12B620A8a714476A97EfD14E6F7180Ca653557);
	IERC20 public constant ZCHF = IERC20(0xB58E61C3098d85632Df34EecfB899A1Ed80921cB);
	IERC20 public constant REALU = IERC20(0x553C7f9C780316FC1D34b8e14ac2465Ab22a090B);

	// ── Types ─────────────────────────────────────────────────────────────────

	struct Preview {
		uint256 tokens; // REALU collateral tokens to acquire
		uint256 flashloanAmount; // mintNet ≈ tokens × marketPrice − inputAmount
		uint256 reserveAmount; // ZCHF locked in Frankencoin reserve
		uint256 feeAmount; // upfront minting interest fee
		uint256 requiredAmount; // actual ZCHF spend via BrokerBot (getBuyPrice(tokens))
	}

	struct CallbackData {
		address cloneSource; // PositionV2 to clone permanently
		uint256 tokens; // REALU tokens to buy
		uint256 mintGross; // gross ZCHF minted by the new clone
		uint40 expiration; // clone expiration
		address recipient; // position owner after clone
		IBrokerbot brokerbot; // BrokerBot used to purchase REALU
		IPaymentHub paymentHub; // PaymentHub routing ZCHF → BrokerBot
	}

	// Intra-tx return value: set in callback, consumed and cleared by executeLeverage.
	address private _clonedPosition;

	// ── Errors ────────────────────────────────────────────────────────────────

	error NotFlashloan();
	error InsufficientZCHF(uint256 available, uint256 required);
	error InsufficientREALU(uint256 got, uint256 expected);

	// ── View ──────────────────────────────────────────────────────────────────

	/**
	 * @notice Preview all derived values for a prospective leverage opening.
	 * @param cloneSource  PositionV2 to clone.
	 * @param inputAmount  User's ZCHF equity contribution.
	 * @param expiration   Clone expiration; used to compute feePPM = annualInterestPPM × duration / 365 days.
	 * @param brokerbot    BrokerBot to query for market price and buy cost.
	 */
	function preview(
		address cloneSource,
		uint256 inputAmount,
		uint40 expiration,
		IBrokerbot brokerbot
	) external view returns (Preview memory p) {
		(uint256 tokens, uint256 mintGross, uint256 mintNet, uint24 resPPM, ) = _compute(
			cloneSource,
			inputAmount,
			expiration,
			brokerbot
		);

		uint256 reserveAmount = (mintGross * resPPM) / 1_000_000;

		p.tokens = tokens;
		p.flashloanAmount = mintNet;
		p.reserveAmount = reserveAmount;
		p.feeAmount = mintGross - mintNet - reserveAmount;
		p.requiredAmount = brokerbot.getBuyPrice(tokens);
	}

	// ── Entry point ───────────────────────────────────────────────────────────

	/**
	 * @notice Open a leveraged REALU PositionV2 in a single transaction.
	 *         All values are derived on-chain from cloneSource and the brokerbot price.
	 *
	 * @param flashloanSource  PositionV2 used as the ephemeral flashloan template.
	 * @param cloneSource      PositionV2 to clone as the permanent leveraged position.
	 * @param inputAmount      ZCHF equity: pulled from msg.sender (pre-approved).
	 * @param expiration       Clone expiration timestamp (≤ cloneSource.expiration()).
	 * @param brokerbot        BrokerBot to query for market price and purchase REALU.
	 * @param paymentHub       PaymentHub that routes ZCHF payment to the BrokerBot.
	 * @return leveragedPosition  Address of the new PositionV2, owned by msg.sender.
	 */
	function executeLeverage(
		address flashloanSource,
		address cloneSource,
		uint256 inputAmount,
		uint40 expiration,
		IBrokerbot brokerbot,
		IPaymentHub paymentHub
	) external returns (address leveragedPosition) {
		ZCHF.safeTransferFrom(msg.sender, address(this), inputAmount);

		(uint256 tokens, uint256 mintGross, uint256 mintNet, , ) = _compute(
			cloneSource,
			inputAmount,
			expiration,
			brokerbot
		);

		bytes memory data = abi.encode(
			CallbackData({
				cloneSource: cloneSource,
				tokens: tokens,
				mintGross: mintGross,
				expiration: expiration,
				recipient: msg.sender,
				brokerbot: brokerbot,
				paymentHub: paymentHub
			})
		);

		FLASHLOAN.flashloan(flashloanSource, mintNet, data);

		leveragedPosition = _clonedPosition;
		_clonedPosition = address(0);
	}

	// ── Flashloan callback ────────────────────────────────────────────────────

	function onFrankencoinFlashloan(uint256 amount, bytes calldata data) external {
		if (msg.sender != address(FLASHLOAN)) revert NotFlashloan();

		CallbackData memory d = abi.decode(data, (CallbackData));

		// 1. Buy exactly d.tokens REALU via PaymentHub → BrokerBot.
		uint256 zchfCost = d.brokerbot.getBuyPrice(d.tokens);
		uint256 zchfAvailable = ZCHF.balanceOf(address(this));
		if (zchfAvailable < zchfCost) revert InsufficientZCHF(zchfAvailable, zchfCost);

		ZCHF.forceApprove(address(d.paymentHub), zchfCost);
		uint256 gotREALU = d.paymentHub.payAndNotify(d.brokerbot, zchfCost, '');
		if (gotREALU < d.tokens) revert InsufficientREALU(gotREALU, d.tokens);

		// 2. Clone leveraged position. Use the 4-arg overload so mintNet ZCHF flows to
		//    this contract (msg.sender), not to d.recipient. With the 5-arg overload the
		//    hub sends minted ZCHF to the explicit owner, leaving nothing here for repayment.
		REALU.forceApprove(address(HUB), d.tokens);
		_clonedPosition = HUB.clone(d.cloneSource, d.tokens, d.mintGross, d.expiration);

		// 3. Return any ZCHF surplus to recipient.
		uint256 surplus = ZCHF.balanceOf(address(this));
		if (surplus > amount) ZCHF.safeTransfer(d.recipient, surplus - amount);

		// 4. Approve flashloan repayment (pull model).
		ZCHF.forceApprove(address(FLASHLOAN), amount);

		// 5. Transfer position ownership to recipient now that repayment is secured.
		IOwnable(_clonedPosition).transferOwnership(d.recipient);
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	/**
	 * @dev Derive tokens, mintGross, mintNet, resPPM, and feePPM for a clone.
	 *
	 *      liqPrice: src.price() returns ZCHF per REALU with 36 decimals for 0-decimal
	 *      collateral; dividing by 1e18 normalises to 18 decimals.
	 *
	 *      feePPM: src.annualInterestPPM() prorated to the clone duration linearly.
	 *      Truncates silently if duration × annualRate exceeds uint24 max (~1.68 × 10^7).
	 *
	 *      netPPM: reverts with underflow if resPPM + feePPM ≥ 1_000_000.
	 */
	function _compute(
		address cloneSource,
		uint256 inputAmount,
		uint40 expiration,
		IBrokerbot brokerbot
	) internal view returns (uint256 tokens, uint256 mintGross, uint256 mintNet, uint24 resPPM, uint24 feePPM) {
		IPositionV2 src = IPositionV2(cloneSource);
		require(expiration > block.timestamp && expiration <= src.expiration(), 'invalid expiration');

		uint256 liqPrice18 = src.price() / 1e18; // 36 dec (REALU: 0 decimals), normalise to 18 dec
		resPPM = src.reserveContribution();
		feePPM = uint24(((uint256(expiration) - block.timestamp) * uint256(src.annualInterestPPM())) / 365 days);

		uint24 netPPM = 1_000_000 - resPPM - feePPM;

		uint256 marketPrice = brokerbot.getBuyPrice(1); // ZCHF per 1 REALU (18 dec)
		uint256 creditPerToken = (liqPrice18 * netPPM) / 1_000_000;
		tokens = inputAmount / (marketPrice - creditPerToken);

		// mintGross = tokens (0 dec) × liqPrice (18 dec) = ZCHF (18 dec)
		mintGross = (tokens * liqPrice18);
		mintNet = (mintGross * netPPM) / 1_000_000;
	}
}
