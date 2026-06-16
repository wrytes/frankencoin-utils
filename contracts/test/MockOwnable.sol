// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

contract MockOwnable is Ownable {
	constructor(address _owner) Ownable(_owner) {}
}
