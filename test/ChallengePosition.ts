import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// ── Mainnet addresses ──────────────────────────────────────────────────────────

const FRANKENCOIN = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const MINTING_HUB_V2 = '0xDe12B620A8a714476A97EfD14E6F7180Ca653557';
const PAYMENT_HUB = '0xa537D23a76EC454F0874AD4508794b17eD9BE610';
const BROKERBOT = '0x3E73d3Fc22A8637b2c16790Aa2c0E2d552d44E69';
const POSITION = '0x44Bfc2a260f091f8365ba8b240cD9491903467b9';
const ZCHF_WHALE = '0x9642b23Ed1E01Df1092B92641051881a322F5D4E';

const FORK_BLOCK = 24977371;

// ── ABIs ───────────────────────────────────────────────────────────────────────

const erc20Abi = [
	'function balanceOf(address) view returns (uint256)',
	'function approve(address,uint256) returns (bool)',
	'function allowance(address,address) view returns (uint256)',
	'function decimals() view returns (uint8)',
	'function symbol() view returns (string)',
	'function transfer(address,uint256) returns (bool)',
];

const positionAbi = [
	'function collateral() view returns (address)',
	'function minimumCollateral() view returns (uint256)',
	'function price() view returns (uint256)',
	'function expiration() view returns (uint40)',
	'function minted() view returns (uint256)',
	'function isClosed() view returns (bool)',
	'function reserveContribution() view returns (uint24)',
];

const hubAbi = [
	'function challenge(address,uint256,uint256) returns (uint256)',
	'function challenges(uint256) view returns (address,uint40,address,uint256)',
];

// brokerbotAbi and paymentHubAbi via typechain (IBrokerbot / IPaymentHub)

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ChallengePosition', function () {
	let challenger: SignerWithAddress;
	let whale: SignerWithAddress;

	let zchf: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let collateral: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let position: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let hub: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let paymentHub: Awaited<ReturnType<typeof ethers.getContractAt<'IPaymentHub'>>>;

	let collateralAddr: string;
	let collateralSymbol: string;
	let collateralDecimals: number;

	let amountBase: bigint; // exact ZCHF cost of 1 share at fork block
	let challengeIndex: bigint;

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

		[challenger] = await ethers.getSigners();

		// Fund and impersonate the ZCHF whale
		await challenger.sendTransaction({ to: ZCHF_WHALE, value: ethers.parseEther('1') });
		await ethers.provider.send('hardhat_impersonateAccount', [ZCHF_WHALE]);
		whale = await ethers.getSigner(ZCHF_WHALE);

		zchf = await ethers.getContractAt(erc20Abi, FRANKENCOIN);
		position = await ethers.getContractAt(positionAbi, POSITION);
		hub = await ethers.getContractAt(hubAbi, MINTING_HUB_V2);
		paymentHub = await ethers.getContractAt('IPaymentHub', PAYMENT_HUB);

		collateralAddr = await position.collateral();
		collateral = await ethers.getContractAt(erc20Abi, collateralAddr);
		collateralSymbol = await collateral.symbol();
		collateralDecimals = Number(await collateral.decimals());

		// Query exact price of 1000 shares so payAndNotify never under-pays
		const brokerbot = await ethers.getContractAt('IBrokerbot', BROKERBOT);
		amountBase = await brokerbot.getBuyPrice(1000n);

		// Transfer exact ZCHF amount from whale to challenger
		await zchf.connect(whale).transfer(challenger.address, amountBase);

		console.log('\n=== ChallengePosition fork setup ===');
		console.log('Block        :', FORK_BLOCK);
		console.log('Challenger   :', challenger.address);
		console.log('Position     :', POSITION);
		console.log('Collateral   :', collateralAddr, `(${collateralSymbol})`);
		console.log('Buy price    :', ethers.formatEther(amountBase), 'ZCHF (1000 shares)');
		console.log('ZCHF balance :', ethers.formatEther(await zchf.balanceOf(challenger.address)));
		console.log(
			'Min collat   :',
			ethers.formatUnits(await position.minimumCollateral(), collateralDecimals),
			collateralSymbol
		);
	});

	// ── Position state at fork block ───────────────────────────────────────────

	describe('Position state', function () {
		it('is not closed', async function () {
			expect(await position.isClosed()).to.be.false;
		});

		it('collateral matches brokerbot token', async function () {
			const brokerbot = await ethers.getContractAt('IBrokerbot', BROKERBOT);
			const brokerbotToken = await brokerbot.token();
			expect(collateralAddr.toLowerCase()).to.equal(brokerbotToken.toLowerCase());
		});

		it('prints position parameters', async function () {
			const price = await position.price();
			const minted = await position.minted();
			const minColl = await position.minimumCollateral();
			const expiration = await position.expiration();
			const reservePPM = await position.reserveContribution();

			console.log(
				'  price      :',
				ethers.formatUnits(price, 36 - collateralDecimals),
				`ZCHF/${collateralSymbol}`
			);
			console.log('  minted     :', ethers.formatEther(minted), 'ZCHF');
			console.log('  minColl    :', ethers.formatUnits(minColl, collateralDecimals), collateralSymbol);
			console.log('  expiration :', new Date(Number(expiration) * 1000).toISOString());
			console.log('  reservePPM :', reservePPM.toString(), 'ppm');

			expect(price).to.be.gt(0n);
			expect(minted).to.be.gt(0n);
		});
	});

	// ── Buy collateral via PaymentHub → Brokerbot ──────────────────────────────

	describe('Buy via PaymentHub → Brokerbot', function () {
		it('challenger received ZCHF from whale', async function () {
			expect(await zchf.balanceOf(challenger.address)).to.be.gte(amountBase);
		});

		it('approves PaymentHub to spend ZCHF', async function () {
			await zchf.connect(challenger).approve(PAYMENT_HUB, amountBase);
			expect(await zchf.allowance(challenger.address, PAYMENT_HUB)).to.equal(amountBase);
		});

		it('buys collateral shares and receives > 0 tokens', async function () {
			const balBefore = await collateral.balanceOf(challenger.address);

			const tx = await paymentHub.connect(challenger).payAndNotify(BROKERBOT, amountBase, '0x');
			const receipt = await tx.wait();

			const balAfter = await collateral.balanceOf(challenger.address);
			const received = balAfter - balBefore;

			console.log('  Shares received:', ethers.formatUnits(received, collateralDecimals), collateralSymbol);
			console.log('  Gas used       :', receipt!.gasUsed.toString());

			expect(received).to.be.gt(0n);
		});
	});

	// ── Challenge position ─────────────────────────────────────────────────────

	describe('Challenge position', function () {
		it('approves MintingHubV2 to spend full collateral balance', async function () {
			const balance = await collateral.balanceOf(challenger.address);
			expect(balance).to.be.gt(0n, 'no collateral to challenge with');

			await collateral.connect(challenger).approve(MINTING_HUB_V2, balance);
			expect(await collateral.allowance(challenger.address, MINTING_HUB_V2)).to.equal(balance);
		});

		it('challenges the position and emits a challenge index', async function () {
			const balance = await collateral.balanceOf(challenger.address);

			console.log('  Challenge size:', ethers.formatUnits(balance, collateralDecimals), collateralSymbol);

			challengeIndex = await hub.connect(challenger).challenge.staticCall(POSITION, balance, 0n);
			const tx = await hub.connect(challenger).challenge(POSITION, balance, 0n);
			const receipt = await tx.wait();

			console.log('  Challenge index:', challengeIndex.toString());
			console.log('  Gas used       :', receipt!.gasUsed.toString());

			expect(receipt!.status).to.equal(1);
		});

		it('challenge is recorded on-chain with correct position and challenger', async function () {
			const [addr, , posAddr] = await hub.challenges(challengeIndex);
			expect(addr.toLowerCase()).to.equal(challenger.address.toLowerCase());
			expect(posAddr.toLowerCase()).to.equal(POSITION.toLowerCase());
		});
	});
});
