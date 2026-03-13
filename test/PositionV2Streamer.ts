import { expect } from 'chai';
import { ethers } from 'hardhat';
import { PositionV2Streamer, IPositionV2 } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { evm_increaseTime, evm_increaseTimeTo } from './helper';

describe('PositionV2Streamer', function () {
	// ----- mainnet addresses -----
	const FRANKENCOIN = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
	const ROLLER_V2 = '0xAD0107D3Da540Fd54b1931735b65110C909ea6B6';

	// Known WBTC positions and their owner
	const POSITION_OWNER = '0xbfE145DcFac110Df1efD27B403Dd68fd2C61494e';
	const SOURCE_POSITION = '0x8b06f67Dd8A1A7B309164A7AF34c08f4693793Df';
	const TARGET_POSITION = '0x1eEd91EeFA0dA607fA32088ad686fb8cA4254804';

	// ----- stream config -----
	const STREAM_REWARD = ethers.parseEther('0.0004');
	const STREAM_THRESHOLD = 1n * 24n * 3600n; // 1 day
	const STREAM_PERIOD = 30n * 24n * 3600n; // 30 days

	let owner: SignerWithAddress;
	let bot: SignerWithAddress;
	let positionOwner: SignerWithAddress;

	let streamer: PositionV2Streamer;

	// ---------------------------------------------------------------------------------------

	before(async function () {
		const alchemyKey = process.env.ALCHEMY_RPC_KEY;
		await ethers.provider.send('hardhat_reset', [
			{
				forking: {
					jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
					blockNumber: 24649553,
				},
			},
		]);

		[owner, bot] = await ethers.getSigners();

		// fund and impersonate the position owner
		await owner.sendTransaction({ to: POSITION_OWNER, value: ethers.parseEther('1') });
		await ethers.provider.send('hardhat_impersonateAccount', [POSITION_OWNER]);
		positionOwner = await ethers.getSigner(POSITION_OWNER);

		// deploy streamer with real rollerV2
		streamer = await ethers.deployContract('PositionV2Streamer', [
			ROLLER_V2,
			owner.address,
			STREAM_REWARD,
			STREAM_THRESHOLD,
			STREAM_PERIOD,
		]);

		// fund streamer with ETH for bot rewards
		await owner.sendTransaction({ to: await streamer.getAddress(), value: ethers.parseEther('1') });

		// transfer only the source position to the streamer
		const streamerAddr = await streamer.getAddress();
		const source = await ethers.getContractAt('Ownable', SOURCE_POSITION);
		await source.connect(positionOwner).transferOwnership(streamerAddr);

		console.log('\n=== PositionV2Streamer fork setup ===');
		console.log('Streamer:', streamerAddr);
		console.log('Roller:', ROLLER_V2);
		console.log('Source position:', SOURCE_POSITION);
		console.log('Target position:', TARGET_POSITION);
	});

	// ---------------------------------------------------------------------------------------

	describe('Deployment', function () {
		it('sets roller to mainnet rollerV2', async function () {
			expect(await streamer.roller()).to.equal(ROLLER_V2);
		});

		it('sets owner', async function () {
			expect(await streamer.owner()).to.equal(owner.address);
		});

		it('sets streamReward', async function () {
			expect(await streamer.streamReward()).to.equal(STREAM_REWARD);
		});

		it('sets streamThreshold', async function () {
			expect(await streamer.streamThreshold()).to.equal(STREAM_THRESHOLD);
		});

		it('sets streamPeriod', async function () {
			expect(await streamer.streamPeriod()).to.equal(STREAM_PERIOD);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('setConfig()', function () {
		it('updates all config in one call', async function () {
			const newReward = ethers.parseEther('0.001');
			const newThreshold = 3n * 24n * 3600n;
			const newPeriod = 60n * 24n * 3600n;

			await expect(streamer.connect(owner).setConfig(newReward, newThreshold, newPeriod))
				.to.emit(streamer, 'SetConfig')
				.withArgs(newReward, newThreshold, newPeriod);

			expect(await streamer.streamReward()).to.equal(newReward);
			expect(await streamer.streamThreshold()).to.equal(newThreshold);
			expect(await streamer.streamPeriod()).to.equal(newPeriod);

			// restore
			await streamer.connect(owner).setConfig(STREAM_REWARD, STREAM_THRESHOLD, STREAM_PERIOD);
		});

		it('non-owner reverts', async function () {
			await expect(streamer.connect(bot).setConfig(0n, 0n, 0n)).to.be.revertedWithCustomError(
				streamer,
				'OwnableUnauthorizedAccount'
			);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('setWhitelistTarget()', function () {
		it('owner can whitelist a target position', async function () {
			await expect(streamer.connect(owner).setWhitelistTarget(TARGET_POSITION, true))
				.to.emit(streamer, 'SetWhitelistTarget')
				.withArgs(TARGET_POSITION, true);
			expect(await streamer.whitelistedTargets(TARGET_POSITION)).to.equal(true);
		});

		it('owner can delist a target', async function () {
			await streamer.connect(owner).setWhitelistTarget(TARGET_POSITION, false);
			expect(await streamer.whitelistedTargets(TARGET_POSITION)).to.equal(false);
			// restore
			await streamer.connect(owner).setWhitelistTarget(TARGET_POSITION, true);
		});

		it('non-owner reverts', async function () {
			await expect(streamer.connect(bot).setWhitelistTarget(TARGET_POSITION, true)).to.be.revertedWithCustomError(
				streamer,
				'OwnableUnauthorizedAccount'
			);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('execute()', function () {
		it('owner can call arbitrary contract via execute', async function () {
			const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
			const data = iface.encodeFunctionData('balanceOf', [await streamer.getAddress()]);
			const action = { to: FRANKENCOIN, value: 0n, data };

			const [results] = await streamer.connect(owner).execute.staticCall([action], 0n);
			const [balance] = iface.decodeFunctionResult('balanceOf', results[0]);
			expect(balance).to.be.gte(0n);
		});

		it('owner can manually roll a position via execute', async function () {
			const collateralAddr = await new ethers.Contract(
				SOURCE_POSITION,
				['function collateral() view returns (address)'],
				ethers.provider
			).collateral();

			const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
			const rollerIface = new ethers.Interface(['function rollFullyWithExpiration(address,address,uint40) external']);

			const streamPeriod = await streamer.streamPeriod();
			const block = await ethers.provider.getBlock('latest');
			const newExpiration = BigInt(block!.timestamp) + streamPeriod;

			const actions = [
				{
					to: collateralAddr,
					value: 0n,
					data: approveIface.encodeFunctionData('approve', [ROLLER_V2, ethers.MaxUint256]),
				},
				{
					to: ROLLER_V2,
					value: 0n,
					data: rollerIface.encodeFunctionData('rollFullyWithExpiration', [SOURCE_POSITION, TARGET_POSITION, newExpiration]),
				},
			];

			await expect(streamer.connect(owner).execute.staticCall(actions, 0n)).to.not.be.rejected;
		});

		it('non-owner reverts', async function () {
			await expect(streamer.connect(bot).execute([], 0n)).to.be.revertedWithCustomError(
				streamer,
				'OwnableUnauthorizedAccount'
			);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('stream()', function () {
		it('reverts with TargetNotWhitelisted for unknown target', async function () {
			await expect(
				streamer.connect(bot).stream(SOURCE_POSITION, ethers.ZeroAddress)
			).to.be.revertedWithCustomError(streamer, 'TargetNotWhitelisted');
		});

		it('reverts with TooEarlyToStream if still outside threshold', async function () {
			// At fork block time SOURCE_POSITION expiration is well beyond the threshold window
			await expect(streamer.connect(bot).stream(SOURCE_POSITION, TARGET_POSITION)).to.be.revertedWithCustomError(
				streamer,
				'TooEarlyToStream'
			);
		});

		it('bot receives ETH reward and Streamed event emits', async function () {
			// time-warp to put source within the threshold window
			const source = await ethers.getContractAt('IPositionV2', SOURCE_POSITION);
			const sourceExpiration = await source.expiration();
			const threshold = await streamer.streamThreshold();

			await evm_increaseTimeTo(Number(sourceExpiration) - Number(threshold) + 100);

			const botBalanceBefore = await ethers.provider.getBalance(bot.address);
			const tx = await streamer.connect(bot).stream(SOURCE_POSITION, TARGET_POSITION);
			const receipt = await tx.wait();
			const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
			const botBalanceAfter = await ethers.provider.getBalance(bot.address);

			await expect(tx)
				.to.emit(streamer, 'Streamed')
				.withArgs(bot.address, SOURCE_POSITION, TARGET_POSITION, STREAM_REWARD);

			expect(botBalanceAfter - botBalanceBefore + gasUsed).to.equal(STREAM_REWARD);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('withdrawETH()', function () {
		it('owner can withdraw ETH', async function () {
			const amount = ethers.parseEther('0.1');
			const balanceBefore = await ethers.provider.getBalance(owner.address);
			const tx = await streamer.connect(owner).withdrawETH(owner.address, amount);
			const receipt = await tx.wait();
			const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
			const balanceAfter = await ethers.provider.getBalance(owner.address);
			expect(balanceAfter - balanceBefore + gasUsed).to.equal(amount);
		});

		it('non-owner reverts', async function () {
			await expect(streamer.connect(bot).withdrawETH(bot.address, 1n)).to.be.revertedWithCustomError(
				streamer,
				'OwnableUnauthorizedAccount'
			);
		});
	});
});
