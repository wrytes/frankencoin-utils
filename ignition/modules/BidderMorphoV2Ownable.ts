import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { storeConstructorArgs } from '../../helper/store.args';
import { Address } from 'viem';

export const NAME: string = 'BidderMorphoV2Ownable'; // <-- check for correct contract
export const MOD: string = NAME + 'Module';
console.log(NAME);

// params
export type DeploymentParams = {
	morpho: Address;
	uniswap: Address;
	zchf: Address;
	hubV2: Address;
	owner: Address;
	feePPM: number;
};

export const params: DeploymentParams = {
	morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', // morpho
	uniswap: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // uniswap router
	zchf: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
	hubV2: '0xDe12B620A8a714476A97EfD14E6F7180Ca653557',
	owner: '0x220B613fE70bf228C11F781A1d2bAEEA34f71809',
	feePPM: 200_000,
};

export type ConstructorArgs = [Address, Address, Address, Address, Address, number];

export const args: ConstructorArgs = [
	params.morpho,
	params.uniswap,
	params.zchf,
	params.hubV2,
	params.owner,
	params.feePPM,
];

console.log('Imported Params:');
console.log(params);

// export args
storeConstructorArgs(NAME, args); // <-- check for correct file name
console.log('Constructor Args');
console.log(args);

// fail safe
process.exit();

export default buildModule(MOD, (m) => {
	return {
		[NAME]: m.contract(NAME, args),
	};
});
