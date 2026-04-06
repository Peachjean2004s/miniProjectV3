// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract LonganSupplyChain {

  

    enum Role   { None, Orchard, PackingHouse, Transporter, Retailer }
    enum Status { Harvested, ReceivedByPackingHouse, InTransit, ReceivedByRetailer, Sold }

    struct LonganLot {
        uint256 lotId;
        string  variety;       //  contract ใช้ใน splitLot เพื่อ inherit ให้ sub-lot
        uint256 weightKg;      //  ใช้ validate น้ำหนัก sub-lot ไม่เกิน parent
        address orchard;       //  contract ใช้ใน splitLot เพื่อ inherit ให้ sub-lot
        address currentOwner;  // ใช้ตรวจ ownership ทุก transaction
        address nextOwner;     //  ใช้ handshake
        Status  status;        //  ใช้ตรวจ flow
        uint256 createdAt;     //  timestamp on-chain
        uint256 parentLotId;   // original, >0 = sub-lot
    }

    // ==========================================
    // State
    // ==========================================

    mapping(address => Role)      public  userRoles;
    mapping(address => bool)      public  isRegistered;
    mapping(uint256 => LonganLot) private lots;
    mapping(uint256 => uint256[]) private lotToSubLots;
    uint256 public lotCounter;

    // ==========================================
    // Events
    // ==========================================

    event RoleRegistered(
        address indexed user,
        Role    indexed role,
        uint256 timestamp
    );

    event LotRegistered(
        uint256 indexed lotId,
        address indexed orchard,
        string  variety,
        uint256 weightKg,
        uint256 timestamp
    );

    // grade บันทึกใน event เท่านั้น
    // variety + orchard สืบจาก parent ผ่าน struct ใน splitLot
    event LotSplit(
        uint256 indexed parentLotId,
        uint256 indexed subLotId,
        address indexed packingHouse,
        string  grade,
        uint256 weightKg,
        uint256 timestamp
    );

    event HandshakeInitiated(
        uint256 indexed lotId,
        address indexed from,
        address indexed to,
        uint256 timestamp
    );

    event HandshakeCompleted(
        uint256 indexed lotId,
        address indexed newOwner,
        Status  newStatus,
        uint256 timestamp
    );

    event LotSold(
        uint256 indexed lotId,
        address indexed retailer,
        uint256 timestamp
    );

    // ==========================================
    // Modifiers
    // ==========================================

    modifier onlyRole(Role _role) {
        require(userRoles[msg.sender] == _role, "Unauthorized: Incorrect role");
        _;
    }

    modifier onlyCurrentOwner(uint256 _lotId) {
        require(lots[_lotId].currentOwner == msg.sender, "Unauthorized: Not the current owner");
        _;
    }

    modifier lotExists(uint256 _lotId) {
        require(_lotId > 0 && _lotId <= lotCounter, "Error: Lot does not exist");
        _;
    }

    // ==========================================
    // Registration
    // ==========================================

    function registerSelf(Role _role) external {
        require(_role != Role.None, "Invalid role");
        require(!isRegistered[msg.sender], "Already registered - role is immutable");
        userRoles[msg.sender]    = _role;
        isRegistered[msg.sender] = true;
        emit RoleRegistered(msg.sender, _role, block.timestamp);
    }

    // ==========================================
    // Original Lot — Orchard
    // ==========================================

    function registerLot(
        string calldata _variety,
        uint256 _weightKg
    ) external onlyRole(Role.Orchard) {
        require(_weightKg > 0, "Weight must be > 0");
        require(bytes(_variety).length > 0, "Variety required");

        lotCounter++;
        lots[lotCounter] = LonganLot({
            lotId:        lotCounter,
            variety:      _variety,
            weightKg:     _weightKg,
            orchard:      msg.sender,
            currentOwner: msg.sender,
            nextOwner:    address(0),
            status:       Status.Harvested,
            createdAt:    block.timestamp,
            parentLotId:  0
        });

        emit LotRegistered(lotCounter, msg.sender, _variety, _weightKg, block.timestamp);
    }

    // ==========================================
    // Sub-lot — PackingHouse
    // ==========================================

    function splitLot(
        uint256 _parentLotId,
        string  calldata _grade,
        uint256 _weightKg
    )
        external
        lotExists(_parentLotId)
        onlyRole(Role.PackingHouse)
        onlyCurrentOwner(_parentLotId)
    {
        require(bytes(_grade).length > 0, "Grade required");
        require(_weightKg > 0, "Weight must be > 0");
        require(lots[_parentLotId].parentLotId == 0, "Cannot split a sub-lot");
        require(
            lots[_parentLotId].status == Status.ReceivedByPackingHouse,
            "Parent lot must be ReceivedByPackingHouse"
        );

        // weightKg ใน struct ใช้ validate ตรงนี้
        uint256 used = _subLotsTotalWeight(_parentLotId);
        require(used + _weightKg <= lots[_parentLotId].weightKg, "Exceeds parent weight");

        lotCounter++;
        lots[lotCounter] = LonganLot({
            lotId:        lotCounter,
            variety:      lots[_parentLotId].variety,  // สืบจาก struct ของ parent
            weightKg:     _weightKg,
            orchard:      lots[_parentLotId].orchard,  // สืบจาก struct ของ parent
            currentOwner: msg.sender,
            nextOwner:    address(0),
            status:       Status.ReceivedByPackingHouse,
            createdAt:    block.timestamp,
            parentLotId:  _parentLotId
        });

        lotToSubLots[_parentLotId].push(lotCounter);

        // grade บันทึกใน event เท่านั้น ไม่เก็บใน struct
        emit LotSplit(_parentLotId, lotCounter, msg.sender, _grade, _weightKg, block.timestamp);
    }

    // ==========================================
    // Handshake Transfer
    // ==========================================

    function initiateTransfer(
        uint256 _lotId,
        address _to
    ) external lotExists(_lotId) onlyCurrentOwner(_lotId) {
        require(_to != address(0), "Invalid target address");
        require(_to != msg.sender, "Cannot transfer to yourself");
        require(lots[_lotId].status != Status.Sold, "Lot is already sold");
        require(lots[_lotId].nextOwner == address(0), "Transfer already pending");
        require(isRegistered[_to], "Receiver not registered");

        Role myRole     = userRoles[msg.sender];
        Role targetRole = userRoles[_to];

        if      (myRole == Role.Orchard)     require(targetRole == Role.PackingHouse, "Orchard must send to PackingHouse");
        else if (myRole == Role.PackingHouse) require(targetRole == Role.Transporter,  "PackingHouse must send to Transporter");
        else if (myRole == Role.Transporter)  require(targetRole == Role.Retailer,     "Transporter must send to Retailer");
        else revert("Invalid transfer flow");

        lots[_lotId].nextOwner = _to;
        emit HandshakeInitiated(_lotId, msg.sender, _to, block.timestamp);
    }

    function receiveLot(uint256 _lotId) external lotExists(_lotId) {
        require(lots[_lotId].nextOwner == msg.sender, "You are not the designated receiver");
        require(lots[_lotId].status != Status.Sold, "Lot is already sold");

        Role   myRole = userRoles[msg.sender];
        Status newStatus;

        if      (myRole == Role.PackingHouse) newStatus = Status.ReceivedByPackingHouse;
        else if (myRole == Role.Transporter)  newStatus = Status.InTransit;
        else if (myRole == Role.Retailer)     newStatus = Status.ReceivedByRetailer;
        else revert("Invalid receiver role");

        lots[_lotId].currentOwner = msg.sender;
        lots[_lotId].nextOwner    = address(0);
        lots[_lotId].status       = newStatus;

        emit HandshakeCompleted(_lotId, msg.sender, newStatus, block.timestamp);
    }

    function sellLot(uint256 _lotId)
        external
        lotExists(_lotId)
        onlyRole(Role.Retailer)
        onlyCurrentOwner(_lotId)
    {
        require(lots[_lotId].status == Status.ReceivedByRetailer, "Lot not at Retailer yet");
        lots[_lotId].status = Status.Sold;
        emit LotSold(_lotId, msg.sender, block.timestamp);
    }

    // ==========================================
    // View Functions
    // ==========================================

    function getLotInfo(uint256 _lotId)
        external view lotExists(_lotId) returns (LonganLot memory)
    {
        return lots[_lotId];
    }

    function getSubLotIds(uint256 _parentLotId)
        external view lotExists(_parentLotId) returns (uint256[] memory)
    {
        return lotToSubLots[_parentLotId];
    }

    function getRole(address _user) external view returns (Role) {
        return userRoles[_user];
    }

    // ==========================================
    // Internal
    // ==========================================

    function _subLotsTotalWeight(uint256 _parentLotId) internal view returns (uint256 total) {
        uint256[] memory ids = lotToSubLots[_parentLotId];
        for (uint256 i = 0; i < ids.length; i++) {
            total += lots[ids[i]].weightKg;
        }
    }
}
