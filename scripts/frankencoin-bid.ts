import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { BidderMorphoV2OwnableABI } from '../exports/abis/BidderMorphoV2Ownable';

dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TITAN_RPC = 'https://rpc.titanbuilder.xyz';

// BidderMorphoV2Sender deployment
const FLASH_BIDDER = '0x49b98e9d1a7dc863d3dbe457dc26ed713d7a9a31';

// Challenge number on MintingHubV2
const CHALLENGE_INDEX = 6;

// Max collateral size to bid (0 = full challenge size)
const AMOUNT = 2_000_000_000_000_000_000n; // 2 WETH in wei

// Uniswap V3 path: WETH -[100bps]-> USDT -[100bps]-> ZCHF
// Encoding: token(20) | fee(3) | token(20) | fee(3) | token(20)
const PATH =
	'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000064dac17f958d2ee523a2206206994597c13d831ec7000064b58e61c3098d85632df34eecfb899a1ed80921cb';

// Unix timestamp when the auction price hits your target.
// The script calculates the block number from this — run it ~1 block (~12s) before.
const TARGET_TIMESTAMP = 1779308465; // Wed May 20 2026 20:21:05 UTC

// Ethereum average block time in seconds
const BLOCK_TIME = 12;

// Priority fee paid to Titan as the block builder.
// 1–2 gwei = normal inclusion, 5 gwei = strong, 10+ gwei = aggressive.
// For a time-critical auction block, 5–10 gwei is recommended.
const PRIORITY_FEE = ethers.parseUnits('5', 'gwei');

// Stable UUID for this bundle — used to replace or cancel after submission.
// Keep this fixed per auction. To cancel: yarn frankencoin:cancel <uuid>
export const BUNDLE_UUID = 'frankencoin-bid-challenge-6';

// ─────────────────────────────────────────────────────────────────────────────

const IFACE = new ethers.Interface(BidderMorphoV2OwnableABI);

async function main() {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

	const alchemy = process.env.ALCHEMY_RPC_KEY;
	if (!alchemy) throw new Error('ALCHEMY_RPC_KEY not set in .env');

	const provider = new ethers.JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${alchemy}`);
	const signer = new ethers.Wallet(privateKey, provider);

	// Fetch latest block to anchor block number ↔ timestamp
	const latestBlock = await provider.getBlock('latest');
	if (!latestBlock) throw new Error('Could not fetch latest block');

	const currentBlock = latestBlock.number;
	const currentTimestamp = latestBlock.timestamp;

	const secondsUntilTarget = TARGET_TIMESTAMP - currentTimestamp;
	const blocksUntilTarget = Math.ceil(secondsUntilTarget / BLOCK_TIME);
	const targetBlock = currentBlock + blocksUntilTarget;
	const blockNumberHex = '0x' + targetBlock.toString(16);

	const [nonce, feeData, balance] = await Promise.all([
		provider.getTransactionCount(signer.address),
		provider.getFeeData(),
		provider.getBalance(signer.address),
	]);

	const calldata = IFACE.encodeFunctionData('execute', [CHALLENGE_INDEX, AMOUNT, PATH]);

	const tx: ethers.TransactionRequest = {
		to: FLASH_BIDDER,
		value: 0n,
		data: calldata,
		gasLimit: 600_000n,
		nonce,
		chainId: 1n,
		maxFeePerGas: (feeData.maxFeePerGas ?? 0n) + PRIORITY_FEE,
		maxPriorityFeePerGas: PRIORITY_FEE,
		type: 2,
	};

	const signedTx = await signer.signTransaction(tx);

	const targetDate = new Date(TARGET_TIMESTAMP * 1000).toUTCString();

	console.log('─── Frankencoin Private Bid ──────────────────────────────────');
	console.log('Wallet:         ', signer.address, `(${ethers.formatEther(balance)} ETH)`);
	console.log('Bundle UUID:    ', BUNDLE_UUID);
	console.log('FlashBidder:    ', FLASH_BIDDER);
	console.log('Challenge:      ', CHALLENGE_INDEX);
	console.log('Amount:         ', ethers.formatEther(AMOUNT), 'WETH');
	console.log('Path:            WETH → USDT → ZCHF (0.01% / 0.01%)');
	console.log('Priority fee:   ', ethers.formatUnits(PRIORITY_FEE, 'gwei'), 'gwei');
	console.log('─────────────────────────────────────────────────────────────');
	console.log('Target time:    ', targetDate);
	console.log('Current block:  ', currentBlock, `(t=${currentTimestamp})`);
	console.log('Δ seconds:      ', secondsUntilTarget, `(~${blocksUntilTarget} blocks)`);
	console.log('Target block:   ', targetBlock, `(${blockNumberHex})`);
	console.log('─────────────────────────────────────────────────────────────');

	if (secondsUntilTarget < 0) {
		console.error('ERROR: Target timestamp is in the past. Check TARGET_TIMESTAMP.');
		process.exit(1);
	}

	if (secondsUntilTarget > 120) {
		console.warn(
			`WARN: Target is ${secondsUntilTarget}s away. Run again ~1 block before the auction opens for the most accurate block number.`
		);
	}

	const payload = {
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_sendBundle',
		params: [
			{
				txs: [signedTx],
				blockNumber: blockNumberHex,
				replacementUuid: BUNDLE_UUID,
			},
		],
	};

	console.log('\nSubmitting to Titan...');
	return;

	const res = await fetch(TITAN_RPC, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	const result = (await res.json()) as { result?: { bundleHash: string }; error?: unknown };

	if (result.error) {
		console.error('Submission failed:', result.error);
		process.exit(1);
	}

	console.log('Bundle accepted — hash:', result.result?.bundleHash);
	console.log(`Lands in block ${targetBlock} or not at all. Rerun to retry a different block.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
