// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Proxy {
    address public logicContract; // Address of the logic contract
    address public immutable reserveContract; // Address of the reserve contract
    address public admin; // Admin who can upgrade the logic contract

    event LogicContractUpgraded(address newLogicContract);

    constructor(address _reserveContract) {
        require(_reserveContract != address(0), "Invalid reserve contract address");
        reserveContract = _reserveContract;
        admin = msg.sender; // Admin is the deployer
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Caller is not admin");
        _;
    }

    function upgradeLogicContract(address _newLogicContract) external onlyAdmin {
        require(_newLogicContract != address(0), "Invalid logic contract address");
        logicContract = _newLogicContract;
        emit LogicContractUpgraded(_newLogicContract);
    }

    fallback() external payable {
        address _impl = logicContract;
        require(_impl != address(0), "Logic contract is not set");

        assembly {
            // Delegate call to logic contract
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), _impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
