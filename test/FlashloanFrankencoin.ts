import { expect } from 'chai';
import { ethers } from 'hardhat';
import { FlashloanFrankencoin, MockFlashloanRecipient } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseEther } from 'ethers';

// ── Mainnet addresses ──────────────────────────────────────────────────────────

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MINTING_HUB_V2 = '0xDe12B620A8a714476A97EfD14E6F7180Ca653557';
const FRANKENCOIN = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';

// A live WBTC-backed PositionV2 with headroom for minting.
// Update this address to any position with availableForMinting() > 0 and not expired.
const SOURCE_POSITION = '0x5F2c10f779B7f0C44ee80128A3d7ac75B255bb95';

// ── Helpers ────────────────────────────────────────────────────────────────────

const zchfAbi = [
	'function balanceOf(address) view returns (uint256)',
	'function allowance(address,address) view returns (uint256)',
];

const posAbi = [
	'function price() view returns (uint256)',
	'function reserveContribution() view returns (uint24)',
	'function availableForMinting() view returns (uint256)',
	'function minimumCollateral() view returns (uint256)',
	'function expiration() view returns (uint40)',
	'function collateral() view returns (address)',
];

const erc20Abi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('FlashloanFrankencoin', function () {
	let deployer: SignerWithAddress;

	let flashloan: FlashloanFrankencoin;
	let recipient: MockFlashloanRecipient;

	let sourcePos: ReturnType<typeof ethers.getContractAt> extends Promise<infer T> ? T : never;
	let zchf: ReturnType<typeof ethers.getContractAt> extends Promise<infer T> ? T : never;

	// ── Setup ──────────────────────────────────────────────────────────────────

	before(async function () {
		const alchemyKey = process.env.ALCHEMY_RPC_KEY;
		await ethers.provider.send('hardhat_reset', [
			{
				forking: {
					jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
					// no blockNumber → latest — position 0x5F2c10... is live
				},
			},
		]);

		[deployer] = await ethers.getSigners();

		sourcePos = await ethers.getContractAt(posAbi, SOURCE_POSITION);
		zchf = await ethers.getContractAt(zchfAbi, FRANKENCOIN);

		// Deploy FlashloanFrankencoin
		flashloan = await ethers.deployContract('FlashloanFrankencoin', [MORPHO, MINTING_HUB_V2]);

		// Deploy mock recipient (needs ZCHF address for approval logic)
		recipient = await ethers.deployContract('MockFlashloanRecipient', [FRANKENCOIN, await flashloan.getAddress()]);

		const flashAddr = await flashloan.getAddress();
		const recipientAddr = await recipient.getAddress();

		console.log('\n=== FlashloanFrankencoin fork setup ===');
		console.log('FlashloanFrankencoin :', flashAddr);
		console.log('MockFlashloanRecipient:', recipientAddr);
		console.log('Source position      :', SOURCE_POSITION);
	});

	// ── Deployment ─────────────────────────────────────────────────────────────

	describe('Deployment', function () {
		it('stores morpho address', async function () {
			expect(await flashloan.morpho()).to.equal(MORPHO);
		});

		it('stores hub address', async function () {
			expect(await flashloan.hub()).to.equal(MINTING_HUB_V2);
		});

		it('stores zchf address', async function () {
			expect(await flashloan.zchf()).to.equal(FRANKENCOIN);
		});
	});

	// ── requiredCollateral() ───────────────────────────────────────────────────

	describe('requiredCollateral()', function () {
		it('returns non-zero collateral for a valid source and amount', async function () {
			const amount = ethers.parseEther('36000'); // 36 000 ZCHF
			const [coll, totalMint] = await flashloan.requiredCollateral(SOURCE_POSITION, amount);

			console.log('  requiredCollateral(36 000 ZCHF) =', ethers.formatUnits(coll, 8), 'WBTC');
			console.log('  totalMint(45 000 ZCHF)          =', ethers.formatEther(totalMint), 'ZCHF'); // +20% reserve
			expect(coll).to.be.equal(ethers.parseUnits('1', 8));
			expect(totalMint).to.be.equal(ethers.parseEther('45000'));
		});

		it('scales linearly with amount', async function () {
			const a1 = ethers.parseEther('100000');
			const a2 = ethers.parseEther('200000');
			const [c1] = await flashloan.requiredCollateral(SOURCE_POSITION, a1);
			const [c2] = await flashloan.requiredCollateral(SOURCE_POSITION, a2);

			// c2 should be exactly 2× c1 (ceiling math may differ by 1 wei)
			expect(c2).to.be.closeTo(c1 * 2n, 1n);
		});
	});

	// ── Source position sanity ─────────────────────────────────────────────────

	describe('Source position on-chain data', function () {
		it('prints position parameters and computes minimum loan amount', async function () {
			const price = BigInt(await sourcePos.price());
			const reservePPM = await sourcePos.reserveContribution();
			const available = await sourcePos.availableForMinting();
			const minColl = BigInt(await sourcePos.minimumCollateral());
			const expiration = await sourcePos.expiration();
			const collAddr = await sourcePos.collateral();

			const collToken = await ethers.getContractAt(erc20Abi, collAddr);
			const digits = await collToken.decimals(); // e.g. 8 for cbBTC
			const symbol = await collToken.symbol();

			// price is stored as ZCHF-wei per collateral-wei.
			// Human price (ZCHF per 1 full token) = price / 10^(36 − collDecimals)
			// because: 1 full token = 10^collDecimals units, and ZCHF has 18 decimals.
			const humanPrice = ethers.formatUnits(price, 36 - Number(digits));

			// Minimum ZCHF to satisfy hub.clone() minimumCollateral:
			//   minAmount = ceil(minColl × price × (1e6 − reservePPM) / 1e24)
			const minAmount = (minColl * price * (1_000_000n - BigInt(reservePPM)) + 10n ** 24n - 1n) / 10n ** 24n;

			console.log('  collateral      :', collAddr, `(${symbol}, ${digits} dec)`);
			console.log('  price           :', humanPrice, `ZCHF/${symbol}`);
			console.log('  reservePPM      :', reservePPM.toString(), 'ppm');
			console.log('  availableForMint:', ethers.formatEther(available), 'ZCHF');
			console.log('  minimumCollat   :', ethers.formatUnits(minColl, digits), symbol);
			console.log('  minLoanAmount   :', ethers.formatEther(minAmount), 'ZCHF');
			console.log('  expiration      :', new Date(Number(expiration) * 1000).toISOString());

			expect(price).to.be.gt(0n);
			expect(available).to.be.gt(0n);
		});
	});

	// ── Shared helper: compute min viable loan amount from on-chain state ──────

	// Returns the minimum ZCHF amount whose required collateral clears the position's
	// minimumCollateral floor, scaled by `multiplier` for headroom.
	// Inverse of: collNeeded = ceil(amount × 1e18 × 1e6 / (price × (1e6 − reservePPM)))
	// → minAmount = ceil(minColl × price × (1e6 − reservePPM) / 1e24)
	async function minViableAmount(multiplier = 10n): Promise<bigint> {
		const price = BigInt(await sourcePos.price());
		const reservePPM = BigInt(await sourcePos.reserveContribution());
		const minColl = BigInt(await sourcePos.minimumCollateral());
		const numerator = minColl * price * (1_000_000n - reservePPM);
		const divisor = 10n ** 24n;
		const minAmount = (numerator + divisor - 1n) / divisor;
		return minAmount * multiplier;
	}

	// ── flashloan() — happy path ───────────────────────────────────────────────

	describe('flashloan() — happy path', function () {
		it('reverts with ZeroPriceOrAmount on zero amount', async function () {
			await expect(recipient.trigger(SOURCE_POSITION, 0n, '0x')).to.be.revertedWithCustomError(
				flashloan,
				'ZeroPriceOrAmount'
			);
		});

		it('executes a flash loan, recipient callback fires with correct data', async function () {
			const amount = parseEther('36000');
			const available = await sourcePos.availableForMinting();

			console.log('  loan amount used:', ethers.formatEther(amount), 'ZCHF');

			if (available < amount) {
				console.log('  SKIP: source has insufficient minting capacity for this block');
				this.skip();
			}

			const flashAddr = await flashloan.getAddress();
			const recipientAddr = await recipient.getAddress();

			const tx = await recipient.trigger(SOURCE_POSITION, amount, '0xdeadbeef');
			const receipt = await tx.wait();

			await expect(tx).to.emit(recipient, 'FlashloanReceived').withArgs(flashAddr, amount, '0xdeadbeef');

			const [collNeeded] = await flashloan.requiredCollateral(SOURCE_POSITION, amount);
			await expect(tx)
				.to.emit(flashloan, 'Flashloan')
				.withArgs(SOURCE_POSITION, recipientAddr, await sourcePos.collateral(), collNeeded, amount);

			expect(await zchf.balanceOf(flashAddr)).to.equal(0n);

			console.log('  gas used:', receipt!.gasUsed.toString());
		});
	});

	// ── flashloan() — error cases ──────────────────────────────────────────────

	describe('flashloan() — error cases', function () {
		it('reverts NotMorpho if onMorphoFlashLoan called directly', async function () {
			await expect(flashloan.onMorphoFlashLoan(0n, '0x')).to.be.revertedWithCustomError(flashloan, 'NotMorpho');
		});

		it('reverts if callback caller is not the registered flashloan contract', async function () {
			// Call onFrankencoinFlashloan directly from an EOA — not the stored flashloan address
			await expect(recipient.onFrankencoinFlashloan(0n, '0x')).to.be.revertedWith('unauthorized');
		});
	});

	// ── Multi-loan ─────────────────────────────────────────────────────────────

	describe('multiple sequential flash loans', function () {
		it('two sequential flash loans both succeed', async function () {
			const amount = await minViableAmount(10n);
			const available = await sourcePos.availableForMinting();

			if (available < amount * 2n) {
				this.skip();
			}

			const flashAddr = await flashloan.getAddress();

			const tx1 = await recipient.trigger(SOURCE_POSITION, amount, '0x01');
			const tx2 = await recipient.trigger(SOURCE_POSITION, amount, '0x02');

			await expect(tx1).to.emit(recipient, 'FlashloanReceived').withArgs(flashAddr, amount, '0x01');
			await expect(tx2).to.emit(recipient, 'FlashloanReceived').withArgs(flashAddr, amount, '0x02');
		});
	});
});
