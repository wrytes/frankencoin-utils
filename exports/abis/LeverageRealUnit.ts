export const LeverageRealUnitABI = [
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'got',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'expected',
				type: 'uint256',
			},
		],
		name: 'InsufficientREALU',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'available',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'required',
				type: 'uint256',
			},
		],
		name: 'InsufficientZCHF',
		type: 'error',
	},
	{
		inputs: [],
		name: 'NotFlashloan',
		type: 'error',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'SafeERC20FailedOperation',
		type: 'error',
	},
	{
		inputs: [],
		name: 'FLASHLOAN',
		outputs: [
			{
				internalType: 'contract IFlashloanFrankencoin',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'HUB',
		outputs: [
			{
				internalType: 'contract IMintingHubV2',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'REALU',
		outputs: [
			{
				internalType: 'contract IERC20',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'ZCHF',
		outputs: [
			{
				internalType: 'contract IERC20',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'flashloanSource',
				type: 'address',
			},
			{
				internalType: 'address',
				name: 'cloneSource',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'inputAmount',
				type: 'uint256',
			},
			{
				internalType: 'uint40',
				name: 'expiration',
				type: 'uint40',
			},
			{
				internalType: 'contract IBrokerbot',
				name: 'brokerbot',
				type: 'address',
			},
			{
				internalType: 'contract IPaymentHub',
				name: 'paymentHub',
				type: 'address',
			},
		],
		name: 'executeLeverage',
		outputs: [
			{
				internalType: 'address',
				name: 'leveragedPosition',
				type: 'address',
			},
		],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'amount',
				type: 'uint256',
			},
			{
				internalType: 'bytes',
				name: 'data',
				type: 'bytes',
			},
		],
		name: 'onFrankencoinFlashloan',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'cloneSource',
				type: 'address',
			},
			{
				internalType: 'uint256',
				name: 'inputAmount',
				type: 'uint256',
			},
			{
				internalType: 'uint40',
				name: 'expiration',
				type: 'uint40',
			},
			{
				internalType: 'contract IBrokerbot',
				name: 'brokerbot',
				type: 'address',
			},
		],
		name: 'preview',
		outputs: [
			{
				components: [
					{
						internalType: 'uint256',
						name: 'tokens',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'flashloanAmount',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'reserveAmount',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'feeAmount',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'requiredAmount',
						type: 'uint256',
					},
				],
				internalType: 'struct LeverageRealUnit.Preview',
				name: 'p',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
