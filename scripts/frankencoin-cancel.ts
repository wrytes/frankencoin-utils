import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { BUNDLE_UUID, BUILDERS } from './frankencoin-bid';

dotenv.config();

// UUID to cancel — defaults to the one set in frankencoin-bid.ts.
// Override via CLI: npx ts-node scripts/frankencoin-cancel.ts <uuid>
const uuid = process.argv[2] ?? BUNDLE_UUID;

// ─────────────────────────────────────────────────────────────────────────────

async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const sig = await signer.signMessage(ethers.id(body));
	return `${signer.address}:${sig}`;
}

async function cancelAt(
	builder: typeof BUILDERS[number],
	body: string,
	signer: ethers.Wallet
): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (builder.auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);

	try {
		const res = await fetch(builder.url, { method: 'POST', headers, body });
		const result = (await res.json()) as { result?: unknown; error?: unknown };

		if (result.error) {
			console.log(`  ${builder.name.padEnd(10)} ✗  ${JSON.stringify(result.error)}`);
		} else {
			console.log(`  ${builder.name.padEnd(10)} ✓`);
		}
	} catch (err) {
		console.log(`  ${builder.name.padEnd(10)} ✗  ${(err as Error).message}`);
	}
}

async function main() {
	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

	const signer = new ethers.Wallet(privateKey);

	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_cancelBundle',
		params: [{ replacementUuid: uuid }],
	});

	// Only cancel on builders that support replacementUuid
	const cancellable = BUILDERS.filter((b) => b.uuid);

	console.log('Cancelling bundle:', uuid);
	await Promise.all(cancellable.map((b) => cancelAt(b, body, signer)));
	console.log('\nNote: not guaranteed if submitted within 4s of the block relay deadline.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
