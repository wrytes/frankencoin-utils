// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

import {ISwapRouter} from '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IMorpho} from './morpho/IMorpho.sol';
import {IMorphoFlashLoanCallback} from './morpho/IMorphoCallbacks.sol';

import {IFrankencoin} from './frankencoin/IFrankencoin.sol';
import {IMintingHubV2} from './frankencoin/IMintingHubV2.sol';
import {IPositionV2} from './frankencoin/IPositionV2.sol';

struct Action {
    address target;
    uint256 value;
    bytes data;
}

contract SimFlashLoan is Ownable, IMorphoFlashLoanCallback {
	using Math for uint256;
	using SafeERC20 for IERC20;

	IMorpho private immutable morpho;
	ISwapRouter private immutable uniswap;
	IFrankencoin private immutable zchf;
	IMintingHubV2 private immutable hub;

	address private _sender;
	address private _flashToken;
	uint256 private _flashAmount;
	address private _collateralToken;
	uint256 private _collateralAmount;
	uint256 private _mintAmount;
	Action[] private _actions;
	uint256 private _allowFailureMap;
	IPositionV2 private _position;
	bytes private _swapPath;

	modifier reentranceGuard {
		if (_sender != address(0)) revert ReentranceGuard();
		_;
	}

	error ReentranceGuard();
	error NotMorpho();
	error InsufficientCollateral();
	error PositionCreationFailed();
	error InsufficientMinting();
	error ActionFailed(uint256 index);

	event FlashLoanExecuted(
		address indexed flashToken,
		uint256 flashAmount,
		address indexed position,
		uint256 mintedZCHF,
		uint256 actionsExecuted
	);

	constructor(
		address _morpho,
		address _uniswap,
		address _zchf,
		address _hub,
		address _owner
	) Ownable(_owner) {
		morpho = IMorpho(_morpho);
		uniswap = ISwapRouter(_uniswap);
		zchf = IFrankencoin(_zchf);
		hub = IMintingHubV2(_hub);
	}

	/// @notice Execute flash loan strategy with Frankencoin position
	/// @param flashToken Token to flash loan (collateral)
	/// @param flashAmount Amount to flash loan
	/// @param collateralAmount Amount of collateral to use for position
	/// @param mintAmount Amount of ZCHF to mint from position
	/// @param actions Arbitrary actions to execute with minted ZCHF
	/// @param allowFailureMap Bitmap for action failure tolerance
	/// @param swapPath Uniswap path for final swap (ZCHF -> flash token)
	/// @param parentPosition Parent position to clone (use address(0) for new position)
	function execute(
		address flashToken,
		uint256 flashAmount,
		uint256 collateralAmount,
		uint256 mintAmount,
		Action[] calldata actions,
		uint256 allowFailureMap,
		bytes calldata swapPath,
		address parentPosition
	) external onlyOwner reentranceGuard {
		_sender = msg.sender;
		_flashToken = flashToken;
		_flashAmount = flashAmount;
		_collateralToken = flashToken;
		_collateralAmount = collateralAmount;
		_mintAmount = mintAmount;
		_allowFailureMap = allowFailureMap;
		_swapPath = swapPath;

		delete _actions;
		for (uint256 i = 0; i < actions.length; i++) {
			_actions.push(actions[i]);
		}

		bytes memory data = abi.encode(parentPosition);
		morpho.flashLoan(flashToken, flashAmount, data);

		_clearState();
	}

	function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
		if (msg.sender != address(morpho)) revert NotMorpho();

		(address parentPosition) = abi.decode(data, (address));

		// Step 1: Create or clone Frankencoin position with flash loan collateral
		IERC20(_flashToken).forceApprove(address(hub), _collateralAmount);
		
		if (parentPosition == address(0)) {
			revert PositionCreationFailed();
		} else {
			// Clone existing position (simpler)
			_position = IPositionV2(hub.clone(
				parentPosition,
				_collateralAmount, // initialCollateral
				_mintAmount, // initialMint
				uint40(block.timestamp + 1090) // expiration
			));
		}

		// Step 2: Mint ZCHF from position
		// _position.mint(address(this), _mintAmount);

		// Step 3: Execute arbitrary actions with minted ZCHF
		_executeActions();

		// Step 4: Close position and recover collateral
		_closePosition();

		// Step 5: Swap recovered tokens back to flash loan token if needed
		if (_swapPath.length > 0) {
			_performFinalSwap();
		}

		// Step 6: Repay flash loan
		IERC20(_flashToken).forceApprove(address(morpho), assets);

		emit FlashLoanExecuted(
			_flashToken,
			_flashAmount,
			address(_position),
			_mintAmount,
			_actions.length
		);
	}

	function _executeActions() private {
		for (uint256 i = 0; i < _actions.length; i++) {
			Action memory action = _actions[i];
			
			(bool success, bytes memory returndata) = action.target.call{value: action.value}(action.data);
			
			if (!success && (_allowFailureMap & (1 << i)) == 0) {
				revert ActionFailed(i);
			}
		}
	}

	function _closePosition() private {
		// Get current minted amount
		uint256 currentMinted = _position.minted();
		IERC20(address(zchf)).forceApprove(address(_position), currentMinted);

		uint256 currentPrice = _position.price();
		_position.adjust(0, 0, currentPrice);
	}

	function _performFinalSwap() private {
		// Swap any remaining tokens back to flash token for repayment
		uint256 balance = zchf.balanceOf(address(this));
		if (balance > 0) {
			ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
				path: _swapPath,
				recipient: address(this),
				deadline: block.timestamp + 600,
				amountIn: balance,
				amountOutMinimum: 0
			});

			IERC20(address(zchf)).forceApprove(address(uniswap), balance);
			uniswap.exactInput(params);
		}
	}

	function _clearState() private {
		delete _sender;
		delete _flashToken;
		delete _flashAmount;
		delete _collateralToken;
		delete _collateralAmount;
		delete _mintAmount;
		delete _actions;
		delete _allowFailureMap;
		delete _position;
		delete _swapPath;
	}

	function recover(address token, address target, uint256 amount) external onlyOwner {
		IERC20(token).transfer(target, amount);
	}

	receive() external payable {}
}