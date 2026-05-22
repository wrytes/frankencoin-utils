export const BidderMorphoV2OwnableABI = [
	{
		inputs: [
			{ internalType: 'address', name: '_morpho', type: 'address' },
			{ internalType: 'address', name: '_uniswap', type: 'address' },
			{ internalType: 'address', name: '_zchf', type: 'address' },
			{ internalType: 'address', name: '_hubV2', type: 'address' },
			{ internalType: 'address', name: '_owner', type: 'address' },
		],
		stateMutability: 'nonpayable',
		type: 'constructor',
	},
	{ inputs: [], name: 'NoCollateral', type: 'error' },
	{ inputs: [], name: 'NoPrice', type: 'error' },
	{ inputs: [], name: 'NotMorpho', type: 'error' },
	{
		inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
		name: 'OwnableInvalidOwner',
		type: 'error',
	},
	{
		inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
		name: 'OwnableUnauthorizedAccount',
		type: 'error',
	},
	{
		inputs: [{ internalType: 'address', name: 'token', type: 'address' }],
		name: 'SafeERC20FailedOperation',
		type: 'error',
	},
	{ inputs: [], name: 'WrongEncodePathInputs', type: 'error' },
	{
		anonymous: false,
		inputs: [
			{ indexed: false, internalType: 'uint256', name: 'bid', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'swapIn', type: 'uint256' },
			{ indexed: false, internalType: 'uint256', name: 'swapOut', type: 'uint256' },
		],
		name: 'Executed',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: 'address', name: 'previousOwner', type: 'address' },
			{ indexed: true, internalType: 'address', name: 'newOwner', type: 'address' },
		],
		name: 'OwnershipTransferred',
		type: 'event',
	},
	{
		inputs: [
			{ internalType: 'address[]', name: 'tokens', type: 'address[]' },
			{ internalType: 'uint24[]', name: 'fees', type: 'uint24[]' },
		],
		name: 'encodePath',
		outputs: [{ internalType: 'bytes', name: '', type: 'bytes' }],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'uint32', name: 'index', type: 'uint32' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
			{ internalType: 'bytes', name: 'path', type: 'bytes' },
		],
		name: 'execute',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'hub',
		outputs: [{ internalType: 'contract IMintingHubV2Bidder', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'uint256', name: 'assets', type: 'uint256' },
			{ internalType: 'bytes', name: 'data', type: 'bytes' },
		],
		name: 'onMorphoFlashLoan',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'owner',
		outputs: [{ internalType: 'address', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{ inputs: [], name: 'renounceOwnership', outputs: [], stateMutability: 'nonpayable', type: 'function' },
	{
		inputs: [{ internalType: 'address', name: 'newOwner', type: 'address' }],
		name: 'transferOwnership',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;
