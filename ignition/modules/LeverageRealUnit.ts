import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';

export const NAME: string = 'LeverageRealUnit';
export const MOD: string = NAME + 'Module';
console.log(NAME);

export type ConstructorArgs = [];

export const args: ConstructorArgs = [];

// export args
storeConstructorArgs(NAME, args);
console.log('Constructor Args');
console.log(args);

// fail safe
// process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
