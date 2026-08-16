/**
 * Script: custom/build-close-position-safe-batch.ts
 *
 * Builds a Safe Transaction Builder batch that, in one atomic tx:
 *   1. CREATE2-deploys CustomClosePosition(morpho, uniswapV3Router, owner = SAFE_ADDR) at a
 *      predicted address.
 *   2. position.transferOwnership(closerAddress) — hands position control to the closer.
 *   3. closer.execute(position, swapTokens, swapFees, amountInMaximum) — flash-loans the
 *      position's collateral from Morpho, swaps just enough into ZCHF via Uniswap V3 (capped by
 *      amountInMaximum) to cover the debt, closes the position (adjust(0, 0, price)), repays the
 *      flash loan, and sends the leftover collateral equity to SAFE_ADDR.
 *
 * Pure offline computation (no RPC/private key needed) — CREATE2 address prediction only
 * depends on factory address, salt, and initcode (bytecode + constructor args).
 *
 * Usage:
 *   npx ts-node scripts/custom/build-close-position-safe-batch.ts
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'; // canonical deterministic-deployment-proxy
const SAFE_ADDR = '0x8CF43c9490f26cCc6E9B65EfEf62378Bb5AeB9eE'; // becomes owner of CustomClosePosition

const MORPHO_ADDR = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const ZCHF_ADDR = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const POSITION_ADDR = '0xA4158e4feF15Bda281695FcAC00BBf095cDA0f9A'; // cbBTC position
const COLLATERAL_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'; // cbBTC — position.collateral()

// cbBTC has no direct V3 pool with ZCHF, so route through the deepest verified pools:
// cbBTC/USDC 0.3%, USDC/USDT 0.01%, USDT/ZCHF 0.01% (~$1.3M TVL, deepest ZCHF pool).
const SWAP_TOKENS = [COLLATERAL_ADDR, USDC_ADDR, USDT_ADDR, ZCHF_ADDR];
const SWAP_FEES = [3000, 100, 100];

// Slippage bound for the exact-output swap, in cbBTC (8 decimals). QuoterV2 quoted ~0.29147714
// cbBTC needed to cover the debt at the time this script was written; this adds a ~6% buffer.
// RE-QUOTE BEFORE SUBMITTING if pool prices or the position's minted/debt have since moved —
// too tight and the tx reverts, too loose and it offers little real slippage protection.
const AMOUNT_IN_MAXIMUM = 30_000_000n; // 0.30 cbBTC

const OUT_PATH = 'scripts/custom/close-position-safe-batch.json';
const CHAIN_ID = '1'; // mainnet
const SALT = ethers.id(`frankencoin/CustomClosePosition/${POSITION_ADDR}`);

const POSITION_ABI = ['function transferOwnership(address newOwner) external'];
const CLOSER_ABI = [
	'function execute(address position, address[] tokens, uint24[] fees, uint256 amountInMaximum) external',
];

function main() {
	const root = resolve(__dirname, '../..');

	const artifact = JSON.parse(
		readFileSync(join(root, 'artifacts/contracts/custom/CustomClosePosition.sol/CustomClosePosition.json'), 'utf8')
	);
	const bytecode: string = artifact.bytecode;

	const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
		['address', 'address', 'address'],
		[MORPHO_ADDR, UNISWAP_V3_ROUTER, SAFE_ADDR]
	);
	const initCode = ethers.concat([bytecode, constructorArgs]);
	const closerAddr = ethers.getCreate2Address(CREATE2_FACTORY, SALT, ethers.keccak256(initCode));

	const positionInterface = new ethers.Interface(POSITION_ABI);
	const closerInterface = new ethers.Interface(CLOSER_ABI);

	const deployTx = { to: CREATE2_FACTORY, value: '0', data: ethers.concat([SALT, initCode]) };
	const transferOwnershipTx = {
		to: POSITION_ADDR,
		value: '0',
		data: positionInterface.encodeFunctionData('transferOwnership', [closerAddr]),
	};
	const executeTx = {
		to: closerAddr,
		value: '0',
		data: closerInterface.encodeFunctionData('execute', [POSITION_ADDR, SWAP_TOKENS, SWAP_FEES, AMOUNT_IN_MAXIMUM]),
	};

	const batch = {
		version: '1.0',
		chainId: CHAIN_ID,
		createdAt: Date.now(),
		meta: {
			name: 'CustomClosePosition: deploy + transfer ownership + execute',
			description:
				'Deploy CustomClosePosition, hand it ownership of the target position, and close it in one atomic Safe tx.',
			txBuilderVersion: '1.16.5',
			createdFromSafeAddress: SAFE_ADDR,
			createdFromOwnerAddress: '',
		},
		transactions: [deployTx, transferOwnershipTx, executeTx],
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
		closer: closerAddr,
		swapPath: SWAP_TOKENS.join(' -> '),
		swapFees: SWAP_FEES.join(', '),
		amountInMaximum: `${ethers.formatUnits(AMOUNT_IN_MAXIMUM, 8)} cbBTC`,
		out: OUT_PATH,
	});
	console.log('\nImport at https://app.safe.global → this Safe → Transaction Builder → "Upload batch".');
}

main();
