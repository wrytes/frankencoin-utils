import { mainnet, polygon } from 'viem/chains';
import { Address, zeroAddress } from 'viem';

export interface ChainAddress {
	leverageMorphoFactory: Address;
	frankencoinSavingsToken: Address;
	flashloanFrankencoin: Address;
}

export const ADDRESS: Record<number, ChainAddress> = {
	[mainnet.id]: {
		leverageMorphoFactory: '0x33dD53A0d5bb2E754e32d034F434bE85250a957D',
		frankencoinSavingsToken: '0x00e632728d5aB91fe8319760fFdD2D7362E28139',
		flashloanFrankencoin: '0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1',
	},
};
