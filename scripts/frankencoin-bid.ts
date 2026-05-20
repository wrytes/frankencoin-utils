import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { BidderMorphoV2OwnableABI } from '../exports/abis/BidderMorphoV2Ownable';

dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

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
// const EXPIRATION_TIMESTAMP = 1779308495; // Wed May 20 2026 20:21:35 UTC
// delta step: 4699003403458429240894855/1e18/86400= 54.386613466 ZCHF/sec
// link to market price: 1680/54.386613466= 30.89sec before expiration
// target: 1779308495-1680/54.386613466= Math.ceil -> 1779308465
const TARGET_TIMESTAMP = 1779308465; // Wed May 20 2026 20:21:05 UTC

// Ethereum average block time in seconds
const BLOCK_TIME = 12;

// Priority fee paid to block builders.
// 1–2 gwei = normal, 5 gwei = strong, 10+ gwei = aggressive.
const PRIORITY_FEE = ethers.parseUnits('5', 'gwei');

// Block window around the target block to submit bundles for.
// Covers price drift: if the arb isn't valid at block N it may be at N+1..+6.
// Each offset gets its own UUID so they're independently cancellable.
export const BLOCK_OFFSETS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

// Base UUID — offset suffix appended per block: ...-1, -0, +1, +2 ... +6
export const BUNDLE_UUID = 'frankencoin-bid-challenge-6';

export function bundleUuid(offset: number): string {
	const sign = offset > 0 ? '+' : '-';
	return `${BUNDLE_UUID}${sign}${Math.abs(offset)}`;
}

// Builders to broadcast to in parallel. Flashbots requires a signed header;
// the others accept unauthenticated requests.
// Source: https://github.com/flashbots/dowg/blob/main/builder-registrations.json
// uuid: true  = supports cancel-endpoint (eth_cancelBundle by replacementUuid)
// uuid: false = no cancel-endpoint support (submit-only)
export const BUILDERS = [
	{ name: 'Titan', url: 'https://rpc.titanbuilder.xyz', auth: false, uuid: true },
	{ name: 'Flashbots', url: 'https://rpc.flashbots.net', auth: true, uuid: true },
	{ name: 'Beaver', url: 'https://mevshare-rpc.beaverbuild.org', auth: false, uuid: true },
	{ name: 'Eureka', url: 'https://rpc.eurekabuilder.xyz', auth: false, uuid: true },
	{ name: 'Quasar', url: 'https://rpc.quasar.win', auth: false, uuid: true },
	{ name: 'JetBuilder', url: 'https://rpc.mevshare.jetbldr.xyz', auth: false, uuid: true },
];

// ─────────────────────────────────────────────────────────────────────────────

const IFACE = new ethers.Interface(BidderMorphoV2OwnableABI);

// Flashbots signs the keccak256 hex string as text (not raw bytes)
async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const sig = await signer.signMessage(ethers.id(body));
	return `${signer.address}:${sig}`;
}

async function submitToBuilder(
	builder: (typeof BUILDERS)[number],
	signedTx: string,
	blockNumber: number,
	offset: number,
	signer: ethers.Wallet
): Promise<void> {
	const blockNumberHex = '0x' + blockNumber.toString(16);
	const uuid = bundleUuid(offset);

	const params: Record<string, unknown> = { txs: [signedTx], blockNumber: blockNumberHex };
	if (builder.uuid) params.replacementUuid = uuid;

	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [params] });

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (builder.auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);

	const label = `${builder.name.padEnd(10)} [${offset >= 0 ? '+' : ''}${offset}]`;

	try {
		const res = await fetch(builder.url, { method: 'POST', headers, body });
		const result = (await res.json()) as { result?: unknown; error?: unknown };

		if (result.error) {
			console.log(`  ${label} ✗  ${JSON.stringify(result.error)}`);
		} else {
			console.log(`  ${label} ✓`);
		}
	} catch (err) {
		console.log(`  ${label} ✗  ${(err as Error).message}`);
	}
}

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
	console.log('Nonce:          ', nonce);
	console.log('FlashBidder:    ', FLASH_BIDDER);
	console.log('Challenge:      ', CHALLENGE_INDEX);
	console.log('Amount:         ', ethers.formatEther(AMOUNT), 'WETH');
	console.log('Path:            WETH → USDT → ZCHF (0.01% / 0.01%)');
	console.log('Priority fee:   ', ethers.formatUnits(PRIORITY_FEE, 'gwei'), 'gwei');
	console.log('Base fee:       ', ethers.formatUnits(feeData.maxFeePerGas ?? 0n, 'gwei'), 'gwei');
	console.log('Max fee:        ', ethers.formatUnits((feeData.maxFeePerGas ?? 0n) + PRIORITY_FEE, 'gwei'), 'gwei');
	console.log('─────────────────────────────────────────────────────────────');
	console.log('Target time:    ', targetDate);
	console.log('Current block:  ', currentBlock, `(t=${currentTimestamp})`);
	console.log('Δ seconds:      ', secondsUntilTarget, `(~${blocksUntilTarget} blocks)`);
	console.log('Target blocks:');
	BLOCK_OFFSETS.forEach((o) => console.log(`    [${o >= 0 ? '+' : ''}${o}]  ${targetBlock + o}  (${bundleUuid(o)})`));
	console.log('─────────────────────────────────────────────────────────────');

	if (secondsUntilTarget < 0) {
		console.error('ERROR: Target timestamp is in the past. Check TARGET_TIMESTAMP.');
		process.exit(1);
	}

	if (secondsUntilTarget > 1000) {
		console.warn(
			`WARN: Target is ${secondsUntilTarget}s away. Run again ~50 block before the auction opens for the most accurate block number.`
		);
	}

	const broadcast = process.argv.includes('true');
	if (!broadcast) {
		console.log('\n(read-only) Pass "true" to broadcast.');
		return;
	}

	console.log('\nBroadcasting to builders...');
	await Promise.all(
		BLOCK_OFFSETS.flatMap((offset) =>
			BUILDERS.map((b) => submitToBuilder(b, signedTx, targetBlock + offset, offset, signer))
		)
	);
	console.log(
		`\nWindow: blocks ${targetBlock - 1} → ${targetBlock + 6} (~${
			BLOCK_OFFSETS.length * BLOCK_TIME
		}s). Cancel with: yarn frankencoin:cancel`
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
