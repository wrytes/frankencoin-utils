import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { BUNDLE_UUID, BLOCK_OFFSETS, BUILDERS, bundleUuid } from './frankencoin-bid';

dotenv.config();

// Cancels all block-offset UUIDs across all uuid-capable builders.
// Override base UUID via CLI: npx ts-node scripts/frankencoin-cancel.ts <uuid>
const baseUuid = process.argv[2] ?? BUNDLE_UUID;
const uuids = BLOCK_OFFSETS.map(o => {
	if (baseUuid !== BUNDLE_UUID) return baseUuid; // custom UUID passed — cancel just that one
	return bundleUuid(o);
});
const uniqueUuids = [...new Set(uuids)];

// ─────────────────────────────────────────────────────────────────────────────

async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const sig = await signer.signMessage(ethers.id(body));
	return `${signer.address}:${sig}`;
}

async function cancelAt(
	builder: typeof BUILDERS[number],
	uuid: string,
	signer: ethers.Wallet
): Promise<void> {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_cancelBundle',
		params: [{ replacementUuid: uuid }],
	});

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (builder.auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);

	const label = `${builder.name.padEnd(10)} [${uuid.replace(BUNDLE_UUID, '')}]`;

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

	const signer = new ethers.Wallet(privateKey);
	const cancellable = BUILDERS.filter(b => b.uuid);

	console.log(`Cancelling ${uniqueUuids.length} bundle(s) across ${cancellable.length} builders...`);
	console.log('UUIDs:', uniqueUuids.join(', '));

	await Promise.all(
		uniqueUuids.flatMap(uuid => cancellable.map(b => cancelAt(b, uuid, signer)))
	);

	console.log('\nNote: not guaranteed if submitted within 4s of the block relay deadline.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
