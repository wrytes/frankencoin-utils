export const IRollerPositionV2ABI = [
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'desired',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'available',
				type: 'uint256',
			},
		],
		name: 'InsufficientMint',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NoCollateral',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NotMorpho',
		type: 'error',
	},
	{
		inputs: [],
		name: 'OwnerMismatch',
		type: 'error',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'source',
				type: 'address',
			},
			{
				indexed: true,
				internalType: 'address',
				name: 'target',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'address',
				name: 'newPosition',
				type: 'address',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'collateral',
				type: 'uint256',
			},
			{
				indexed: false,
				internalType: 'uint256',
				name: 'repaid',
				type: 'uint256',
			},
		],
		name: 'Rolled',
		type: 'event',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'vault',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'source',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'target',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'expiration',
				type: 'uint256',
			},
		],
		name: 'execute',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'assets',
				type: 'uint256',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'onMorphoFlashLoan',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
] as const;
