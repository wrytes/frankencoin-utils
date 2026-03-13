import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { args, params } from '../params/PositionV2Streamer';

// config and select
export const NAME: string = 'PositionV2Streamer'; // <-- select smart contract
export const FILE: string = 'PositionV2Streamer'; // <-- name exported file
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(FILE, args);
console.log('Constructor Args');
console.log(args);

// fail safe
process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
