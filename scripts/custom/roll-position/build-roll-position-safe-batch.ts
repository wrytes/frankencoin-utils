/**
 * Script: custom/roll-position/build-roll-position-safe-batch.ts
 *
 * Builds a Safe Transaction Builder batch that, in one atomic tx:
 *   1. CREATE2-deploys CustomRollPosition(morpho, uniswapV3Router, owner = SAFE_ADDR) at a
 *      predicted address.
 *   2. position.transferOwnership(rollerAddress) — hands position control to the roller.
 *   3. morpho.setAuthorization(rollerAddress, true) — lets the roller borrow/open the new Morpho
 *      position on behalf of SAFE_ADDR.
 *   4. roller.execute(position, market, borrowAmount, swapTokens, swapFees, amountInMaximum) —
 *      flash-loans the position's collateral from Morpho, deposits it into `market` as SAFE_ADDR's
 *      collateral, borrows `borrowAmount` of the market's loan token on SAFE_ADDR's behalf, swaps
 *      just enough into the position's debt token via Uniswap V3 (capped by amountInMaximum) to
 *      close the position, repays the flash loan with the collateral the close releases, and repays
 *      any unspent borrowed loan token back to Morpho (reducing SAFE_ADDR's net debt).
 *   5. morpho.setAuthorization(rollerAddress, false) — revokes the roller's authorization again.
 *
 * Pure offline computation (no RPC/private key needed) — CREATE2 address prediction only
 * depends on factory address, salt, and initcode (bytecode + constructor args).
 *
 * Usage:
 *   npx ts-node scripts/custom/roll-position/build-roll-position-safe-batch.ts
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'; // canonical deterministic-deployment-proxy
const SAFE_ADDR = '0x5261F1EC5d079e3AD2467BDc1F2eaE6Bd815A23E'; // becomes owner of CustomRollPosition

const MORPHO_ADDR = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const POSITION_ADDR = '0x3B07CE806dD8e5e83E16F80191633ACe8e4011a7'; // cbBTC position
const COLLATERAL_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'; // cbBTC — position.collateral()

// cbBTC/USDT morpho market — 86% LLTV, oracle-backed. collateralToken = cbBTC, loanToken = USDT.
const MARKET_ID = '0x4fe72543c5c95cd6b5f3cb516cd235ba882e2e705fe3424db6f99dfe5811d0d3';

// single-hop USDT/ZCHF 0.01% pool (deepest ZCHF pool).
const SWAP_TOKENS = [USDT_ADDR, ZCHF_ADDR];
const SWAP_FEES = [100];

// At the time this script was written: minted 36,035 ZCHF (28,828 ZCHF debt after the 20%
// reserve), 0.838 cbBTC collateral, oracle-implied max borrow ~45,440 USDT, spot swap needing
// ~35,545 USDT. 40,000 USDT borrowed stays comfortably under the LLTV cap; 38,000 USDT
// amountInMaximum sits above the quoted requirement but below the borrow amount.
// RE-QUOTE BEFORE SUBMITTING if pool prices, the market's LLTV/oracle price, or the position's
// minted/debt have since moved — too little borrowed and the swap can't cover the debt, too much
// and the new Morpho position risks breaching the market's LLTV.
const BORROW_AMOUNT = 35_600_000000n; // 36,500 USDT — must stay under the market's LLTV cap
const AMOUNT_IN_MAXIMUM = BORROW_AMOUNT; // slippage bound, must be <= BORROW_AMOUNT

const OUT_PATH = 'scripts/custom/roll-position/roll-position-safe-batch.json';
const CHAIN_ID = '1'; // mainnet
const SALT = ethers.id(`frankencoin/CustomRollPosition/${POSITION_ADDR}`);

const POSITION_ABI = ['function transferOwnership(address newOwner) external'];
const MORPHO_ABI = ['function setAuthorization(address authorized, bool newIsAuthorized) external'];
const ROLLER_ABI = [
	'function execute(address position, bytes32 market, uint256 borrowAmount, address[] tokens, uint24[] fees, uint256 amountInMaximum) external',
];

function main() {
	const root = resolve(__dirname, '../../..');

	const artifact = JSON.parse(
		readFileSync(join(root, 'artifacts/contracts/custom/CustomRollPosition.sol/CustomRollPosition.json'), 'utf8')
	);
	const bytecode: string = artifact.bytecode;

	const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
		['address', 'address', 'address'],
		[MORPHO_ADDR, UNISWAP_V3_ROUTER, SAFE_ADDR]
	);
	const initCode = ethers.concat([bytecode, constructorArgs]);
	const rollerAddr = ethers.getCreate2Address(CREATE2_FACTORY, SALT, ethers.keccak256(initCode));

	const positionInterface = new ethers.Interface(POSITION_ABI);
	const morphoInterface = new ethers.Interface(MORPHO_ABI);
	const rollerInterface = new ethers.Interface(ROLLER_ABI);

	const deployTx = { to: CREATE2_FACTORY, value: '0', data: ethers.concat([SALT, initCode]) };
	const transferOwnershipTx = {
		to: POSITION_ADDR,
		value: '0',
		data: positionInterface.encodeFunctionData('transferOwnership', [rollerAddr]),
	};
	const authorizeTx = {
		to: MORPHO_ADDR,
		value: '0',
		data: morphoInterface.encodeFunctionData('setAuthorization', [rollerAddr, true]),
	};
	const executeTx = {
		to: rollerAddr,
		value: '0',
		data: rollerInterface.encodeFunctionData('execute', [
			POSITION_ADDR,
			MARKET_ID,
			BORROW_AMOUNT,
			SWAP_TOKENS,
			SWAP_FEES,
			AMOUNT_IN_MAXIMUM,
		]),
	};
	const deauthorizeTx = {
		to: MORPHO_ADDR,
		value: '0',
		data: morphoInterface.encodeFunctionData('setAuthorization', [rollerAddr, false]),
	};

	const batch = {
		version: '1.0',
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: 'CustomRollPosition: deploy + transfer ownership + authorize + execute + deauthorize',
			description:
				'Deploy CustomRollPosition, hand it ownership of the target position, authorize it on Morpho, roll the position into a Morpho market, and revoke the authorization — all in one atomic Safe tx.',
			txBuilderVersion: '1.16.5',
			createdFromSafeAddress: SAFE_ADDR,
			createdFromOwnerAddress: '',
		},
		transactions: [deployTx, transferOwnershipTx, authorizeTx, executeTx, deauthorizeTx],
	};

	const outFile = join(root, OUT_PATH);
	writeFileSync(outFile, JSON.stringify(batch, null, 2));

	console.log('── Safe batch written ──');
	console.table({
		safe: SAFE_ADDR,
		morpho: MORPHO_ADDR,
		uniswapV3Router: UNISWAP_V3_ROUTER,
		position: POSITION_ADDR,
		collateral: COLLATERAL_ADDR,
		market: MARKET_ID,
		roller: rollerAddr,
		swapPath: SWAP_TOKENS.join(' -> '),
		swapFees: SWAP_FEES.join(', '),
		borrowAmount: `${ethers.formatUnits(BORROW_AMOUNT, 6)} USDT`,
		amountInMaximum: `${ethers.formatUnits(AMOUNT_IN_MAXIMUM, 6)} USDT`,
		out: OUT_PATH,
	});
	console.log('\nImport at https://app.safe.global → this Safe → Transaction Builder → "Upload batch".');
}

main();
