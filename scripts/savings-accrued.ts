#!/usr/bin/env ts-node
/**
 * Script: savings-accrued.ts
 *
 * Queries all savings accounts from the Ponder indexer across all chains
 * and modules, fetches on-chain accrued (unclaimed) interest via multicall,
 * prints a summary table, and writes per-chain Gnosis Safe TX-builder payloads
 * (refreshBalance calls) into scripts/safe/.
 *
 * Usage:
 *   ts-node -r tsconfig-paths/register scripts/savings-accrued.ts [--url https://ponder.frankencoin.com]
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { mkdirSync, writeFileSync } from 'fs';
import { Abi, Chain, createPublicClient, encodeFunctionData, formatUnits, getAddress, http } from 'viem';
import { arbitrum, avalanche, base, gnosis, mainnet, optimism, polygon, sonic } from 'viem/chains';
import { SavingsABI } from '@frankencoin/zchf';

// ── Config ─────────────────────────────────────────────────────────────────

const PONDER_URL = (() => {
	const idx = process.argv.indexOf('--url');
	return idx !== -1 ? process.argv[idx + 1] : 'https://ponder.frankencoin.com';
})();

const ALCHEMY_KEY = process.env.ALCHEMY_RPC_KEY ?? (() => { throw new Error('ALCHEMY_RPC_KEY env var is required'); })();
const PAGE_SIZE = 1_000;
const MIN_ACCRUED = BigInt(1e18); // 1 ZCHF min unclaimed to include in table and Safe payload

const CHAIN_NAMES: Record<number, string> = {
	[mainnet.id]: 'ethereum',
	[gnosis.id]: 'gnosis',
	[base.id]: 'base',
	[optimism.id]: 'optimism',
	[polygon.id]: 'polygon',
	[arbitrum.id]: 'arbitrum',
	[avalanche.id]: 'avalanche',
	[sonic.id]: 'sonic',
};

// ── Viem clients (Alchemy if key available, public RPC fallback) ───────────

function makeClient(chain: Chain, alchemySlug: string) {
	return createPublicClient({ chain, transport: http(`https://${alchemySlug}.g.alchemy.com/v2/${ALCHEMY_KEY}`), batch: { multicall: { wait: 100 } } });
}

const CLIENTS: Record<number, ReturnType<typeof makeClient>> = {
	[mainnet.id]:   makeClient(mainnet,   'eth-mainnet'),
	[gnosis.id]:    makeClient(gnosis,    'gnosis-mainnet'),
	[base.id]:      makeClient(base,      'base-mainnet'),
	[optimism.id]:  makeClient(optimism,  'opt-mainnet'),
	[polygon.id]:   makeClient(polygon,   'polygon-mainnet'),
	[arbitrum.id]:  makeClient(arbitrum,  'arb-mainnet'),
	[avalanche.id]: makeClient(avalanche, 'avax-mainnet'),
	[sonic.id]:     makeClient(sonic,     'sonic-mainnet'),
};

// ── ABI subsets ────────────────────────────────────────────────────────────

// accruedInterest(address) — single-arg overload (no timestamp)
const ACCRUED_ABI = SavingsABI.filter(
	(x) => x.type === 'function' && x.name === 'accruedInterest' && (x as any).inputs?.length === 1
) as Abi;

// refreshBalance(address owner) — non-payable, used in Safe payload
const REFRESH_ABI = SavingsABI.filter(
	(x) => x.type === 'function' && x.name === 'refreshBalance'
) as Abi;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(raw: string | bigint, dp = 2): string {
	return Number(formatUnits(typeof raw === 'bigint' ? raw : BigInt(raw), 18)).toFixed(dp);
}

async function gql<T>(query: string): Promise<T> {
	const res = await fetch(PONDER_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query }),
	});
	if (!res.ok) throw new Error(`Ponder HTTP ${res.status}`);
	const json = (await res.json()) as { data?: T; errors?: unknown[] };
	if (json.errors?.length) throw new Error(`GraphQL errors:\n${JSON.stringify(json.errors, null, 2)}`);
	return json.data as T;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface MappingItem {
	account: string;
	balance: string;
	chainId: number;
	module: string;
	interest: string;
	updated: string;
}

interface Enriched extends MappingItem {
	accrued: bigint;
}

// ── Data fetching ──────────────────────────────────────────────────────────

async function fetchAllAccounts(): Promise<MappingItem[]> {
	const all: MappingItem[] = [];
	let offset = 0;
	while (true) {
		const { savingsMappings } = await gql<{
			savingsMappings: { items: MappingItem[]; pageInfo: { hasNextPage: boolean } };
		}>(`{
			savingsMappings(
				where: { balance_gt: "1000000000000000000" },
				orderBy: "balance",
				orderDirection: "desc",
				limit: ${PAGE_SIZE},
				offset: ${offset}
			) {
				items { account balance chainId module interest updated }
				pageInfo { hasNextPage }
			}
		}`);
		all.push(...savingsMappings.items);
		if (!savingsMappings.pageInfo.hasNextPage) break;
		offset += PAGE_SIZE;
	}
	return all;
}

async function fetchAccrued(client: ReturnType<typeof makeClient>, module: string, accounts: string[]): Promise<bigint[]> {
	const BATCH = 100;
	const out: bigint[] = [];
	for (let i = 0; i < accounts.length; i += BATCH) {
		const slice = accounts.slice(i, i + BATCH);
		const results = await client.multicall({
			contracts: slice.map((a) => ({
				address: module as `0x${string}`,
				abi: ACCRUED_ABI,
				functionName: 'accruedInterest' as const,
				args: [getAddress(a)] as const,
			})),
		});
		out.push(...results.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n)));
	}
	return out;
}

// ── Safe TX-builder payload ────────────────────────────────────────────────

function safePayload(chainId: number, module: string, accounts: string[]) {
	const chainName = CHAIN_NAMES[chainId] ?? `chain-${chainId}`;
	return {
		version: '1.0',
		chainId: String(chainId),
		createdAt: Date.now(),
		meta: {
			name: `Refresh Savings Balances — ${chainName} / ${module.slice(0, 10)}…`,
			description: 'Calls refreshBalance(owner) for each active saver to materialise accrued interest.',
			txBuilderVersion: '1.16.1',
		},
		transactions: accounts.map((a) => ({
			to: module,
			value: '0',
			data: encodeFunctionData({
				abi: REFRESH_ABI,
				functionName: 'refreshBalance',
				args: [getAddress(a)],
			}),
		})),
	};
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
	console.log(`Ponder: ${PONDER_URL}\n`);

	// 1. Fetch all accounts from Ponder
	process.stdout.write('Fetching accounts from Ponder…');
	const accounts = await fetchAllAccounts();
	console.log(` ${accounts.length} accounts found\n`);

	// 2. Group by (chainId, module)
	const groups = new Map<string, { chainId: number; module: string; accounts: MappingItem[] }>();
	for (const a of accounts) {
		const key = `${a.chainId}:${a.module.toLowerCase()}`;
		if (!groups.has(key)) groups.set(key, { chainId: Number(a.chainId), module: a.module, accounts: [] });
		groups.get(key)!.accounts.push(a);
	}

	console.log('Groups (chainId → module → count):');
	for (const [, g] of groups) {
		console.log(`  ${CHAIN_NAMES[g.chainId] ?? g.chainId}  ${g.module}  (${g.accounts.length})`);
	}
	console.log();

	// 3. Fetch accrued interest for each group via multicall
	const enriched: Enriched[] = [];

	for (const [, group] of groups) {
		const client = CLIENTS[group.chainId];
		if (!client) {
			console.warn(`  ⚠ No viem client for chainId=${group.chainId}, skipping`);
			continue;
		}
		process.stdout.write(`  accruedInterest: ${CHAIN_NAMES[group.chainId] ?? group.chainId} / ${group.module.slice(0, 10)}… (${group.accounts.length} accounts)…`);
		const accrued = await fetchAccrued(client, group.module, group.accounts.map((a) => a.account));
		group.accounts.forEach((a, i) => enriched.push({ ...a, accrued: accrued[i]! }));
		const total = accrued.reduce((s, v) => s + v, 0n);
		console.log(` done  (total unclaimed: ${fmt(total)} ZCHF)`);
	}

	// 4. Sort by unclaimed interest desc, drop below MIN_ACCRUED
	enriched.sort((a, b) => (b.accrued > a.accrued ? 1 : -1));
	const filtered = enriched.filter((r) => r.accrued >= MIN_ACCRUED);

	// 5. Console table
	console.log(`\n=== Savings accounts — unclaimed ≥ ${fmt(MIN_ACCRUED)} ZCHF ===`);
	console.table(
		filtered.map((r) => ({
			chain: CHAIN_NAMES[r.chainId] ?? r.chainId,
			module: r.module.slice(0, 10) + '…',
			account: r.account,
			'balance': fmt(r.balance),
			'paid': fmt(r.interest),
			'unclaimed': fmt(r.accrued),
		}))
	);

	// 6. Totals
	const totalBalance = filtered.reduce((s, r) => s + BigInt(r.balance), 0n);
	const totalPaid = filtered.reduce((s, r) => s + BigInt(r.interest), 0n);
	const totalUnclaimed = filtered.reduce((s, r) => s + r.accrued, 0n);
	console.log(`\nTotal accounts : ${filtered.length}`);
	console.log(`Total balance  : ${fmt(totalBalance)} ZCHF`);
	console.log(`Total paid     : ${fmt(totalPaid)} ZCHF`);
	console.log(`Total unclaimed: ${fmt(totalUnclaimed)} ZCHF`);

	// 7. Write Safe payloads per (chainId, module)
	const outDir = 'scripts/safe';
	mkdirSync(outDir, { recursive: true });

	console.log('\n=== Safe TX-builder payloads ===');
	for (const [, group] of groups) {
		const eligible = filtered.filter(
			(r) => Number(r.chainId) === group.chainId && r.module.toLowerCase() === group.module.toLowerCase()
		);
		if (eligible.length === 0) continue;

		const chainName = CHAIN_NAMES[group.chainId] ?? `chain-${group.chainId}`;
		const moduleShort = group.module.slice(2, 8).toLowerCase();
		const outPath = `${outDir}/safe-refresh-${chainName}-${moduleShort}.json`;
		const payload = safePayload(group.chainId, group.module, eligible.map((r) => r.account));

		writeFileSync(outPath, JSON.stringify(payload, null, 2));

		const groupUnclaimed = eligible.reduce((s, r) => s + r.accrued, 0n);
		console.log(`  ${chainName} / ${group.module.slice(0, 10)}…  ${eligible.length} txs  ${fmt(groupUnclaimed)} ZCHF unclaimed  →  ${outPath}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
