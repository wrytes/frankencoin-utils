import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime } from './helper';

describe('EquityExtraction', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const EQUITY_ADDR = '0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2'; // FPS
	const ZCHF_WHALE = '0x9642b23Ed1E01Df1092B92641051881a322F5D4E';

	const FORK_BLOCK = 25316349;
	const INVEST_AMOUNT = ethers.parseEther('100000');

	// Simulated interest: position notional × annualInterestPPM
	// e.g. 4 mio × 1.5% = 60 000 ZCHF
	const POSITION_SIZE_M = 4n;
	const RATE_PPM = 15_000n;
	// const INTEREST_AMOUNT = (POSITION_SIZE_M * ethers.parseEther('1000000') * RATE_PPM) / 1_000_000n;
	const INTEREST_AMOUNT = ethers.parseEther('140000');

	// ── Signers / contracts ────────────────────────────────────────────────────

	let user: SignerWithAddress;
	let whale: SignerWithAddress;
	let interestPayer: SignerWithAddress;

	let zchf: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let equity: Awaited<ReturnType<typeof ethers.getContractAt>>;

	let fpsShares: bigint;
	let maxRedeemable: bigint;

	// ── ABIs ───────────────────────────────────────────────────────────────────

	const erc20Abi = [
		'function balanceOf(address) view returns (uint256)',
		'function approve(address,uint256) returns (bool)',
		'function transfer(address,uint256) returns (bool)',
	];

	const equityAbi = [
		'function invest(uint256 amount, uint256 expected) external returns (uint256)',
		'function redeem(address target, uint256 shares) external returns (uint256)',
		'function calculateProceeds(uint256 shares) view returns (uint256)',
		'function holdingDuration(address owner) view returns (uint64)',
		'function price() view returns (uint256)',
		'function balanceOf(address) view returns (uint256)',
		'function totalSupply() view returns (uint256)',
	];

	// ── Mirrors wrapper._calculateMaxUnwrap ───────────────────────────────────

	function calcMaxEquityRedeemable(balance: bigint, duration: bigint, shares: bigint): bigint {
		const NINETY_DAYS = 90n * 24n * 3600n;
		if (duration < NINETY_DAYS) return 0n;
		const maxExtract = (balance * (duration - NINETY_DAYS)) / NINETY_DAYS;
		return shares < maxExtract ? shares : maxExtract;
	}

	// ── Setup ──────────────────────────────────────────────────────────────────
	// Wrapper has been holding FPS for 95 days at this point.
	// In production we'd fork at a block where the wrapper is already mature;
	// here we advance time in setup so the wrapper's holdingDuration is ready.

	before(async function () {
		const alchemyKey = process.env.ALCHEMY_RPC_KEY;
		await ethers.provider.send('hardhat_reset', [
			{
				forking: {
					jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
					blockNumber: FORK_BLOCK,
				},
			},
		]);

		[user, interestPayer] = await ethers.getSigners();

		await user.sendTransaction({ to: ZCHF_WHALE, value: ethers.parseEther('1') });
		await ethers.provider.send('hardhat_impersonateAccount', [ZCHF_WHALE]);
		whale = await ethers.getSigner(ZCHF_WHALE);

		zchf = await ethers.getContractAt(erc20Abi, ZCHF_ADDR);
		equity = await ethers.getContractAt(equityAbi, EQUITY_ADDR);

		await zchf.connect(whale).transfer(user.address, INVEST_AMOUNT);
		await zchf.connect(whale).transfer(interestPayer.address, INTEREST_AMOUNT);
		await zchf.connect(user).approve(EQUITY_ADDR, INVEST_AMOUNT);

		// wrapper (user) invests and accumulates 95 days of holding duration
		await equity.connect(user).invest(INVEST_AMOUNT, 0n);
		await evm_increaseTime(95n * 24n * 3600n);

		fpsShares = await equity.balanceOf(user.address);
		const duration = await equity.holdingDuration(user.address);
		maxRedeemable = calcMaxEquityRedeemable(fpsShares, duration, fpsShares);

		console.log('\n=== EquityExtraction ===');
		console.log('FPS price       :', ethers.formatEther(await equity.price()), 'ZCHF/FPS');
		console.log('FPS shares      :', ethers.formatEther(fpsShares));
		console.log('Holding duration:', (Number(duration) / 86400).toFixed(1), 'days');
		console.log('Max redeemable  :', ethers.formatEther(maxRedeemable), 'FPS');
		console.log('Interest sim    :', ethers.formatEther(INTEREST_AMOUNT), 'ZCHF');
	});

	// ── Tests ──────────────────────────────────────────────────────────────────

	it('calcMaxEquityRedeemable is positive after 95 days', async function () {
		expect(maxRedeemable).to.be.gt(0n);
		expect(maxRedeemable).to.be.lt(fpsShares); // partial — (95-90)/90 ≈ 5.5%
	});

	it('FPS price rises after simulated interest payment', async function () {
		const priceBefore = await equity.price();
		await zchf.connect(interestPayer).transfer(EQUITY_ADDR, INTEREST_AMOUNT);
		const priceAfter = await equity.price();

		expect(priceAfter).to.be.gt(priceBefore);
		console.log('\n  Price before :', ethers.formatEther(priceBefore), 'ZCHF/FPS');
		console.log('  Price after  :', ethers.formatEther(priceAfter), 'ZCHF/FPS');
	});

	it('redeeming maxRedeemable yields profit', async function () {
		// partial redemption (wrapper-constrained)
		const partialCost = (INVEST_AMOUNT * maxRedeemable) / fpsShares;
		const zchfBefore = await zchf.balanceOf(user.address);
		await equity.connect(user).redeem(user.address, maxRedeemable);
		const partialReturned = (await zchf.balanceOf(user.address)) - zchfBefore;

		// redeem all remaining shares (full exit)
		const remaining = await equity.balanceOf(user.address);
		const zchfBefore2 = await zchf.balanceOf(user.address);
		await equity.connect(user).redeem(user.address, remaining);
		const remainingReturned = (await zchf.balanceOf(user.address)) - zchfBefore2;

		const totalReturned = partialReturned + remainingReturned;

		expect(partialReturned).to.be.gt(partialCost);
		expect(totalReturned).to.be.gt(INVEST_AMOUNT);

		console.log('\n  --- partial (maxRedeemable) ---');
		console.log('  Shares       :', ethers.formatEther(maxRedeemable), 'FPS');
		console.log('  Cost basis   :', ethers.formatEther(partialCost), 'ZCHF');
		console.log('  Returned     :', ethers.formatEther(partialReturned), 'ZCHF');
		console.log('  Profit       :', ethers.formatEther(partialReturned - partialCost), 'ZCHF');
		console.log('\n  --- remaining shares ---');
		console.log('  Shares       :', ethers.formatEther(remaining), 'FPS');
		console.log('  Returned     :', ethers.formatEther(remainingReturned), 'ZCHF');
		console.log('\n  --- total ---');
		console.log('  Invested     :', ethers.formatEther(INVEST_AMOUNT), 'ZCHF');
		console.log('  Returned     :', ethers.formatEther(totalReturned), 'ZCHF');
		console.log('  Net profit   :', ethers.formatEther(totalReturned - INVEST_AMOUNT), 'ZCHF');
	});
});
