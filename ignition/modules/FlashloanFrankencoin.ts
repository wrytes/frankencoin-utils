import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { Address } from 'viem';

export const NAME: string = 'FlashloanFrankencoin';
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	morpho: Address;
	hub: Address;
};

export const params: DeploymentParams = {
	morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', // Morpho
	hub: '0xDe12B620A8a714476A97EfD14E6F7180Ca653557', // MintingHubV2
};

export type ConstructorArgs = [Address, Address];

export const args: ConstructorArgs = [params.morpho, params.hub];

console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(NAME, args);
console.log('Constructor Args');
console.log(args);

// fail safe
process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
