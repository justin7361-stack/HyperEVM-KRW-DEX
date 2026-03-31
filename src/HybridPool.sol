// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IComplianceModule.sol";
import "./OracleAdmin.sol";
import "./FeeCollector.sol";

/// @title HybridPool
/// @notice KRW <-> USDC/USDT StableSwap pool (Curve 2-pool math) with oracle fallback.
/// @dev When |curve_out - oracle_out| / oracle_out > slippageThresholdBps, switches to oracle pricing.
///      LP tokens are minted as ERC20. Flash loan defense: no swap in same block as liquidity change.
contract HybridPool is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 private constant N_COINS = 2;
    uint256 private constant A_PRECISION = 100;
    uint256 private constant MAX_A = 1_000_000;
    uint256 private constant MAX_A_CHANGE = 10;
    uint256 private constant MIN_RAMP_TIME = 7 days;

    /// @notice Pool tokens: [0] = KRW stablecoin, [1] = USDC/USDT
    address[2] public tokens;
    /// @notice Internal balance tracking (avoids relying on raw ERC20 balances)
    uint256[2] public poolBalances;

    OracleAdmin       public oracle;
    IComplianceModule public compliance;
    FeeCollector      public feeCollector;

    uint256 public swapFeeBps;
    uint256 public slippageThresholdBps;

    // Amplification coefficient ramp
    uint256 public initialA;
    uint256 public futureA;
    uint256 public initialATime;
    uint256 public futureATime;

    /// @dev Flash loan defense: block number of last liquidity add/remove
    uint256 public lastLiquidityChangeBlock;

    /// @dev Read-only reentrancy guard (Curve 2023 bug mitigation)
    uint256 private _locked;

    event TokensSwapped(address indexed user, address tokenIn, uint256 amountIn, uint256 amountOut, bool oracleMode);
    event LiquidityAdded(address indexed provider, uint256[2] amounts, uint256 lpTokens);
    event LiquidityRemoved(address indexed provider, uint256 lpTokens, uint256[2] amounts);
    event RampA(uint256 oldA, uint256 newA, uint256 endTime);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the pool.
    /// @param admin Admin address (DEFAULT_ADMIN_ROLE)
    /// @param operator Operator address (OPERATOR_ROLE)
    /// @param krwToken KRW stablecoin address (tokens[0])
    /// @param quoteToken USDC/USDT address (tokens[1])
    /// @param _oracle OracleAdmin contract address
    /// @param _compliance Compliance module address
    /// @param _feeCollector FeeCollector contract address
    /// @param _A Initial amplification coefficient
    /// @param _swapFeeBps Swap fee in basis points
    /// @param _slippageThresholdBps Oracle fallback trigger threshold in bps
    function initialize(
        address admin,
        address operator,
        address krwToken,
        address quoteToken,
        address _oracle,
        address _compliance,
        address _feeCollector,
        uint256 _A,
        uint256 _swapFeeBps,
        uint256 _slippageThresholdBps
    ) external initializer {
        _initAddresses(admin, operator, krwToken, quoteToken, _oracle, _compliance, _feeCollector);
        _initParams(_A, _swapFeeBps, _slippageThresholdBps);
    }

    /// @dev Initialize addresses and inherited contracts (split to avoid stack-too-deep).
    function _initAddresses(
        address admin,
        address operator,
        address krwToken,
        address quoteToken,
        address _oracle,
        address _compliance,
        address _feeCollector
    ) private {
        require(admin != address(0),        "Zero address");
        require(operator != address(0),     "Zero address");
        require(krwToken != address(0),     "Zero address");
        require(quoteToken != address(0),   "Zero address");
        require(_oracle != address(0),      "Zero address");
        require(_compliance != address(0),  "Zero address");
        require(_feeCollector != address(0),"Zero address");

        __ERC20_init("HyperKRW LP", "KRWLP");
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE,      operator);

        tokens[0] = krwToken;
        tokens[1] = quoteToken;

        oracle       = OracleAdmin(_oracle);
        compliance   = IComplianceModule(_compliance);
        feeCollector = FeeCollector(_feeCollector);
    }

    /// @dev Initialize numeric parameters (split to avoid stack-too-deep).
    function _initParams(
        uint256 _A,
        uint256 _swapFeeBps,
        uint256 _slippageThresholdBps
    ) private {
        require(_A > 0 && _A <= MAX_A,  "Invalid A");
        require(_swapFeeBps <= 100,     "Fee too high");

        uint256 ampStored = _A * A_PRECISION;
        initialA     = ampStored;
        futureA      = ampStored;
        initialATime = block.timestamp;
        futureATime  = block.timestamp;

        swapFeeBps           = _swapFeeBps;
        slippageThresholdBps = _slippageThresholdBps;
        _locked = 1;
    }

    // ─────────────────────────────────────────────
    //  Read-only reentrancy guard
    // ─────────────────────────────────────────────

    // Defense-in-depth: `lock` implements read-only reentrancy protection (Curve 2023 pattern)
    // so that view functions like currentA() can detect mid-execution state via `notLocked`.
    // `nonReentrant` (ReentrancyGuardUpgradeable) guards against write-write reentrancy.
    // Both are intentionally applied together — they protect against different attack surfaces.
    modifier lock() {
        require(_locked == 1, "Reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier notLocked() {
        require(_locked == 1, "Pool locked");
        _;
    }

    // ─────────────────────────────────────────────
    //  LP functions
    // ─────────────────────────────────────────────

    /// @notice Add liquidity to the pool and receive LP tokens.
    /// @param amounts Amounts of [KRW, USDC] to deposit
    /// @param minLpOut Minimum LP tokens to receive (slippage protection)
    /// @return lpTokens LP tokens minted to caller
    function addLiquidity(uint256[2] memory amounts, uint256 minLpOut)
        external
        nonReentrant
        lock
        whenNotPaused
        returns (uint256 lpTokens)
    {
        uint256 totalSupply_ = totalSupply();

        if (totalSupply_ == 0) {
            uint256 d = _geometricMean(amounts);
            require(d > MINIMUM_LIQUIDITY, "Insufficient initial liquidity");
            lpTokens = d - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
        } else {
            uint256 minRatio = type(uint256).max;
            for (uint256 i = 0; i < N_COINS; i++) {
                if (amounts[i] > 0 && poolBalances[i] > 0) {
                    uint256 ratio = amounts[i] * 1e18 / poolBalances[i];
                    if (ratio < minRatio) minRatio = ratio;
                }
            }
            require(minRatio != type(uint256).max, "Zero amounts");
            lpTokens = minRatio * totalSupply_ / 1e18;
        }

        require(lpTokens >= minLpOut, "Insufficient LP tokens");

        // Note: transferFrom before balance update is a deliberate CEI relaxation for the LP
        // deposit path — tokens must be received before balances can be verified. Protected
        // by nonReentrant + lock, so reentrancy exploitation is not possible.
        for (uint256 i = 0; i < N_COINS; i++) {
            if (amounts[i] > 0) {
                IERC20(tokens[i]).safeTransferFrom(msg.sender, address(this), amounts[i]);
                poolBalances[i] += amounts[i];
            }
        }

        lastLiquidityChangeBlock = block.number;
        _mint(msg.sender, lpTokens);
        emit LiquidityAdded(msg.sender, amounts, lpTokens);
    }

    /// @notice Remove liquidity proportionally and receive underlying tokens.
    /// @param lpAmount LP tokens to burn
    /// @param minAmountsOut Minimum amounts of [KRW, USDC] to receive
    function removeLiquidity(uint256 lpAmount, uint256[2] memory minAmountsOut)
        external
        nonReentrant
        lock
        whenNotPaused
    {
        uint256 totalSupply_ = totalSupply();
        require(lpAmount > 0, "Zero amount");

        uint256[2] memory amounts;
        for (uint256 i = 0; i < N_COINS; i++) {
            amounts[i] = poolBalances[i] * lpAmount / totalSupply_;
            require(amounts[i] >= minAmountsOut[i], "Slippage exceeded");
        }

        // Effects
        lastLiquidityChangeBlock = block.number;
        _burn(msg.sender, lpAmount);
        for (uint256 i = 0; i < N_COINS; i++) {
            poolBalances[i] -= amounts[i];
        }

        // Interactions
        for (uint256 i = 0; i < N_COINS; i++) {
            if (amounts[i] > 0) {
                IERC20(tokens[i]).safeTransfer(msg.sender, amounts[i]);
            }
        }

        emit LiquidityRemoved(msg.sender, lpAmount, amounts);
    }

    // ─────────────────────────────────────────────
    //  Swap
    // ─────────────────────────────────────────────

    /// @notice Swap tokenIn for the other pool token.
    /// @param tokenIn Address of input token (must be tokens[0] or tokens[1])
    /// @param amountIn Amount of tokenIn to swap
    /// @param minAmountOut Minimum output amount (slippage protection)
    /// @return amountOut Amount of output token received
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        nonReentrant
        lock
        whenNotPaused
        returns (uint256 amountOut)
    {
        require(lastLiquidityChangeBlock < block.number, "No swap in liquidity block");
        require(amountIn > 0, "Zero amount");

        {
            (bool ok, string memory reason) = compliance.canSwap(msg.sender, amountIn);
            require(ok, reason);
        }

        uint256 i = _tokenIndex(tokenIn);
        uint256 j = 1 - i;

        (uint256 rawOut, uint256 fee, bool oracleMode) = _computeSwap(i, j, amountIn);
        amountOut = rawOut - fee;

        require(amountOut >= minAmountOut, "Slippage exceeded");

        // Effects (update internal balances before transfers)
        poolBalances[i] += amountIn;
        poolBalances[j] -= rawOut;

        // Interactions
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokens[j]).safeTransfer(msg.sender, amountOut);

        _collectFee(tokens[j], fee);

        emit TokensSwapped(msg.sender, tokenIn, amountIn, amountOut, oracleMode);
    }

    /// @dev Resolve token index. Reverts if tokenIn is not a pool token.
    function _tokenIndex(address tokenIn) internal view returns (uint256) {
        if (tokenIn == tokens[0]) return 0;
        if (tokenIn == tokens[1]) return 1;
        revert("Invalid tokenIn");
    }

    /// @dev Compute raw output, fee, and oracle mode for a swap.
    function _computeSwap(uint256 i, uint256 j, uint256 amountIn)
        internal
        view
        returns (uint256 rawOut, uint256 fee, bool oracleMode)
    {
        uint256 curveOut = _calcSwapCurve(i, j, amountIn);
        uint256 oracleOut = _calcSwapOracle(i, amountIn);

        if (oracleOut > 0) {
            uint256 diff = curveOut > oracleOut ? curveOut - oracleOut : oracleOut - curveOut;
            oracleMode = diff * 10_000 / oracleOut > slippageThresholdBps;
        }

        rawOut = oracleMode ? oracleOut : curveOut;
        require(rawOut > 0 && rawOut <= poolBalances[j], "Insufficient liquidity");

        fee = rawOut * swapFeeBps / 10_000;
    }

    /// @dev Send fee to FeeCollector if non-zero.
    function _collectFee(address token, uint256 fee) internal {
        if (fee > 0) {
            IERC20(token).forceApprove(address(feeCollector), fee);
            feeCollector.depositFee(token, fee);
        }
    }

    // ─────────────────────────────────────────────
    //  A ramp (7-day minimum)
    // ─────────────────────────────────────────────

    /// @notice Begin a gradual ramp of the amplification coefficient A.
    /// @dev Takes at least MIN_RAMP_TIME (7 days). Max 10x change per ramp.
    /// @param futureA_ Target A value (NOT multiplied by A_PRECISION -- the function handles it)
    /// @param futureTime_ Unix timestamp when futureA_ is reached
    function rampA(uint256 futureA_, uint256 futureTime_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(block.timestamp + MIN_RAMP_TIME <= futureTime_, "Ramp too short");
        uint256 currentA_ = _currentA();
        uint256 futureAScaled = futureA_ * A_PRECISION;
        require(futureAScaled > 0 && futureAScaled <= MAX_A * A_PRECISION, "Invalid A");
        require(
            (futureAScaled >= currentA_ && futureAScaled <= currentA_ * MAX_A_CHANGE) ||
            (futureAScaled < currentA_  && futureAScaled * MAX_A_CHANGE >= currentA_),
            "A change too large"
        );

        initialA     = currentA_;
        futureA      = futureAScaled;
        initialATime = block.timestamp;
        futureATime  = futureTime_;

        emit RampA(currentA_, futureAScaled, futureTime_);
    }

    /// @notice Get the current amplification coefficient (includes A_PRECISION scaling).
    /// @dev Returns interpolated value during ramp. Use currentA() / A_PRECISION for human-readable A.
    function currentA() public view notLocked returns (uint256) {
        return _currentA();
    }

    /// @dev Internal A calculation without the notLocked modifier (for use within lock()).
    function _currentA() internal view returns (uint256) {
        if (block.timestamp >= futureATime) return futureA;
        uint256 elapsed   = block.timestamp - initialATime;
        uint256 totalTime = futureATime - initialATime;
        if (futureA > initialA) {
            return initialA + (futureA - initialA) * elapsed / totalTime;
        } else {
            return initialA - (initialA - futureA) * elapsed / totalTime;
        }
    }

    /// @notice Pause the pool (admin only). Blocks swap, addLiquidity, removeLiquidity.
    function pause()   external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    /// @notice Unpause the pool (admin only).
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ─────────────────────────────────────────────
    //  Internal StableSwap math
    // ─────────────────────────────────────────────

    /// @dev Compute D invariant using Newton's method (Curve StableSwap formula).
    function _getD(uint256[2] memory xp, uint256 amp) internal pure returns (uint256) {
        uint256 S = xp[0] + xp[1];
        if (S == 0) return 0;

        uint256 D = S;
        uint256 Ann = amp * N_COINS;

        for (uint256 iter = 0; iter < 255; iter++) {
            uint256 Dprev = D;
            uint256 D_P = D;
            for (uint256 k = 0; k < N_COINS; k++) {
                D_P = D_P * D / (xp[k] * N_COINS + 1); // +1 to prevent div by zero
            }
            D = (Ann * S + D_P * N_COINS) * D /
                ((Ann - 1) * D + (N_COINS + 1) * D_P);

            if (D > Dprev) {
                if (D - Dprev <= 1) break;
            } else {
                if (Dprev - D <= 1) break;
            }
        }
        return D;
    }

    /// @dev Compute output balance y given new input balance x (Newton's method).
    function _getY(uint256 i, uint256 j, uint256 x, uint256[2] memory xp)
        internal
        view
        returns (uint256)
    {
        uint256 amp = _currentA();
        uint256 D   = _getD(xp, amp);
        if (D == 0) return 0;
        uint256 Ann = amp * N_COINS;

        uint256 c = D;
        uint256 S_ = 0;

        for (uint256 k = 0; k < N_COINS; k++) {
            uint256 x_;
            if (k == i) {
                x_ = x;
            } else if (k == j) {
                continue;
            } else {
                x_ = xp[k];
            }
            S_ += x_;
            c = c * D / (x_ * N_COINS + 1);
        }
        c = c * D / (Ann * N_COINS);
        uint256 b = S_ + D / Ann;

        uint256 y = D;
        for (uint256 iter = 0; iter < 255; iter++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > yPrev) {
                if (y - yPrev <= 1) break;
            } else {
                if (yPrev - y <= 1) break;
            }
        }
        return y;
    }

    /// @dev Calculate output amount using Curve StableSwap formula.
    function _calcSwapCurve(uint256 i, uint256 j, uint256 dx) internal view returns (uint256) {
        uint256[2] memory xp = [poolBalances[0], poolBalances[1]];
        if (xp[0] == 0 || xp[1] == 0) return 0;
        uint256 x = xp[i] + dx;
        uint256 y = _getY(i, j, x, xp);
        if (y >= xp[j]) return 0;
        return xp[j] - y - 1; // subtract 1 for rounding safety
    }

    /// @dev Calculate output amount using oracle price. Returns 0 if oracle unavailable.
    function _calcSwapOracle(uint256 i, uint256 dx) internal view returns (uint256) {
        try oracle.getPrice(tokens[1]) returns (uint256 price) {
            if (price == 0) return 0;
            if (i == 0) {
                // KRW -> USDC: out = dx / price
                return dx * 1e18 / price;
            } else {
                // USDC -> KRW: out = dx * price
                return dx * price / 1e18;
            }
        } catch {
            return 0;
        }
    }

    /// @dev Geometric mean sqrt(a*b) for initial LP amount. Overflow-safe.
    function _geometricMean(uint256[2] memory amounts) internal pure returns (uint256) {
        return _sqrt(amounts[0] * amounts[1]);
    }

    /// @dev Integer square root (Babylonian method).
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
