import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ISecondaryMarket, IShareBridgeToken, ITradeReactor } from '../typechain';
import { IntentStruct } from '../typechain/contracts/aktionariat/ITradeReactor';

/**
 * Exercises the real Aktionariat settlement path for BOSS shares: SecondaryMarket.process(), which is the
 * only contract in this stack that actually emits `Trade` (TradeReactor.process() itself has its Trade emit
 * commented out in the deployed source — it only moves tokens).
 *
 * SecondaryMarket.process() is gated by a `router` address (Ownable-configured, currently a plain EOA on
 * mainnet for the BOSS market — not the market owner itself). To drive the real code path in the fork we
 * impersonate that router; on real mainnet this is a privilege only the router key holder has, not something
 * a permissionless outsider could do.
 *
 * Also probes: since price comes entirely from the two intents' own signed amountOut/amountIn ratios, with no
 * external reference check beyond internal bid >= ask consistency, does the contract accept — and emit as a
 * legitimate `Trade` — a self-dealt trade priced at an arbitrary multiple of a "fair" price?
 */
describe('Aktionariat SecondaryMarket.process() — Trade settlement, router gate, arbitrary pricing', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const BOSS_ADDR = '0x2E880962A9609aA3eab4DEF919FE9E917E99073B'; // Aktionariat ShareBridgeToken proxy
	const TRADE_REACTOR_ADDR = '0x699B77B40bEF9eBA25C39B480c20c38cF7AbaD81';
	const SECONDARY_MARKET_ADDR = '0x1e31565D4fAA26322067481F3Bb69A341b45Cf4D'; // BOSS market

	// Holders as of FORK_BLOCK, used to fund our own test wallets
	const ZCHF_WHALE = '0x9642b23Ed1E01Df1092B92641051881a322F5D4E';
	const BOSS_WHALE = '0xdEa2ed23C9548c7b3E3c9dF38B040599657727Ee'; // liquidity address feeding TradeReactor

	const FORK_BLOCK = 25516561;

	// EIP-712 domain hardcoded into TradeReactor's IntentVerifier at deploy time (see IntentVerifier.sol) —
	// it's a state variable computed once in mainnet's constructor, so it must be reproduced exactly here,
	// independent of whatever chainId the local Hardhat fork reports. SecondaryMarket.process() forwards to
	// the same reactor, so intents signed against this domain are valid regardless of which contract we call.
	const REACTOR_DOMAIN = {
		name: 'TradeIntent',
		version: '1',
		chainId: 1n,
		verifyingContract: TRADE_REACTOR_ADDR,
		salt: ethers.keccak256(ethers.toUtf8Bytes('aktionariat')),
	};

	const INTENT_TYPES = {
		Intent: [
			{ name: 'owner', type: 'address' },
			{ name: 'filler', type: 'address' },
			{ name: 'tokenOut', type: 'address' },
			{ name: 'amountOut', type: 'uint256' },
			{ name: 'tokenIn', type: 'address' },
			{ name: 'amountIn', type: 'uint256' },
			{ name: 'creation', type: 'uint256' },
			{ name: 'expiration', type: 'uint256' },
			{ name: 'data', type: 'bytes' },
		],
	};

	const erc20Abi = [
		'function balanceOf(address) view returns (uint256)',
		'function transfer(address,uint256) returns (bool)',
		'function approve(address,uint256) returns (bool)',
	];

	const BOSS_AMOUNT = 10n; // BOSS has 0 decimals — whole shares
	const FAIR_PRICE_PER_SHARE = ethers.parseEther('9.1'); // reference price for this test suite
	const DOUBLE_PRICE_PER_SHARE = FAIR_PRICE_PER_SHARE * 2n;

	// ── Signers ────────────────────────────────────────────────────────────────

	let deployer: SignerWithAddress; // funds gas for everyone
	let zchfWhale: SignerWithAddress;
	let bossWhale: SignerWithAddress;
	let router: SignerWithAddress; // impersonated — the only address SecondaryMarket.process() currently accepts

	// ── Contracts ──────────────────────────────────────────────────────────────

	let zchf: ReturnType<typeof ethers.getContractAt> extends Promise<infer T> ? T : never;
	let boss: IShareBridgeToken;
	let reactor: ITradeReactor;
	let market: ISecondaryMarket;

	// ── Setup ──────────────────────────────────────────────────────────────────

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

		[deployer] = await ethers.getSigners();

		zchf = await ethers.getContractAt(erc20Abi, ZCHF_ADDR);
		boss = await ethers.getContractAt('IShareBridgeToken', BOSS_ADDR);
		reactor = await ethers.getContractAt('ITradeReactor', TRADE_REACTOR_ADDR);
		market = await ethers.getContractAt('ISecondaryMarket', SECONDARY_MARKET_ADDR);

		const routerAddr = await market.router();

		// Fund and impersonate the whales + the market's configured router
		for (const addr of [ZCHF_WHALE, BOSS_WHALE, routerAddr]) {
			await deployer.sendTransaction({ to: addr, value: ethers.parseEther('1') });
			await ethers.provider.send('hardhat_impersonateAccount', [addr]);
		}
		zchfWhale = await ethers.getSigner(ZCHF_WHALE);
		bossWhale = await ethers.getSigner(BOSS_WHALE);
		router = await ethers.getSigner(routerAddr);

		console.log('\n=== Fork setup ===');
		console.log('Block              :', FORK_BLOCK);
		console.log('BOSS whale         :', BOSS_WHALE, '-', (await boss.balanceOf(BOSS_WHALE)).toString(), 'BOSS');
		console.log('ZCHF whale         :', ZCHF_WHALE, '-', ethers.formatEther(await zchf.balanceOf(ZCHF_WHALE)), 'ZCHF');

		console.log('\n=== SecondaryMarket (BOSS) config ===');
		console.log('address            :', SECONDARY_MARKET_ADDR);
		console.log('owner()            :', await market.owner());
		console.log('router()           :', routerAddr, '<-- impersonating this address to call process()');
		console.log('isOpen()           :', await market.isOpen());
		console.log('tradingFeeBips()   :', (await market.tradingFeeBips()).toString(), 'bips');
		console.log('licenseShare()     :', (await market.licenseShare()).toString(), 'bips of the trading fee');
		console.log('CURRENCY()         :', await market.CURRENCY(), '(expect ZCHF)');
		console.log('TOKEN()            :', await market.TOKEN(), '(expect BOSS)');
		console.log('REACTOR()          :', await market.REACTOR(), '(expect TradeReactor)');
		expect(await market.CURRENCY()).to.equal(ZCHF_ADDR);
		expect(await market.TOKEN()).to.equal(BOSS_ADDR);
		expect(await market.REACTOR()).to.equal(TRADE_REACTOR_ADDR);
		expect(await market.isOpen()).to.equal(true, 'market must be open for process() to succeed');
	});

	// Funds two brand-new wallets ("two addresses we own") — seller starts holding BOSS, buyer starts holding
	// ZCHF — with a bit of ETH for gas plus the token they'll be giving away.
	async function fundFreshPair(label: string) {
		const seller = ethers.Wallet.createRandom().connect(ethers.provider);
		const buyer = ethers.Wallet.createRandom().connect(ethers.provider);

		await deployer.sendTransaction({ to: seller.address, value: ethers.parseEther('1') });
		await deployer.sendTransaction({ to: buyer.address, value: ethers.parseEther('1') });

		await boss.connect(bossWhale).transfer(seller.address, BOSS_AMOUNT);
		await zchf.connect(zchfWhale).transfer(buyer.address, ethers.parseEther('1000')); // generous headroom

		console.log(`\n--- ${label}: fresh wallets funded ---`);
		console.log('  seller  :', seller.address, '-', (await boss.balanceOf(seller.address)).toString(), 'BOSS');
		console.log('  buyer   :', buyer.address, '-', ethers.formatEther(await zchf.balanceOf(buyer.address)), 'ZCHF');

		return { seller, buyer };
	}

	// Builds a matching seller/buyer order pair priced at exactly `pricePerShare`, signs both with the owner's
	// key, and approves the reactor to pull each leg. Uses the market's own createSellOrder/createBuyOrder
	// view helpers so the `filler` field and struct shape exactly match what a real UI would produce.
	async function buildAndSignMatchedOrders(
		seller: ethers.Wallet,
		buyer: ethers.Wallet,
		pricePerShare: bigint,
		label: string
	) {
		const totalPrice = pricePerShare * BOSS_AMOUNT;
		const validitySeconds = 3600;

		// createSellOrder/createBuyOrder return an ethers.Result (frozen, array-like) — copy into a plain
		// object before it can be re-encoded as a tuple argument for signing / the process() call below.
		const rawSellerIntent = await market.createSellOrder(seller.address, BOSS_AMOUNT, totalPrice, validitySeconds);
		const rawBuyerIntent = await market.createBuyOrder(buyer.address, totalPrice, BOSS_AMOUNT, validitySeconds);
		const toIntent = (r: typeof rawSellerIntent): IntentStruct => ({
			owner: r.owner,
			filler: r.filler,
			tokenOut: r.tokenOut,
			amountOut: r.amountOut,
			tokenIn: r.tokenIn,
			amountIn: r.amountIn,
			creation: r.creation,
			expiration: r.expiration,
			data: r.data,
		});
		const sellerIntent = toIntent(rawSellerIntent);
		const buyerIntent = toIntent(rawBuyerIntent);

		console.log(`\n--- ${label}: orders built ---`);
		console.log('  price/share        :', ethers.formatEther(pricePerShare), 'ZCHF');
		console.log('  sellerIntent.owner :', sellerIntent.owner, ' amountOut(BOSS):', sellerIntent.amountOut.toString(), ' amountIn(ZCHF):', ethers.formatEther(sellerIntent.amountIn));
		console.log('  buyerIntent.owner  :', buyerIntent.owner, ' amountOut(ZCHF):', ethers.formatEther(buyerIntent.amountOut), ' amountIn(BOSS):', buyerIntent.amountIn.toString());
		console.log('  intent.filler      :', sellerIntent.filler, '(expect SecondaryMarket address)');

		const sellerSig = await seller.signTypedData(REACTOR_DOMAIN, INTENT_TYPES, sellerIntent);
		const buyerSig = await buyer.signTypedData(REACTOR_DOMAIN, INTENT_TYPES, buyerIntent);

		// Sanity-check both signatures before touching process(), so a bad signature fails loudly here instead
		// of surfacing as an opaque revert from inside process(). Must go through market.verifySignature(),
		// not reactor.verify() directly — these intents carry filler = SecondaryMarket address (set by
		// createSellOrder/createBuyOrder), and the reactor only accepts a verify() call whose msg.sender
		// matches that filler. Called this way, market.verifySignature() forwards to the reactor as an
		// internal message call, so the reactor sees msg.sender = the market contract, as it will for real.
		await market.verifySignature(sellerIntent, sellerSig);
		await market.verifySignature(buyerIntent, buyerSig);
		console.log('  market.verifySignature(): both signatures OK');

		await boss.connect(seller).approve(TRADE_REACTOR_ADDR, BOSS_AMOUNT);
		await zchf.connect(buyer).approve(TRADE_REACTOR_ADDR, totalPrice);
		console.log('  approvals granted to reactor: seller ->', BOSS_AMOUNT.toString(), 'BOSS, buyer ->', ethers.formatEther(totalPrice), 'ZCHF');

		return { sellerIntent, buyerIntent, sellerSig, buyerSig, totalPrice };
	}

	// ── Baseline: SecondaryMarket.process() called by its configured router ────

	describe('SecondaryMarket.process() at a fair, matched price', function () {
		it('settles atomically, emits Trade, and takes the configured trading fee', async function () {
			const { seller, buyer } = await fundFreshPair('fair-price trade');
			const { sellerIntent, buyerIntent, sellerSig, buyerSig, totalPrice } = await buildAndSignMatchedOrders(
				seller,
				buyer,
				FAIR_PRICE_PER_SHARE,
				'fair-price trade'
			);

			const expectedFee = (totalPrice * (await market.tradingFeeBips())) / 10000n;
			const sellIntentHash = await market.getIntentHash(sellerIntent);
			const buyIntentHash = await market.getIntentHash(buyerIntent);

			const marketZchfBefore = await zchf.balanceOf(SECONDARY_MARKET_ADDR);

			console.log('\n--- fair-price trade: calling process() as router ---');
			console.log('  caller (router)    :', router.address);
			console.log('  expected totalPrice:', ethers.formatEther(totalPrice), 'ZCHF');
			console.log('  expected fee       :', ethers.formatEther(expectedFee), 'ZCHF');

			const tx = await market.connect(router).process(sellerIntent, sellerSig, buyerIntent, buyerSig, BOSS_AMOUNT);
			const receipt = await tx.wait();
			console.log('  tx hash            :', receipt!.hash);
			console.log('  gas used           :', receipt!.gasUsed.toString());

			await expect(tx)
				.to.emit(market, 'Trade')
				.withArgs(seller.address, buyer.address, sellIntentHash, buyIntentHash, BOSS_ADDR, BOSS_AMOUNT, ZCHF_ADDR, totalPrice, expectedFee);

			const sellerZchfAfter = await zchf.balanceOf(seller.address);
			const buyerBossAfter = await boss.balanceOf(buyer.address);
			const marketZchfAfter = await zchf.balanceOf(SECONDARY_MARKET_ADDR);

			console.log('\n--- fair-price trade: post-settlement balances ---');
			console.log('  seller BOSS        :', (await boss.balanceOf(seller.address)).toString());
			console.log('  seller ZCHF        :', ethers.formatEther(sellerZchfAfter), '(expect totalPrice - fee =', ethers.formatEther(totalPrice - expectedFee), ')');
			console.log('  buyer  BOSS        :', buyerBossAfter.toString());
			console.log('  market ZCHF        :', ethers.formatEther(marketZchfAfter), '(was', ethers.formatEther(marketZchfBefore), ', fee accrues here until withdrawFees())');

			expect(await boss.balanceOf(seller.address)).to.equal(0n);
			expect(buyerBossAfter).to.equal(BOSS_AMOUNT);
			expect(sellerZchfAfter).to.equal(totalPrice - expectedFee);
			expect(marketZchfAfter - marketZchfBefore).to.equal(expectedFee);
		});
	});

	// ── The router gate is real ─────────────────────────────────────────────────

	describe('SecondaryMarket.process() router gate', function () {
		it('reverts with WrongRouter when called by anyone other than the configured router', async function () {
			const { seller, buyer } = await fundFreshPair('router-gate check');
			const { sellerIntent, buyerIntent, sellerSig, buyerSig } = await buildAndSignMatchedOrders(
				seller,
				buyer,
				FAIR_PRICE_PER_SHARE,
				'router-gate check'
			);

			const routerAddr = await market.router();
			console.log('\n--- router-gate check: calling process() as an unrelated address ---');
			console.log('  caller (unrelated) :', deployer.address);
			console.log('  configured router  :', routerAddr);

			await expect(market.connect(deployer).process(sellerIntent, sellerSig, buyerIntent, buyerSig, BOSS_AMOUNT))
				.to.be.revertedWithCustomError(market, 'WrongRouter')
				.withArgs(deployer.address, routerAddr);

			console.log('  reverted as expected: WrongRouter(caller, configuredRouter)');
			console.log('  Confirms process() on SecondaryMarket is NOT permissionless like raw TradeReactor.process() is —');
			console.log('  only the router key holder (or whoever the owner reassigns router() to) can settle trades here.');
		});
	});

	// ── Arbitrary / self-dealt pricing ──────────────────────────────────────────

	describe('SecondaryMarket.process() with a self-dealt, doubled price', function () {
		it('settles at 2x the fair price with no protocol-level check against any external reference', async function () {
			const { seller, buyer } = await fundFreshPair('double-price trade');
			const { sellerIntent, buyerIntent, sellerSig, buyerSig, totalPrice } = await buildAndSignMatchedOrders(
				seller,
				buyer,
				DOUBLE_PRICE_PER_SHARE,
				'double-price trade'
			);

			const expectedFee = (totalPrice * (await market.tradingFeeBips())) / 10000n;
			const sellIntentHash = await market.getIntentHash(sellerIntent);
			const buyIntentHash = await market.getIntentHash(buyerIntent);

			console.log('\n--- double-price trade: price comparison ---');
			console.log('  fair reference price :', ethers.formatEther(FAIR_PRICE_PER_SHARE), 'ZCHF/share');
			console.log('  price used here       :', ethers.formatEther(DOUBLE_PRICE_PER_SHARE), 'ZCHF/share (2.00x)');
			console.log('  only requirement      : sellerIntent bid/ask and buyerIntent bid/ask are internally consistent');
			console.log('                          (getBid(buyerIntent,1) >= getAsk(sellerIntent,1)) — both are ours, so trivially satisfied.');

			console.log('\n--- double-price trade: calling process() as router ---');
			const tx = await market.connect(router).process(sellerIntent, sellerSig, buyerIntent, buyerSig, BOSS_AMOUNT);
			const receipt = await tx.wait();
			console.log('  tx hash               :', receipt!.hash);
			console.log('  gas used              :', receipt!.gasUsed.toString());

			await expect(tx)
				.to.emit(market, 'Trade')
				.withArgs(seller.address, buyer.address, sellIntentHash, buyIntentHash, BOSS_ADDR, BOSS_AMOUNT, ZCHF_ADDR, totalPrice, expectedFee);

			const sellerZchfAfter = await zchf.balanceOf(seller.address);
			console.log('\n--- double-price trade: result ---');
			console.log('  Trade event currencyAmount:', ethers.formatEther(totalPrice), 'ZCHF for', BOSS_AMOUNT.toString(), 'BOSS');
			console.log('  seller received            :', ethers.formatEther(sellerZchfAfter), 'ZCHF (', ethers.formatEther(totalPrice - expectedFee), 'net of fee)');
			console.log('  => No revert, no price-sanity check. A router-privileged relayer settling two self-controlled');
			console.log('     wallets can publish an on-chain Trade at whatever price both signed intents agree on.');
			console.log('     The only real-world barrier is holding the router key (or being the owner, who can');
			console.log('     reassign router() to themselves or to 0x0 at will) — not any protocol-level price check.');

			expect(await boss.balanceOf(buyer.address)).to.equal(BOSS_AMOUNT);
			expect(sellerZchfAfter).to.equal(totalPrice - expectedFee);
			expect(totalPrice).to.equal(FAIR_PRICE_PER_SHARE * BOSS_AMOUNT * 2n);
		});
	});
});
