import { expect } from 'chai';
import { ethers } from 'hardhat';
import { RollerPositionV2, IPositionV2, AuthorizePositionV2, IERC20 } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('RollerPositionV2', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const MORPHO_ADDR = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const HUB_V2_ADDR = '0xDe12B620A8a714476A97EfD14E6F7180Ca653557';

	const SENDER = '0x8CF43c9490f26cCc6E9B65EfEf62378Bb5AeB9eE'; // Gnosis Safe — vault owner
	const VAULT_ADDR = '0xc2fe1047AC94b490EEea26db39BEF64671EFD930';
	const SOURCE_ADDR = '0x8179Ce869e68691f1169dE3Fd7DfF14A70f7Fd0C';
	const TARGET_ADDR = '0xF7010368decaD9C8A3dE31212322D1bd3cf26e7D'; // higher price

	const ZCHF_WHALE = '0x9642b23Ed1E01Df1092B92641051881a322F5D4E';

	const FORK_BLOCK = 25344022;
	const END_OF_Q3_2026 = 1790812799n; // Sep 30, 2026 23:59:59 UTC
	const VAULT_SEED = ethers.parseEther('10000'); // buffer to cover repayment rounding

	// ── Signers ────────────────────────────────────────────────────────────────

	let user: SignerWithAddress;
	let sender: SignerWithAddress;
	let whale: SignerWithAddress;

	// ── Contracts ──────────────────────────────────────────────────────────────

	let roller: RollerPositionV2;
	let vault: AuthorizePositionV2;
	let zchf: IERC20;
	let sourcePos: IPositionV2;
	let targetPos: IPositionV2;

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

		await user.sendTransaction({ to: SENDER, value: ethers.parseEther('1') });
		await user.sendTransaction({ to: ZCHF_WHALE, value: ethers.parseEther('1') });
		await ethers.provider.send('hardhat_impersonateAccount', [SENDER]);
		await ethers.provider.send('hardhat_impersonateAccount', [ZCHF_WHALE]);
		sender = await ethers.getSigner(SENDER);
		whale = await ethers.getSigner(ZCHF_WHALE);

		zchf = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', ZCHF_ADDR);
		sourcePos = await ethers.getContractAt('IPositionV2', SOURCE_ADDR);
		targetPos = await ethers.getContractAt('IPositionV2', TARGET_ADDR);
		vault = await ethers.getContractAt('AuthorizePositionV2', VAULT_ADDR);

		roller = await ethers.deployContract('RollerPositionV2', [MORPHO_ADDR, ZCHF_ADDR, HUB_V2_ADDR]);

		console.log('\n=== RollerPositionV2 fork setup ===');
		console.log('Block           :', FORK_BLOCK);
		console.log('Roller          :', await roller.getAddress());
		console.log('Vault owner     :', await vault.owner());
		console.log('Source owner    :', await sourcePos.owner());
		console.log('Source minted   :', ethers.formatEther(await sourcePos.minted()), 'ZCHF');
		console.log('Source coll     :', await sourcePos.collateral());
		console.log('Source price    :', ethers.formatEther(await sourcePos.price()));
		console.log('Target price    :', ethers.formatEther(await targetPos.price()));
		console.log('Source expiry   :', new Date(Number(await sourcePos.expiration()) * 1000).toISOString());
		console.log('Target expiry   :', new Date(Number(await targetPos.expiration()) * 1000).toISOString());
		console.log('Roll expiry     :', new Date(Number(END_OF_Q3_2026) * 1000).toISOString());
	});

	// ── Setup state ────────────────────────────────────────────────────────────

	describe('Setup', function () {
		it('vault owner is sender', async function () {
			expect(await vault.owner()).to.equal(SENDER);
		});

		it('source is owned by vault', async function () {
			expect(await sourcePos.owner()).to.equal(VAULT_ADDR);
		});

		it('source is not closed', async function () {
			expect(await sourcePos.isClosed()).to.be.false;
		});

		it('source has minted > 0', async function () {
			expect(await sourcePos.minted()).to.be.gt(0n);
		});
	});

	// ── Access control ─────────────────────────────────────────────────────────

	describe('Access control', function () {
		it('reverts NotMorpho when onMorphoFlashLoan called directly', async function () {
			await expect(roller.connect(user).onMorphoFlashLoan(0n, '0x')).to.be.revertedWithCustomError(
				roller,
				'NotMorpho'
			);
		});

		it('reverts NotOwner when caller is not vault owner', async function () {
			await expect(
				roller.connect(user).execute(VAULT_ADDR, SOURCE_ADDR, TARGET_ADDR, END_OF_Q3_2026)
			).to.be.revertedWithCustomError(roller, 'NotOwner');
		});

		it('reverts OwnerMismatch when vault does not own source', async function () {
			const dummyVault = await ethers.deployContract('AuthorizePositionV2', [SENDER]);
			const dummyVaultAddr = await dummyVault.getAddress();
			await expect(
				roller.connect(sender).execute(dummyVaultAddr, SOURCE_ADDR, TARGET_ADDR, END_OF_Q3_2026)
			).to.be.revertedWithCustomError(roller, 'OwnerMismatch');
		});
	});

	// ── execute() ─────────────────────────────────────────────────────────────

	describe('execute()', function () {
		let rollerAddr: string;
		let collateralAddr: string;
		let collateral: IERC20;
		let sourceMintedBefore: bigint;
		let sourceCollBefore: bigint;
		let newPositionAddr: string;
		let executeGas: bigint;

		before(async function () {
			rollerAddr = await roller.getAddress();
			collateralAddr = await sourcePos.collateral();
			collateral = await ethers.getContractAt(
				'@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20',
				collateralAddr
			);
			sourceMintedBefore = await sourcePos.minted();
			sourceCollBefore = await collateral.balanceOf(SOURCE_ADDR);

			// seed vault with ZCHF to cover any rounding shortfall in repayment
			await zchf.connect(whale).transfer(VAULT_ADDR, VAULT_SEED);

			const reservePPM = await sourcePos.reserveContribution();
			const computedRepayment = (sourceMintedBefore * (1_000_000n - BigInt(reservePPM))) / 1_000_000n;
			const vaultZchfBefore = await zchf.balanceOf(VAULT_ADDR);

			console.log('\n=== execute() pre-roll ===');
			console.log('Source minted   :', ethers.formatEther(sourceMintedBefore), 'ZCHF');
			console.log('Reserve PPM     :', reservePPM.toString());
			console.log('Computed repay  :', ethers.formatEther(computedRepayment), 'ZCHF');
			console.log('Vault ZCHF      :', ethers.formatEther(vaultZchfBefore), 'ZCHF');
			console.log('Coll in source  :', sourceCollBefore.toString());

			await vault.connect(sender).setAuthorize(rollerAddr, true);

			const tx = await roller.connect(sender).execute(VAULT_ADDR, SOURCE_ADDR, TARGET_ADDR, END_OF_Q3_2026);
			const receipt = await tx.wait();
			executeGas = receipt!.gasUsed;

			const rolledEvent = receipt!.logs
				.map((log) => {
					try {
						return roller.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'Rolled');

			newPositionAddr = rolledEvent!.args.newPosition;

			await vault.connect(sender).setAuthorize(rollerAddr, false);

			const vaultZchfAfter = await zchf.balanceOf(VAULT_ADDR);

			console.log('\n=== execute() post-roll ===');
			console.log('Gas used        :', executeGas.toString());
			console.log('New position    :', newPositionAddr);
			console.log('Collateral amt  :', rolledEvent!.args.collateral.toString());
			console.log('Repaid (event)  :', ethers.formatEther(rolledEvent!.args.repaid), 'ZCHF');
			console.log('Vault ZCHF      :', ethers.formatEther(vaultZchfAfter), 'ZCHF');
			console.log('Vault ZCHF diff :', ethers.formatEther(vaultZchfAfter - vaultZchfBefore + computedRepayment), 'ZCHF (net vs seed)');
		});

		it('roller is no longer authorized after roll', async function () {
			expect(await vault.isAuthorized(rollerAddr)).to.be.false;
		});

		it('new position address is non-zero', async function () {
			expect(newPositionAddr).to.not.equal(ethers.ZeroAddress);
		});

		it('new position is owned by vault', async function () {
			const newPos = await ethers.getContractAt('IPositionV2', newPositionAddr);
			expect(await newPos.owner()).to.equal(VAULT_ADDR);
		});

		it('new position collateral token matches source', async function () {
			const newPos = await ethers.getContractAt('IPositionV2', newPositionAddr);
			expect(await newPos.collateral()).to.equal(collateralAddr);
		});

		it('new position holds the source collateral balance', async function () {
			const newPosBal = await collateral.balanceOf(newPositionAddr);
			expect(newPosBal).to.equal(sourceCollBefore);
		});

		it('new position expiration matches requested Q3 end', async function () {
			const newPos = await ethers.getContractAt('IPositionV2', newPositionAddr);
			expect(await newPos.expiration()).to.equal(END_OF_Q3_2026);
		});

		it('source position is fully repaid (minted = 0)', async function () {
			expect(await sourcePos.minted()).to.equal(0n);
		});

		it('source position collateral is drained', async function () {
			expect(await collateral.balanceOf(SOURCE_ADDR)).to.equal(0n);
		});

		it('no collateral left in roller', async function () {
			expect(await collateral.balanceOf(rollerAddr)).to.equal(0n);
		});

		it('no ZCHF left in roller', async function () {
			expect(await zchf.balanceOf(rollerAddr)).to.equal(0n);
		});
	});
});
