import dotenv from 'dotenv';
import { BUNDLE_UUID } from './frankencoin-bid';

dotenv.config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TITAN_RPC = 'https://rpc.titanbuilder.xyz';

// UUID to cancel — defaults to the one set in frankencoin-bid.ts.
// Override via CLI: npx ts-node scripts/frankencoin-cancel.ts <uuid>
const uuid = process.argv[2] ?? BUNDLE_UUID;

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
	console.log('Cancelling bundle:', uuid);

	const payload = {
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_cancelBundle',
		params: [{ replacementUuid: uuid }],
	};

	const res = await fetch(TITAN_RPC, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	const result = (await res.json()) as { result?: number; error?: unknown };

	if (result.error) {
		console.error('Cancel failed:', result.error);
		process.exit(1);
	}

	console.log('Bundle cancelled.');
	console.log('Note: not guaranteed if submitted within 4s of the block relay deadline.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
