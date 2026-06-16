import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { Address } from 'viem';

export const NAME: string = 'AuthorizePositionV2';
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	owner: Address;
};

export const params: DeploymentParams = {
	owner: '0x8CF43c9490f26cCc6E9B65EfEf62378Bb5AeB9eE',
};

export type ConstructorArgs = [Address];

export const args: ConstructorArgs = [params.owner];

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
