import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { Address } from 'viem';

export const NAME: string = 'RollerPositionV2';
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	morpho: Address;
	zchf: Address;
	hubV2: Address;
};

export const params: DeploymentParams = {
	morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
	zchf: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
	hubV2: '0xDe12B620A8a714476A97EfD14E6F7180Ca653557',
};

export type ConstructorArgs = [Address, Address, Address];

export const args: ConstructorArgs = [params.morpho, params.zchf, params.hubV2];

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
