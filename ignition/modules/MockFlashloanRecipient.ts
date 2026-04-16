import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { Address } from 'viem';

export const NAME: string = 'MockFlashloanRecipient';
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	zchf: Address;
	flashloan: Address;
};

export const params: DeploymentParams = {
	zchf: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB', // ZCHF
	flashloan: '0x3D60dbD18B930B1710b76b88461E33DCAdEC96a1', // FlashloanFrankencoin
};

export type ConstructorArgs = [Address, Address];

export const args: ConstructorArgs = [params.zchf, params.flashloan];

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
