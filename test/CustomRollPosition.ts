import { expect } from 'chai';
import { ethers } from 'hardhat';
import { CustomRollPosition, IPositionV2, IERC20, IMorpho } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('CustomRollPosition', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const MORPHO_ADDR = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
	const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
	const WETH_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // used only for the claimToken dust test

	const OWNER = '0x5261F1EC5d079e3AD2467BDc1F2eaE6Bd815A23E'; // Safe — position owner
	const POSITION_ADDR = '0x3B07CE806dD8e5e83E16F80191633ACe8e4011a7'; // cbBTC position

	// cbBTC/USDT morpho market — 86% LLTV, oracle-backed. Verified at FORK_BLOCK to have
	// collateralToken = cbBTC (the position's collateral) and loanToken = USDT.
	const MARKET_ID = '0x4fe72543c5c95cd6b5f3cb516cd235ba882e2e705fe3424db6f99dfe5811d0d3';

	// single-hop USDT/ZCHF 0.01% pool (~$1.3M TVL, deepest ZCHF pool).
	const SWAP_TOKENS = [USDT_ADDR, ZCHF_ADDR];
	const SWAP_FEES = [100];

	const FORK_BLOCK = 25770132;

	// ── Signers ────────────────────────────────────────────────────────────────

	let user: SignerWithAddress;
	let owner: SignerWithAddress;

	// ── Contracts ──────────────────────────────────────────────────────────────

	let roller: CustomRollPosition;
	let position: IPositionV2;
	let collateral: IERC20;
	let zchf: IERC20;
	let usdt: IERC20;
	let morpho: IMorpho;

	// ── Shared state ───────────────────────────────────────────────────────────

	let collateralAddr: string;
	let rollerAddr: string;

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

		await user.sendTransaction({
			to: OWNER,
			value: ethers.parseEther('1'),
			maxFeePerGas: ethers.parseUnits('500', 'gwei'),
			maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
		});
		await ethers.provider.send('hardhat_impersonateAccount', [OWNER]);
		owner = await ethers.getSigner(OWNER);

		position = await ethers.getContractAt('IPositionV2', POSITION_ADDR);
		morpho = await ethers.getContractAt('IMorpho', MORPHO_ADDR);
		// @ts-ignore
		zchf = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', ZCHF_ADDR);
		// @ts-ignore
		usdt = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', USDT_ADDR);

		collateralAddr = await position.collateral();
		// @ts-ignore
		collateral = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', collateralAddr);

		roller = await ethers.deployContract('CustomRollPosition', [MORPHO_ADDR, UNISWAP_V3_ROUTER, OWNER]);
		rollerAddr = await roller.getAddress();

		console.log('\n=== CustomRollPosition fork setup ===');
		console.log('Block           :', FORK_BLOCK);
		console.log('Roller          :', rollerAddr);
		console.log('Position owner  :', await position.owner());
		console.log('Position minted :', ethers.formatEther(await position.minted()), 'ZCHF');
		console.log('Position coll   :', collateralAddr);
		console.log('Position price  :', await position.price());
	});

	// ── Setup state ────────────────────────────────────────────────────────────

	describe('Setup', function () {
		it('roller owner is OWNER', async function () {
			expect(await roller.owner()).to.equal(OWNER);
		});

		it('position owner is OWNER', async function () {
			expect(await position.owner()).to.equal(OWNER);
		});

		it('position is not closed', async function () {
			expect(await position.isClosed()).to.be.false;
		});

		it('position has minted > 0', async function () {
			expect(await position.minted()).to.be.gt(0n);
		});

		it('market collateralToken is the position collateral and loanToken is USDT', async function () {
			const marketParams = await morpho.idToMarketParams(MARKET_ID);
			expect(marketParams.collateralToken).to.equal(collateralAddr);
			expect(marketParams.loanToken).to.equal(USDT_ADDR);
		});

		it('roller is not yet authorized on morpho for OWNER', async function () {
			expect(await morpho.isAuthorized(OWNER, rollerAddr)).to.be.false;
		});
	});

	// ── Ownership transfer ────────────────────────────────────────────────────

	describe('Ownership transfer', function () {
		it('owner transfers position ownership to the roller contract', async function () {
			await position.connect(owner).transferOwnership(rollerAddr);
			expect(await position.owner()).to.equal(rollerAddr);
		});
	});

	// ── Morpho authorization ──────────────────────────────────────────────────
	// The resulting Morpho position (collateral + debt) is opened directly under OWNER, so the
	// roller contract must be authorized to act on OWNER's behalf for the borrow() call.

	describe('Morpho authorization (grant)', function () {
		it('owner authorizes the roller contract on morpho', async function () {
			await morpho.connect(owner).setAuthorization(rollerAddr, true);
			expect(await morpho.isAuthorized(OWNER, rollerAddr)).to.be.true;
		});
	});

	// ── Access control ─────────────────────────────────────────────────────────
	// Runs with ownership transferred and morpho authorization granted, so each case reverts for
	// its own specific reason rather than being masked by an earlier missing precondition.

	describe('Access control', function () {
		it('reverts NotMorpho when onMorphoFlashLoan called directly', async function () {
			await expect(roller.connect(user).onMorphoFlashLoan(0n, '0x')).to.be.revertedWithCustomError(
				roller,
				'NotMorpho'
			);
		});

		it('reverts Ownable: not owner when execute called by a non-owner', async function () {
			await expect(
				roller.connect(user).execute(POSITION_ADDR, MARKET_ID, 0n, SWAP_TOKENS, SWAP_FEES, 0n)
			).to.be.revertedWithCustomError(roller, 'OwnableUnauthorizedAccount');
		});

		it('reverts WrongInputToken when the market collateralToken does not match the position collateral', async function () {
			const wrongMarket = ethers.ZeroHash;
			await expect(
				roller.connect(owner).execute(POSITION_ADDR, wrongMarket, 0n, SWAP_TOKENS, SWAP_FEES, 0n)
			).to.be.revertedWithCustomError(roller, 'WrongInputToken');
		});

		it('reverts WrongInputToken when the first swap token is not the market loan token', async function () {
			await expect(
				roller.connect(owner).execute(POSITION_ADDR, MARKET_ID, 20_000_000000n, [ZCHF_ADDR, USDT_ADDR], SWAP_FEES, 0n)
			).to.be.revertedWithCustomError(roller, 'WrongInputToken');
		});

		it('reverts AmountInMaximumExceedsBorrow when amountInMaximum exceeds the borrow amount', async function () {
			const borrowAmount = 20_000_000000n; // 20,000 USDT
			await expect(
				roller.connect(owner).execute(POSITION_ADDR, MARKET_ID, borrowAmount, SWAP_TOKENS, SWAP_FEES, borrowAmount + 1n)
			).to.be.revertedWithCustomError(roller, 'AmountInMaximumExceedsBorrow');
		});

		it('reverts (Uniswap slippage) when amountInMaximum is too low for the swap', async function () {
			const tooLow = 1_000_000n; // 1 USDT, far below what the swap actually needs
			await expect(
				roller.connect(owner).execute(POSITION_ADDR, MARKET_ID, 20_000_000000n, SWAP_TOKENS, SWAP_FEES, tooLow)
			).to.be.reverted;
		});
	});

	// ── execute() ─────────────────────────────────────────────────────────────

	describe('execute()', function () {
		let mintedBefore: bigint;
		let collBefore: bigint;
		let debtEvent: bigint;
		let flashEvent: bigint;
		let borrowedEvent: bigint;
		let repaidEvent: bigint;
		let marketEvent: string;
		let ownerUsdtBefore: bigint;

		// 28,828 ZCHF debt at ~1.233 USDT/ZCHF spot price needs ~35,545 USDT. The market's 86%
		// LLTV caps borrowing against the position's ~0.838 cbBTC at ~45,440 USDT, so 40,000 USDT
		// borrowed stays safely under that cap. 38,000 USDT amountInMaximum sits above the quoted
		// requirement but below the borrow amount, proving the cap is enforced.
		const BORROW_AMOUNT = 40_000_000000n; // 40,000 USDT
		const AMOUNT_IN_MAXIMUM = 38_000_000000n; // 38,000 USDT

		before(async function () {
			this.timeout(300000);

			mintedBefore = await position.minted();
			collBefore = await collateral.balanceOf(POSITION_ADDR);
			ownerUsdtBefore = await usdt.balanceOf(OWNER);

			const reservePPM = await position.reserveContribution();
			const computedDebt = (mintedBefore * (1_000_000n - BigInt(reservePPM))) / 1_000_000n;

			console.log('\n=== execute() pre-roll ===');
			console.log('Minted          :', ethers.formatEther(mintedBefore), 'ZCHF');
			console.log('Reserve PPM     :', reservePPM.toString());
			console.log('Computed debt   :', ethers.formatEther(computedDebt), 'ZCHF');
			console.log('Coll in position:', collBefore.toString());
			console.log('Borrow amount   :', ethers.formatUnits(BORROW_AMOUNT, 6), 'USDT');
			console.log('amountInMaximum :', ethers.formatUnits(AMOUNT_IN_MAXIMUM, 6), 'USDT');

			const tx = await roller
				.connect(owner)
				.execute(POSITION_ADDR, MARKET_ID, BORROW_AMOUNT, SWAP_TOKENS, SWAP_FEES, AMOUNT_IN_MAXIMUM);
			const receipt = await tx.wait();

			const rolledEvent = receipt!.logs
				.map((log) => {
					try {
						return roller.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'Rolled');

			marketEvent = rolledEvent!.args.market;
			flashEvent = rolledEvent!.args.flash;
			debtEvent = rolledEvent!.args.debt;
			borrowedEvent = rolledEvent!.args.borrowed;
			repaidEvent = rolledEvent!.args.repaid;

			console.log('\n=== execute() post-roll ===');
			console.log('Gas used        :', receipt!.gasUsed.toString());
			console.log('Flash (event)   :', flashEvent.toString());
			console.log('Debt (event)    :', ethers.formatEther(debtEvent), 'ZCHF');
			console.log('Borrowed (event):', ethers.formatUnits(borrowedEvent, 6), 'USDT');
			console.log('Repaid (event)  :', ethers.formatUnits(repaidEvent, 6), 'USDT');
		});

		it('position is fully repaid (minted = 0)', async function () {
			expect(await position.minted()).to.equal(0n);
		});

		it('position collateral is drained', async function () {
			expect(await collateral.balanceOf(POSITION_ADDR)).to.equal(0n);
		});

		it('flash amount matches the collateral that was in the position', async function () {
			expect(flashEvent).to.equal(collBefore);
		});

		it('debt matches minted minus reserve contribution', async function () {
			const reservePPM = await position.reserveContribution();
			const computedDebt = (mintedBefore * (1_000_000n - BigInt(reservePPM))) / 1_000_000n;
			expect(debtEvent).to.equal(computedDebt);
		});

		it('borrowed amount matches the requested borrow amount', async function () {
			expect(borrowedEvent).to.equal(BORROW_AMOUNT);
		});

		it('the rolled-into morpho market matches MARKET_ID', async function () {
			expect(marketEvent.toLowerCase()).to.equal(MARKET_ID.toLowerCase());
		});

		it('OWNER now holds the morpho position: collateral supplied == flash amount, debt borrowed', async function () {
			const p = await morpho.position(MARKET_ID, OWNER);
			expect(p.collateral).to.equal(collBefore);
			expect(p.borrowShares).to.be.gt(0n);
		});

		it('the roller contract holds no morpho position of its own', async function () {
			const p = await morpho.position(MARKET_ID, rollerAddr);
			expect(p.collateral).to.equal(0n);
			expect(p.borrowShares).to.equal(0n);
		});

		it('no collateral left in roller', async function () {
			expect(await collateral.balanceOf(rollerAddr)).to.equal(0n);
		});

		it('no ZCHF left in roller', async function () {
			expect(await zchf.balanceOf(rollerAddr)).to.equal(0n);
		});

		it('no USDT left in roller — leftover was repaid to morpho during the swap', async function () {
			expect(await usdt.balanceOf(rollerAddr)).to.equal(0n);
		});

		it('owner USDT balance is unchanged — leftover went to morpho, not the owner', async function () {
			expect(await usdt.balanceOf(OWNER)).to.equal(ownerUsdtBefore);
		});

		it('the net morpho debt equals the borrow amount minus what was repaid', async function () {
			expect(repaidEvent).to.be.gt(0n);
			expect(repaidEvent).to.be.lt(BORROW_AMOUNT);

			const p = await morpho.position(MARKET_ID, OWNER);
			const m = await morpho.market(MARKET_ID);
			// SharesMathLib.toAssetsUp: shares * (totalBorrowAssets + 1) / (totalBorrowShares + 1e6)
			const netDebt = (BigInt(p.borrowShares) * (m.totalBorrowAssets + 1n)) / (m.totalBorrowShares + 1_000_000n) + 1n;
			const expectedNetDebt = BORROW_AMOUNT - repaidEvent;
			expect(netDebt).to.be.closeTo(expectedNetDebt, 2n);
		});
	});

	// ── Morpho authorization (revoke) ─────────────────────────────────────────

	describe('Morpho authorization (revoke)', function () {
		it('owner revokes the roller contract on morpho', async function () {
			await morpho.connect(owner).setAuthorization(rollerAddr, false);
			expect(await morpho.isAuthorized(OWNER, rollerAddr)).to.be.false;
		});
	});

	// ── claimOwnership() / claimToken() ───────────────────────────────────────

	describe('claim helpers', function () {
		it('claimOwnership reclaims a target contract to the roller owner', async function () {
			// position is currently owned by the roller contract (never transferred back after roll)
			expect(await position.owner()).to.equal(rollerAddr);

			await roller.connect(owner).claimOwnership(POSITION_ADDR);
			expect(await position.owner()).to.equal(OWNER);
		});

		it('claimToken sweeps stray tokens to the owner', async function () {
			// @ts-ignore
			const weth = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', WETH_ADDR);
			const wethDeposit = await ethers.getContractAt(['function deposit() payable'], WETH_ADDR);

			const dust = ethers.parseEther('1');
			await wethDeposit.connect(user).deposit({ value: dust });
			await (weth.connect(user) as IERC20).transfer(rollerAddr, dust);

			const ownerBalBefore = await weth.balanceOf(OWNER);
			await roller.connect(owner).claimToken(WETH_ADDR);

			expect(await weth.balanceOf(rollerAddr)).to.equal(0n);
			expect(await weth.balanceOf(OWNER)).to.equal(ownerBalBefore + dust);
		});
	});
});
