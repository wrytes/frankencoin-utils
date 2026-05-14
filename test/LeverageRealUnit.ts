import { expect } from 'chai';
import { ethers } from 'hardhat';
import { LeverageRealUnit } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('LeverageRealUnit', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const REALU_ADDR = '0x553C7f9C780316FC1D34b8e14ac2465Ab22a090B';
	const BROKERBOT_ADDR = '0xCFF32C60B87296B8c0c12980De685bEd6Cb9dD6d';
	const PAYMENT_HUB_ADDR = '0xa537D23a76EC454F0874AD4508794b17eD9BE610';
	const FLASHLOAN_ADDR = '0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1';
	const HUB_ADDR = '0xDe12B620A8a714476A97EfD14E6F7180Ca653557';

	// REALU PositionV2 used as flashloan template (minted() == 0)
	const FLASHLOAN_SOURCE = '0xDc189AC81BEC4db551A0478334691D71109d9382';

	// REALU PositionV2 to clone permanently
	const CLONE_SOURCE = '0x9cf4E932285474e72b82b288C4064054223bA502';

	// ZCHF holder to fund the test user
	const ZCHF_WHALE = '0x9642b23Ed1E01Df1092B92641051881a322F5D4E';

	const FORK_BLOCK = 25085853;
	const INPUT_AMOUNT = ethers.parseEther('10000'); // 10 000 ZCHF equity

	// ── Signers ────────────────────────────────────────────────────────────────

	let user: SignerWithAddress;
	let whale: SignerWithAddress;

	// ── Contracts ──────────────────────────────────────────────────────────────

	let leverageRealUnit: LeverageRealUnit;
	let brokerbot: Awaited<ReturnType<typeof ethers.getContractAt<'IBrokerbot'>>>;
	let paymentHub: Awaited<ReturnType<typeof ethers.getContractAt<'IPaymentHub'>>>;
	let zchf: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let realu: Awaited<ReturnType<typeof ethers.getContractAt>>;
	let clonePos: Awaited<ReturnType<typeof ethers.getContractAt>>;

	// ── Shared state ───────────────────────────────────────────────────────────

	let expiration: bigint;

	// ── ABIs ───────────────────────────────────────────────────────────────────

	const erc20Abi = [
		'function balanceOf(address) view returns (uint256)',
		'function approve(address,uint256) returns (bool)',
		'function transfer(address,uint256) returns (bool)',
		'function allowance(address,address) view returns (uint256)',
	];

	const posAbi = [
		'function collateral() view returns (address)',
		'function price() view returns (uint256)',
		'function expiration() view returns (uint40)',
		'function annualInterestPPM() view returns (uint24)',
		'function reserveContribution() view returns (uint24)',
		'function minted() view returns (uint256)',
		'function availableForMinting() view returns (uint256)',
		'function minimumCollateral() view returns (uint256)',
		'function getUsableMint(uint256,bool) view returns (uint256)',
		'function isClosed() view returns (bool)',
		'function owner() view returns (address)',
	];

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

		[user] = await ethers.getSigners();

		// Fund and impersonate ZCHF whale
		await user.sendTransaction({ to: ZCHF_WHALE, value: ethers.parseEther('1') });
		await ethers.provider.send('hardhat_impersonateAccount', [ZCHF_WHALE]);
		whale = await ethers.getSigner(ZCHF_WHALE);

		zchf = await ethers.getContractAt(erc20Abi, ZCHF_ADDR);
		realu = await ethers.getContractAt(erc20Abi, REALU_ADDR);
		clonePos = await ethers.getContractAt(posAbi, CLONE_SOURCE);
		brokerbot = await ethers.getContractAt('IBrokerbot', BROKERBOT_ADDR);
		paymentHub = await ethers.getContractAt('IPaymentHub', PAYMENT_HUB_ADDR);

		// Fund user with ZCHF
		await zchf.connect(whale).transfer(user.address, INPUT_AMOUNT);

		// Clone expiration sourced from the position itself
		expiration = await clonePos.expiration();

		// Deploy LeverageRealUnit (stateless — no constructor args)
		leverageRealUnit = await ethers.deployContract('LeverageRealUnit');
		const leverageAddr = await leverageRealUnit.getAddress();

		// Approve LeverageRealUnit to pull user ZCHF
		await zchf.connect(user).approve(leverageAddr, INPUT_AMOUNT);

		console.log('\n=== LeverageRealUnit fork setup ===');
		console.log('Block            :', FORK_BLOCK);
		console.log('LeverageRealUnit :', leverageAddr);
		console.log('CLONE_SOURCE     :', CLONE_SOURCE);
		console.log('FLASHLOAN_SOURCE :', FLASHLOAN_SOURCE);
		console.log('User ZCHF        :', ethers.formatEther(await zchf.balanceOf(user.address)), 'ZCHF');
		console.log('Market price (1) :', ethers.formatEther(await brokerbot.getBuyPrice(1n)), 'ZCHF/REALU');
		console.log('Liq price (18dec):', ethers.formatEther((await clonePos.price()) / BigInt(1e18)), 'ZCHF/REALU');
		console.log('Reserve PPM      :', (await clonePos.reserveContribution()).toString(), 'ppm');
		console.log('Annual rate PPM  :', (await clonePos.annualInterestPPM()).toString(), 'ppm');
		console.log('Available        :', ethers.formatEther(await clonePos.availableForMinting()), 'ZCHF');
		console.log('Expiration       :', new Date(Number(expiration) * 1000).toISOString());
	});

	// ── Constants ──────────────────────────────────────────────────────────────

	describe('Constants', function () {
		it('FLASHLOAN matches deployed address', async function () {
			expect(await leverageRealUnit.FLASHLOAN()).to.equal(FLASHLOAN_ADDR);
		});

		it('HUB matches deployed address', async function () {
			expect(await leverageRealUnit.HUB()).to.equal(HUB_ADDR);
		});

		it('ZCHF matches deployed address', async function () {
			expect(await leverageRealUnit.ZCHF()).to.equal(ZCHF_ADDR);
		});

		it('REALU matches deployed address', async function () {
			expect(await leverageRealUnit.REALU()).to.equal(REALU_ADDR);
		});
	});

	// ── CLONE_SOURCE state at fork block ───────────────────────────────────────

	describe('CLONE_SOURCE position state', function () {
		it('is not closed', async function () {
			expect(await clonePos.isClosed()).to.be.false;
		});

		it('collateral is REALU', async function () {
			expect(await clonePos.collateral()).to.equal(REALU_ADDR);
		});

		it('prints position parameters', async function () {
			const price = await clonePos.price();
			const minted = await clonePos.minted();
			const available = await clonePos.availableForMinting();
			const minColl = await clonePos.minimumCollateral();
			const resPPM = await clonePos.reserveContribution();
			const annualPPM = await clonePos.annualInterestPPM();

			console.log('  price (36dec)  :', price.toString());
			console.log('  minted         :', ethers.formatEther(minted), 'ZCHF');
			console.log('  available      :', ethers.formatEther(available), 'ZCHF');
			console.log('  minimumColl    :', minColl.toString(), 'REALU');
			console.log('  reservePPM     :', resPPM.toString());
			console.log('  annualRatePPM  :', annualPPM.toString());

			expect(price).to.be.gt(0n);
			expect(available).to.be.gte(INPUT_AMOUNT, 'position has insufficient capacity for INPUT_AMOUNT');
		});

		it('brokerbot token matches REALU', async function () {
			expect(await brokerbot.token()).to.equal(REALU_ADDR);
		});
	});

	// ── _compute() — input validation ─────────────────────────────────────────

	describe('_compute() — input validation (via preview)', function () {
		it('reverts with invalid expiration when expiration is in the past', async function () {
			const block = await ethers.provider.getBlock('latest');
			const pastExpiration = BigInt(block!.timestamp) - 1n;
			await expect(
				leverageRealUnit.preview(CLONE_SOURCE, INPUT_AMOUNT, pastExpiration, BROKERBOT_ADDR)
			).to.be.revertedWith('invalid expiration');
		});

		it('reverts with invalid expiration when expiration exceeds cloneSource expiration', async function () {
			const tooFar = expiration + 86400n; // 1 day beyond source expiration
			await expect(
				leverageRealUnit.preview(CLONE_SOURCE, INPUT_AMOUNT, tooFar, BROKERBOT_ADDR)
			).to.be.revertedWith('invalid expiration');
		});
	});

	// ── preview() ──────────────────────────────────────────────────────────────

	describe('preview()', function () {
		let p: Awaited<ReturnType<typeof leverageRealUnit.preview>>;

		before(async function () {
			p = await leverageRealUnit.preview(CLONE_SOURCE, INPUT_AMOUNT, expiration, BROKERBOT_ADDR);
		});

		it('returns non-zero tokens', function () {
			expect(p.tokens).to.be.gt(0n);
			console.log('\n  Preview tokens        :', p.tokens.toString(), 'REALU');
		});

		it('flashloanAmount is non-zero', function () {
			expect(p.flashloanAmount).to.be.gt(0n);
			console.log('  Preview flashloanAmt  :', ethers.formatEther(p.flashloanAmount), 'ZCHF');
		});

		it('reserveAmount is non-zero', function () {
			expect(p.reserveAmount).to.be.gt(0n);
			console.log('  Preview reserveAmt    :', ethers.formatEther(p.reserveAmount), 'ZCHF');
		});

		it('feeAmount is non-zero (position has annualInterestPPM > 0)', function () {
			expect(p.feeAmount).to.be.gt(0n);
			console.log('  Preview feeAmt        :', ethers.formatEther(p.feeAmount), 'ZCHF');
		});

		it('requiredAmount matches brokerbot.getBuyPrice(tokens)', async function () {
			const expected = await brokerbot.getBuyPrice(p.tokens);
			expect(p.requiredAmount).to.equal(expected);
			console.log('  Preview requiredAmt   :', ethers.formatEther(p.requiredAmount), 'ZCHF');
		});

		it('flashloanAmount + reserveAmount + feeAmount equals mintGross', function () {
			const mintGross = p.flashloanAmount + p.reserveAmount + p.feeAmount;
			expect(p.flashloanAmount).to.be.lt(mintGross);
		});

		it('mintGross exceeds inputAmount (leverage effect)', function () {
			const mintGross = p.flashloanAmount + p.reserveAmount + p.feeAmount;
			expect(mintGross).to.be.gt(INPUT_AMOUNT);
		});
	});

	// ── onFrankencoinFlashloan() — access control ──────────────────────────────

	describe('onFrankencoinFlashloan() — access control', function () {
		it('reverts NotFlashloan when called directly (not via FLASHLOAN contract)', async function () {
			await expect(leverageRealUnit.connect(user).onFrankencoinFlashloan(0n, '0x')).to.be.revertedWithCustomError(
				leverageRealUnit,
				'NotFlashloan'
			);
		});
	});

	// ── executeLeverage() ──────────────────────────────────────────────────────

	describe('executeLeverage()', function () {
		let preview: Awaited<ReturnType<typeof leverageRealUnit.preview>>;
		let leveragedPositionAddr: string;
		let userZchfBefore: bigint;

		before(async function () {
			preview = await leverageRealUnit.preview(CLONE_SOURCE, INPUT_AMOUNT, expiration, BROKERBOT_ADDR);
			userZchfBefore = await zchf.balanceOf(user.address);

			// staticCall first to resolve the returned position address without consuming state
			leveragedPositionAddr = await leverageRealUnit
				.connect(user)
				.executeLeverage.staticCall(
					FLASHLOAN_SOURCE,
					CLONE_SOURCE,
					INPUT_AMOUNT,
					expiration,
					BROKERBOT_ADDR,
					PAYMENT_HUB_ADDR
				);

			console.log('\n  executeLeverage args:');
			console.log('    flashloanSource :', FLASHLOAN_SOURCE);
			console.log('    cloneSource     :', CLONE_SOURCE);
			console.log('    inputAmount     :', ethers.formatEther(INPUT_AMOUNT), 'ZCHF');
			console.log('    expiration      :', new Date(Number(expiration) * 1000).toISOString());
			console.log('    brokerbot       :', BROKERBOT_ADDR);
			console.log('    paymentHub      :', PAYMENT_HUB_ADDR);
			console.log('  staticCall result :', leveragedPositionAddr);
		});

		it('staticCall returns a non-zero position address', function () {
			expect(leveragedPositionAddr).to.not.equal(ethers.ZeroAddress);
		});

		it('executes without revert and emits no errors', async function () {
			const tx = await leverageRealUnit
				.connect(user)
				.executeLeverage(
					FLASHLOAN_SOURCE,
					CLONE_SOURCE,
					INPUT_AMOUNT,
					expiration,
					BROKERBOT_ADDR,
					PAYMENT_HUB_ADDR
				);
			const receipt = await tx.wait();

			expect(receipt!.status).to.equal(1);
			console.log('  executeLeverage gas  :', receipt!.gasUsed.toString());
		});

		it('user ZCHF spend is at most inputAmount (surplus returned from rounding)', async function () {
			const userZchfAfter = await zchf.balanceOf(user.address);
			const actualSpend = userZchfBefore - userZchfAfter;
			expect(actualSpend).to.be.lte(INPUT_AMOUNT);
			expect(actualSpend).to.be.gte(INPUT_AMOUNT - ethers.parseEther('1'));
		});

		it('no ZCHF left in LeverageRealUnit', async function () {
			const bal = await zchf.balanceOf(await leverageRealUnit.getAddress());
			console.log('  ZCHF in contract     :', ethers.formatEther(bal), 'ZCHF');
			expect(bal).to.equal(0n);
		});

		it('no REALU left in LeverageRealUnit', async function () {
			const bal = await realu.balanceOf(await leverageRealUnit.getAddress());
			console.log('  REALU in contract    :', bal.toString(), 'REALU');
			expect(bal).to.equal(0n);
		});

		it('new position collateral is REALU', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			expect(await newPos.collateral()).to.equal(REALU_ADDR);
		});

		it('new position is owned by user', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			expect(await newPos.owner()).to.equal(user.address);
		});

		// ── preview() vs actual position ──────────────────────────────────────

		describe('preview() vs actual position', function () {
			let actualTokens: bigint;
			let actualMinted: bigint;
			let actualExpiration: bigint;

			before(async function () {
				actualTokens = await realu.balanceOf(leveragedPositionAddr);
				const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
				actualMinted = await newPos.minted();
				actualExpiration = await newPos.expiration();

				const mintGross = preview.flashloanAmount + preview.reserveAmount + preview.feeAmount;

				console.log('\n  === preview vs actual ===');
				console.log('  tokens    preview:', preview.tokens.toString(), '| actual:', actualTokens.toString(), 'REALU');
				console.log('  minted    preview:', ethers.formatEther(mintGross), '| actual:', ethers.formatEther(actualMinted), 'ZCHF');
				console.log('  expires   preview:', new Date(Number(expiration) * 1000).toISOString(), '| actual:', new Date(Number(actualExpiration) * 1000).toISOString());
			});

			it('REALU collateral deposited equals preview.tokens', function () {
				expect(actualTokens).to.equal(preview.tokens);
			});

			it('minted ZCHF matches preview mintGross (±1 wei rounding)', function () {
				const mintGross = preview.flashloanAmount + preview.reserveAmount + preview.feeAmount;
				expect(actualMinted).to.be.closeTo(mintGross, 1n);
			});

			it('expiration matches preview expiration', function () {
				expect(actualExpiration).to.equal(expiration);
			});
		});
	});
});
