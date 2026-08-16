/**
 * Script: custom/submit-private-tx.ts
 *
 * Signs the tx request in scripts/custom/tx.json and broadcasts it privately (bypassing the
 * public mempool) as an eth_sendBundle of size 1 to a set of block builders. Same builder list
 * and submission mechanics as scripts/frankencoin-bid.ts, but targets a rolling window of
 * upcoming blocks starting now instead of a timestamp-derived auction block.
 *
 * tx.json is expected to be an unsigned EIP-1559 tx request (chainId, to, data, gas, nonce,
 * maxFeePerGas, maxPriorityFeePerGas, from) — e.g. a Safe execTransaction call where the Safe
 * owner signatures are already embedded in `data`, but the outer relayer tx itself is unsigned.
 *
 * Usage:
 *   npx ts-node scripts/custom/submit-private-tx.ts        # dry run, prints the signed tx info
 *   npx ts-node scripts/custom/submit-private-tx.ts true   # actually broadcasts
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TX_PATH = 'scripts/custom/tx.json';

// How many upcoming blocks to submit the bundle for, starting at currentBlock + 1.
const BLOCK_WINDOW = 5;

// Priority fee paid to the builder. Private bundles aren't competing in the public mempool
// auction, so 0 is fine — inclusion is up to the builder, not priority-fee bidding.
const PRIORITY_FEE = ethers.parseUnits('0', 'gwei');

// Builders to broadcast to in parallel. Flashbots requires a signed header;
// the others accept unauthenticated requests.
// Source: https://github.com/flashbots/dowg/blob/main/builder-registrations.json
// Duplicated from scripts/frankencoin-bid.ts (not imported) — that module runs its own
// main() as a top-level side effect on import, which would hijack this script's process.
const BUILDERS = [
	{ name: 'Titan', url: 'https://rpc.titanbuilder.xyz', auth: false },
	{ name: 'Flashbots', url: 'https://rpc.flashbots.net', auth: true },
	{ name: 'Beaver', url: 'https://mevshare-rpc.beaverbuild.org', auth: false },
	{ name: 'Eureka', url: 'https://rpc.eurekabuilder.xyz', auth: false },
	{ name: 'Quasar', url: 'https://rpc.quasar.win', auth: false },
	{ name: 'JetBuilder', url: 'https://rpc.mevshare.jetbldr.xyz', auth: false },
];

// ─────────────────────────────────────────────────────────────────────────────

// Flashbots signs the keccak256 hex string as text (not raw bytes)
async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const sig = await signer.signMessage(ethers.id(body));
	return `${signer.address}:${sig}`;
}

async function submitToBuilder(
	builder: (typeof BUILDERS)[number],
	signedTx: string,
	blockNumber: number,
	signer: ethers.Wallet
): Promise<void> {
	const blockNumberHex = '0x' + blockNumber.toString(16);
	const params: Record<string, unknown> = { txs: [signedTx], blockNumber: blockNumberHex };

	const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [params] });

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (builder.auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);

	const label = `${builder.name.padEnd(10)} [block ${blockNumber}]`;

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

	const root = resolve(__dirname, '../..');
	const raw = JSON.parse(readFileSync(join(root, TX_PATH), 'utf8'));

	if (raw.from && raw.from.toLowerCase() !== signer.address.toLowerCase()) {
		throw new Error(`tx.json "from" (${raw.from}) does not match PRIVATE_KEY wallet (${signer.address})`);
	}

	const [onChainNonce, balance, latestBlock, feeData] = await Promise.all([
		provider.getTransactionCount(signer.address),
		provider.getBalance(signer.address),
		provider.getBlock('latest'),
		provider.getFeeData(),
	]);
	if (!latestBlock) throw new Error('Could not fetch latest block');
	const currentBlock = latestBlock.number;
	const baseFee = latestBlock.baseFeePerGas ?? 0n;

	// Gas price fields are re-derived live rather than trusted from tx.json (which may be stale
	// or use public-mempool assumptions) — the Safe multisig signatures embedded in `data` only
	// cover the Safe transaction itself, not this outer relayer tx's gas fields, so it's safe
	// to override them here.
	const maxPriorityFeePerGas = PRIORITY_FEE;
	const maxFeePerGas = (feeData.maxFeePerGas ?? baseFee) + PRIORITY_FEE;

	const tx: ethers.TransactionRequest = {
		type: 2,
		chainId: BigInt(raw.chainId),
		to: raw.to,
		data: raw.data,
		value: raw.value ? BigInt(raw.value) : 0n,
		gasLimit: BigInt(raw.gas),
		nonce: Number(BigInt(raw.nonce)),
		maxFeePerGas,
		maxPriorityFeePerGas,
	};

	const signedTx = await signer.signTransaction(tx);
	const txHash = ethers.keccak256(signedTx);

	const targetBlocks = Array.from({ length: BLOCK_WINDOW }, (_, i) => currentBlock + 1 + i);
	const maxCost = BigInt(tx.gasLimit!) * BigInt(tx.maxFeePerGas!);

	console.log('─── Private Tx Submission ──────────────────────────────────');
	console.log('Signer:         ', signer.address, `(${ethers.formatEther(balance)} ETH)`);
	console.log('To:             ', tx.to);
	console.log('Tx nonce:       ', tx.nonce, onChainNonce !== tx.nonce ? `⚠ on-chain nonce is ${onChainNonce}` : '(matches on-chain)');
	console.log('Gas limit:      ', tx.gasLimit!.toString());
	console.log('Base fee:       ', ethers.formatUnits(baseFee, 'gwei'), 'gwei');
	console.log('Max fee:        ', ethers.formatUnits(tx.maxFeePerGas!, 'gwei'), 'gwei');
	console.log('Priority fee:   ', ethers.formatUnits(tx.maxPriorityFeePerGas!, 'gwei'), 'gwei');
	console.log('Max cost:       ', ethers.formatEther(maxCost), 'ETH', maxCost > balance ? '⚠ exceeds balance' : '');
	console.log('Tx hash:        ', txHash);
	console.log('Current block:  ', currentBlock);
	console.log('Target blocks:  ', `${targetBlocks[0]} → ${targetBlocks[targetBlocks.length - 1]}`);
	console.log('─────────────────────────────────────────────────────────────');

	const broadcast = process.argv.includes('true');
	if (!broadcast) {
		console.log('\n(read-only) Pass "true" to broadcast.');
		return;
	}

	console.log('\nBroadcasting to builders...');
	await Promise.all(
		targetBlocks.flatMap((blockNumber) => BUILDERS.map((b) => submitToBuilder(b, signedTx, blockNumber, signer)))
	);

	console.log(`\nSubmitted for blocks ${targetBlocks[0]} → ${targetBlocks[targetBlocks.length - 1]}.`);
	console.log('If not mined in this window, re-run to submit for the next window.');
	console.log('Track:', `https://etherscan.io/tx/${txHash}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
