import { Address } from 'viem';

export type DeploymentParams = {
	roller: Address;
	owner: Address;
	streamReward: bigint;
	streamThreshold: number;
	streamPeriod: number;
};

export const params: DeploymentParams = {
	roller: '0xAD0107D3Da540Fd54b1931735b65110C909ea6B6',
	owner: '0xbfE145DcFac110Df1efD27B403Dd68fd2C61494e',
	streamReward: 200_000_000_000_000n, // 0.0002 ETH
	streamThreshold: 1 * 24 * 3600, // days in seconds
	streamPeriod: 30 * 24 * 3600, // days in seconds
};

export type ConstructorArgs = [Address, Address, bigint, number, number];

export const args: ConstructorArgs = [
	params.roller,
	params.owner,
	params.streamReward,
	params.streamThreshold,
	params.streamPeriod,
];
