// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LeverageMorpho} from './LeverageMorpho.sol';
import {MarketParams, Id} from '../morpho/IMorpho.sol';

contract LeverageMorphoFactory {
	// mainnet deployment
	address public immutable _morpho = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
	address public immutable _uniswap = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

	event Created(address indexed instance, address indexed owner, Id indexed marketId);

	function create(
		address _loan,
		address _collateral,
		address _oracle,
		address _irm,
		uint256 _lltv,
		address _owner
	) external returns (address) {
		LeverageMorpho instance = new LeverageMorpho(
			_morpho,
			_loan,
			_collateral,
			_oracle,
			_irm,
			_lltv,
			_uniswap,
			_owner
		);
		Id marketId = Id.wrap(instance.getMarketId(MarketParams(_loan, _collateral, _oracle, _irm, _lltv)));
		emit Created(address(instance), _owner, marketId);

		return address(instance);
	}
}
