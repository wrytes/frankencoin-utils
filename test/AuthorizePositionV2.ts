import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AuthorizePositionV2, MockOwnable } from '../typechain';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('AuthorizePositionV2', function () {
	let owner: SignerWithAddress;
	let bot: SignerWithAddress;
	let other: SignerWithAddress;

	let auth: AuthorizePositionV2;

	// ---------------------------------------------------------------------------------------

	before(async function () {
		[owner, bot, other] = await ethers.getSigners();
		auth = await ethers.deployContract('AuthorizePositionV2', [owner.address]);
	});

	// ---------------------------------------------------------------------------------------

	describe('Deployment', function () {
		it('sets owner', async function () {
			expect(await auth.owner()).to.equal(owner.address);
		});

		it('owner is authorized', async function () {
			expect(await auth.isAuthorized(owner.address)).to.be.true;
		});

		it('unknown address is not authorized', async function () {
			expect(await auth.isAuthorized(other.address)).to.be.false;
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('setAuthorize()', function () {
		it('owner can authorize an address', async function () {
			await expect(auth.connect(owner).setAuthorize(bot.address, true))
				.to.emit(auth, 'SetAuthorize')
				.withArgs(bot.address, true);
			expect(await auth.isAuthorized(bot.address)).to.be.true;
		});

		it('owner can revoke authorization', async function () {
			await expect(auth.connect(owner).setAuthorize(bot.address, false))
				.to.emit(auth, 'SetAuthorize')
				.withArgs(bot.address, false);
			expect(await auth.isAuthorized(bot.address)).to.be.false;

			// restore for later tests
			await auth.connect(owner).setAuthorize(bot.address, true);
		});

		it('non-owner reverts', async function () {
			await expect(auth.connect(other).setAuthorize(other.address, true)).to.be.revertedWithCustomError(
				auth,
				'OwnableUnauthorizedAccount'
			);
		});
	});

	// ---------------------------------------------------------------------------------------

	describe('claimOwnership()', function () {
		let mockPosition: MockOwnable;

		before(async function () {
			// deploy a plain Ownable contract as the mock position, owned by owner
			mockPosition = await ethers.deployContract('MockOwnable', [owner.address]);

			// simulate transferring the position into the vault
			const mockOwnable = await ethers.getContractAt('Ownable', await mockPosition.getAddress());
			await mockOwnable.connect(owner).transferOwnership(await auth.getAddress());
		});

		it('vault holds the position after transfer', async function () {
			const mockOwnable = await ethers.getContractAt('Ownable', await mockPosition.getAddress());
			expect(await mockOwnable.owner()).to.equal(await auth.getAddress());
		});

		it('owner can reclaim the position', async function () {
			await auth.connect(owner).claimOwnership(await mockPosition.getAddress());

			const mockOwnable = await ethers.getContractAt('Ownable', await mockPosition.getAddress());
			expect(await mockOwnable.owner()).to.equal(owner.address);
		});

		it('non-owner reverts', async function () {
			await expect(
				auth.connect(other).claimOwnership(await mockPosition.getAddress())
			).to.be.revertedWithCustomError(auth, 'OwnableUnauthorizedAccount');
		});
	});
});
