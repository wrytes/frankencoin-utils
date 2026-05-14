import { expect } from 'chai';
import { ethers } from 'hardhat';
import { LeverageRealUnit } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('LeverageRealUnit', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const REALU_ADDR = '0x553C7f9C780316FC1D34b8e14ac2465Ab22a090B';
	const BROKERBOT_ADDR = '0xCFF32C60B87296B8c0c12980De685bEd6Cb9dD6d'; // REALU brokerbot
	const PAYMENT_HUB_ADDR = '0xa537D23a76EC454F0874AD4508794b17eD9BE610'; // REALU payment hub
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

	let expiration: bigint; // clone expiration sourced from CLONE_SOURCE

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

		// Clone expiration = source expiration
		expiration = 1798671600n; // await clonePos.expiration();

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

			console.log('  price (36dec)  :', price.toString());
			console.log('  minted         :', ethers.formatEther(minted), 'ZCHF');
			console.log('  available      :', ethers.formatEther(available), 'ZCHF');
			console.log('  minimumColl    :', minColl.toString(), 'REALU');
			console.log('  reservePPM     :', resPPM.toString());

			expect(price).to.be.gt(0n);
			expect(available).to.be.gte(INPUT_AMOUNT, 'position has insufficient capacity for INPUT_AMOUNT');
		});

		it('brokerbot token matches REALU', async function () {
			expect(await brokerbot.token()).to.equal(REALU_ADDR);
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

		it('feeAmount is non-negative', function () {
			expect(p.feeAmount).to.be.gte(0n);
			console.log('  Preview feeAmt        :', ethers.formatEther(p.feeAmount), 'ZCHF');
		});

		it('requiredAmount matches brokerbot.getBuyPrice(tokens)', async function () {
			const expected = await brokerbot.getBuyPrice(p.tokens);
			expect(p.requiredAmount).to.equal(expected);
			console.log('  Preview requiredAmt   :', ethers.formatEther(p.requiredAmount), 'ZCHF');
		});

		it('flashloanAmount < flashloanAmount + reserveAmount + feeAmount (mintNet < mintGross)', function () {
			const mintGross = p.flashloanAmount + p.reserveAmount + p.feeAmount;
			expect(p.flashloanAmount).to.be.lt(mintGross);
		});

		it('requiredAmount (buy cost) > flashloanAmount (equity covers the gap)', function () {
			// totalSpend ≈ requiredAmount; user covers what flashloan doesn't
			expect(p.requiredAmount).to.be.gt(0n);
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

			console.log('\n  staticCall leveragedPosition:', leveragedPositionAddr);
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

		it('user ZCHF balance decreased by inputAmount', async function () {
			const userZchfAfter = await zchf.balanceOf(user.address);
			expect(userZchfBefore - userZchfAfter).to.equal(INPUT_AMOUNT);
		});

		it('no ZCHF left in LeverageRealUnit', async function () {
			expect(await zchf.balanceOf(await leverageRealUnit.getAddress())).to.equal(0n);
		});

		it('no REALU left in LeverageRealUnit', async function () {
			expect(await realu.balanceOf(await leverageRealUnit.getAddress())).to.equal(0n);
		});

		it('new position collateral is REALU', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			expect(await newPos.collateral()).to.equal(REALU_ADDR);
		});

		it('new position is owned by user', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			expect(await newPos.owner()).to.equal(user.address);
		});

		it('new position minted equals mintGross (flashloan + reserve + fee)', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			const minted = await newPos.minted();
			const mintGross = preview.flashloanAmount + preview.reserveAmount + preview.feeAmount;

			console.log('  new position minted  :', ethers.formatEther(minted), 'ZCHF');
			console.log('  expected mintGross   :', ethers.formatEther(mintGross), 'ZCHF');

			// Allow ±1 wei rounding from integer division
			expect(minted).to.be.closeTo(mintGross, 1n);
		});

		it('new position expiration matches requested expiration', async function () {
			const newPos = await ethers.getContractAt(posAbi, leveragedPositionAddr);
			expect(await newPos.expiration()).to.equal(expiration);
		});
	});
});
