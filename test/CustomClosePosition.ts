import { expect } from 'chai';
import { ethers } from 'hardhat';
import { CustomClosePosition, IPositionV2, IERC20 } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('CustomClosePosition', function () {
	// ── Mainnet addresses ──────────────────────────────────────────────────────

	const MORPHO_ADDR = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
	const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
	const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
	const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
	const WETH_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // used only for the claimToken dust test

	const OWNER = '0x8CF43c9490f26cCc6E9B65EfEf62378Bb5AeB9eE'; // Gnosis Safe — position owner
	const POSITION_ADDR = '0xA4158e4feF15Bda281695FcAC00BBf095cDA0f9A'; // cbBTC position

	// cbBTC has no direct V3 pool with ZCHF, so route through the deepest verified pools:
	// cbBTC/USDC 0.3% (deepest cbBTC stable pool), USDC/USDT 0.01% (deepest stable pair),
	// USDT/ZCHF 0.01% (~$1.3M TVL, deepest ZCHF pool).
	const SWAP_FEES = [3000, 100, 100];

	const FORK_BLOCK = 25767554;

	// ── Signers ────────────────────────────────────────────────────────────────

	let user: SignerWithAddress;
	let owner: SignerWithAddress;

	// ── Contracts ──────────────────────────────────────────────────────────────

	let closer: CustomClosePosition;
	let position: IPositionV2;
	let collateral: IERC20;
	let zchf: IERC20;

	// ── Shared state ───────────────────────────────────────────────────────────

	let collateralAddr: string;
	let swapTokens: string[];

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
		// @ts-ignore
		zchf = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', ZCHF_ADDR);

		collateralAddr = await position.collateral();
		// @ts-ignore
		collateral = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', collateralAddr);
		swapTokens = [collateralAddr, USDC_ADDR, USDT_ADDR, ZCHF_ADDR];

		closer = await ethers.deployContract('CustomClosePosition', [MORPHO_ADDR, UNISWAP_V3_ROUTER, OWNER]);

		console.log('\n=== CustomClosePosition fork setup ===');
		console.log('Block           :', FORK_BLOCK);
		console.log('Closer          :', await closer.getAddress());
		console.log('Position owner  :', await position.owner());
		console.log('Position minted :', ethers.formatEther(await position.minted()), 'ZCHF');
		console.log('Position coll   :', collateralAddr);
		console.log('Position price  :', await position.price());
	});

	// ── Setup state ────────────────────────────────────────────────────────────

	describe('Setup', function () {
		it('closer owner is OWNER', async function () {
			expect(await closer.owner()).to.equal(OWNER);
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
	});

	// ── Access control ─────────────────────────────────────────────────────────

	describe('Access control', function () {
		it('reverts NotMorpho when onMorphoFlashLoan called directly', async function () {
			await expect(closer.connect(user).onMorphoFlashLoan(0n, '0x')).to.be.revertedWithCustomError(
				closer,
				'NotMorpho'
			);
		});

		it('reverts Ownable: not owner when execute called by a non-owner', async function () {
			await expect(
				closer.connect(user).execute(POSITION_ADDR, swapTokens, SWAP_FEES, 0n)
			).to.be.revertedWithCustomError(closer, 'OwnableUnauthorizedAccount');
		});

		it('reverts WrongInputToken when first swap token is not the collateral', async function () {
			await expect(
				closer.connect(owner).execute(POSITION_ADDR, [ZCHF_ADDR, WETH_ADDR], SWAP_FEES.slice(0, 1), 0n)
			).to.be.revertedWithCustomError(closer, 'WrongInputToken');
		});

		it('reverts AmountInMaximumExceedsFlash when amountInMaximum exceeds the position collateral', async function () {
			const flashAmount = await collateral.balanceOf(POSITION_ADDR);
			await expect(
				closer.connect(owner).execute(POSITION_ADDR, swapTokens, SWAP_FEES, flashAmount + 1n)
			).to.be.revertedWithCustomError(closer, 'AmountInMaximumExceedsFlash');
		});

		it('reverts (Uniswap slippage) when amountInMaximum is too low for the swap', async function () {
			const flashAmount = await collateral.balanceOf(POSITION_ADDR);
			const tooLow = flashAmount / 10n; // far below what the swap actually needs
			await expect(closer.connect(owner).execute(POSITION_ADDR, swapTokens, SWAP_FEES, tooLow)).to.be.reverted;
		});
	});

	// ── Ownership transfer ────────────────────────────────────────────────────

	describe('Ownership transfer', function () {
		it('owner transfers position ownership to the closer contract', async function () {
			const closerAddr = await closer.getAddress();
			await position.connect(owner).transferOwnership(closerAddr);
			expect(await position.owner()).to.equal(closerAddr);
		});
	});

	// ── execute() ─────────────────────────────────────────────────────────────

	describe('execute()', function () {
		let closerAddr: string;
		let mintedBefore: bigint;
		let collBefore: bigint;
		let ownerCollBefore: bigint;
		let debtEvent: bigint;
		let equityEvent: bigint;
		let flashEvent: bigint;

		before(async function () {
			this.timeout(300000); // multi-hop swap through 3 pools can be slow on the forked RPC

			closerAddr = await closer.getAddress();
			mintedBefore = await position.minted();
			collBefore = await collateral.balanceOf(POSITION_ADDR);
			ownerCollBefore = await collateral.balanceOf(OWNER);

			const reservePPM = await position.reserveContribution();
			const computedDebt = (mintedBefore * (1_000_000n - BigInt(reservePPM))) / 1_000_000n;

			console.log('\n=== execute() pre-close ===');
			console.log('Minted          :', ethers.formatEther(mintedBefore), 'ZCHF');
			console.log('Reserve PPM     :', reservePPM.toString());
			console.log('Computed debt   :', ethers.formatEther(computedDebt), 'ZCHF');
			console.log('Coll in position:', collBefore.toString());

			// slippage bound: comfortably above the ~0.2915 cbBTC quoted requirement, but well
			// below the full flash amount, proving the cap is enforced rather than a no-op.
			const amountInMaximum = (collBefore * 80n) / 100n;
			console.log('amountInMaximum :', amountInMaximum.toString());

			const tx = await closer.connect(owner).execute(POSITION_ADDR, swapTokens, SWAP_FEES, amountInMaximum);
			const receipt = await tx.wait();

			const closedEvent = receipt!.logs
				.map((log) => {
					try {
						return closer.interface.parseLog(log);
					} catch {
						return null;
					}
				})
				.find((e) => e?.name === 'Closed');

			flashEvent = closedEvent!.args.flash;
			debtEvent = closedEvent!.args.debt;
			equityEvent = closedEvent!.args.equity;

			console.log('\n=== execute() post-close ===');
			console.log('Gas used        :', receipt!.gasUsed.toString());
			console.log('Flash (event)   :', flashEvent.toString());
			console.log('Debt (event)    :', ethers.formatEther(debtEvent), 'ZCHF');
			console.log('Equity (event)  :', equityEvent.toString());
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

		it('owner received the leftover collateral as equity', async function () {
			const ownerCollAfter = await collateral.balanceOf(OWNER);
			expect(ownerCollAfter - ownerCollBefore).to.equal(equityEvent);
			expect(equityEvent).to.be.gt(0n);
		});

		it('no collateral left in closer', async function () {
			expect(await collateral.balanceOf(closerAddr)).to.equal(0n);
		});

		it('no ZCHF left in closer', async function () {
			expect(await zchf.balanceOf(closerAddr)).to.equal(0n);
		});
	});

	// ── claimOwnership() / claimToken() ───────────────────────────────────────

	describe('claim helpers', function () {
		it('claimOwnership reclaims a target contract to the closer owner', async function () {
			const closerAddr = await closer.getAddress();
			// position is currently owned by the closer contract (never transferred back after close)
			expect(await position.owner()).to.equal(closerAddr);

			await closer.connect(owner).claimOwnership(POSITION_ADDR);
			expect(await position.owner()).to.equal(OWNER);
		});

		it('claimToken sweeps stray tokens to the owner', async function () {
			const closerAddr = await closer.getAddress();
			// @ts-ignore
			const weth = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', WETH_ADDR);
			const wethDeposit = await ethers.getContractAt(['function deposit() payable'], WETH_ADDR);

			const dust = ethers.parseEther('1');
			await wethDeposit.connect(user).deposit({ value: dust });
			await (weth.connect(user) as IERC20).transfer(closerAddr, dust);

			const ownerBalBefore = await weth.balanceOf(OWNER);
			await closer.connect(owner).claimToken(WETH_ADDR);

			expect(await weth.balanceOf(closerAddr)).to.equal(0n);
			expect(await weth.balanceOf(OWNER)).to.equal(ownerBalBefore + dust);
		});
	});
});
