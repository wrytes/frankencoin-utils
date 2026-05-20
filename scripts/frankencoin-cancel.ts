import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { BUNDLE_UUID, BUILDERS } from './frankencoin-bid';

dotenv.config();

// UUID to cancel — defaults to the one set in frankencoin-bid.ts.
// Override via CLI: npx ts-node scripts/frankencoin-cancel.ts <uuid>
const uuid = process.argv[2] ?? BUNDLE_UUID;

// ─────────────────────────────────────────────────────────────────────────────

async function flashbotsHeader(signer: ethers.Wallet, body: string): Promise<string> {
	const hash = ethers.id(body);
	const sig = await signer.signMessage(ethers.getBytes(hash));
	return `${signer.address}:${sig}`;
}

async function cancelAt(name: string, url: string, auth: boolean, body: string, signer: ethers.Wallet): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (auth) headers['X-Flashbots-Signature'] = await flashbotsHeader(signer, body);

	try {
		const res = await fetch(url, { method: 'POST', headers, body });
		const result = (await res.json()) as { result?: unknown; error?: unknown };

		if (result.error) {
			console.log(`  ${name.padEnd(10)} ✗  ${JSON.stringify(result.error)}`);
		} else {
			console.log(`  ${name.padEnd(10)} ✓`);
		}
	} catch (err) {
		console.log(`  ${name.padEnd(10)} ✗  ${(err as Error).message}`);
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

	console.log('Cancelling bundle:', uuid);
	await Promise.all(BUILDERS.map((b) => cancelAt(b.name, b.url, b.auth, body, signer)));
	console.log('\nNote: not guaranteed if submitted within 4s of the block relay deadline.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
