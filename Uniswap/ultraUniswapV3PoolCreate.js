// ====================================
// 智能 Uniswap V3 池子管理脚本
// 自动判断是否需要创建池子，并智能添加流动性
// 整合了池子创建逻辑 + 诊断分析逻辑 + 流动性添加逻辑
// ====================================

const { ethers } = require('ethers');

// ========== 配置区域 ==========
const CONFIG = {
    // Base Sepolia 测试网配置
    RPC_URL: "https://sepolia.base.org",
    PRIVATE_KEY: "Your Private Key",
    
    // 代币配置
    TOKEN_A: "0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B", // 代币A地址
    TOKEN_B: "0x66a00769800E651E9DbbA384d2B41A45A9660912", // 代币B地址
    
    // 流动性配置
    AMOUNT_A: "0.2",      // 人类可读数量
    AMOUNT_B: "0.2",      // 人类可读数量
    
    // 池子配置
    FEE: 3000,          // 0.3% 手续费
    SLIPPAGE: 5,        // 5% 滑点
    
    // 高级配置
    HUMAN_RATIO: true,  // true = 人类1:1比例, false = 原始单位1:1比例
    AUTO_RETRY: true,   // 自动重试
    MAX_RETRIES: 3,     // 最大重试次数
    
    // 调试和安全配置
    SAFE_MODE: true,    // 安全模式：失败时自动尝试全范围流动性
    DETAILED_ANALYSIS: true,  // 是否进行详细分析
    AUTO_PROCEED: true        // 是否自动执行
};

// ========== Base Sepolia 官方合约地址 ==========
const CONTRACTS = {
    POSITION_MANAGER: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    FACTORY: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"
};

// ========== 合约ABI ==========
const ABIS = {
    ERC20: [
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
        "function balanceOf(address) view returns (uint256)",
        "function approve(address spender, uint256 amount) returns (bool)",
        "function allowance(address owner, address spender) view returns (uint256)"
    ],
    
    POSITION_MANAGER: [
        "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
        "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"
    ],
    
    FACTORY: [
        "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
    ],
    
    POOL: [
        "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
        "function token0() external view returns (address)",
        "function token1() external view returns (address)",
        "function fee() external view returns (uint24)",
        "function tickSpacing() external view returns (int24)",
        "function liquidity() external view returns (uint128)"
    ]
};

class SmartPoolManager {
    constructor() {
        this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        this.wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider);
        
        this.positionManager = new ethers.Contract(
            CONTRACTS.POSITION_MANAGER, 
            ABIS.POSITION_MANAGER, 
            this.wallet
        );
        
        this.factory = new ethers.Contract(
            CONTRACTS.FACTORY,
            ABIS.FACTORY,
            this.provider
        );
    }

    // ========== 代币信息获取 ==========
    async getTokenInfo(tokenAddress) {
        const contract = new ethers.Contract(tokenAddress, ABIS.ERC20, this.provider);
        const [decimals, symbol] = await Promise.all([
            contract.decimals(),
            contract.symbol()
        ]);
        return { address: tokenAddress, decimals, symbol };
    }

    // ========== 池子创建相关方法（来自第一份代码）==========
    
    // 智能计算 sqrtPriceX96 - 支持人类可读比例
    calculateSqrtPriceX96(decimals0, decimals1, humanRatio = true) {
        console.log(`🔢 计算初始价格...`);
        console.log(`Token0 精度: ${decimals0}位, Token1 精度: ${decimals1}位`);
        
        try {
            let price;
            
            if (humanRatio) {
                // 人类可读的1:1比例
                console.log(`💡 使用人类可读1:1比例 (1 token0 = 1 token1)`);
                
                // 精度差异
                const decimalDiff = decimals1 - decimals0;
                console.log(`精度差异: ${decimals1} - ${decimals0} = ${decimalDiff}`);
                
                // 人类1:1 意味着: 1 * 10^decimals0 wei = 1 * 10^decimals1 wei
                // price = (1 * 10^decimals1) / (1 * 10^decimals0) = 10^(decimals1 - decimals0)
                price = Math.pow(10, decimalDiff);
                console.log(`价格比例 (token1/token0): ${price}`);
                
            } else {
                // 原始单位1:1比例
                console.log(`⚙️ 使用原始单位1:1比例`);
                price = 1;
            }
            
            // 计算 sqrt(price)
            const sqrtPrice = Math.sqrt(price);
            console.log(`sqrt(price): ${sqrtPrice}`);
            
            // 转换为 sqrtPriceX96 格式
            const Q96 = ethers.BigNumber.from(2).pow(96);
            let sqrtPriceX96;
            
            if (price < 1) {
                // 价格小于1时的精确处理
                // 使用字符串避免精度损失
                const sqrtPriceStr = sqrtPrice.toExponential();
                const [mantissa, exponent] = sqrtPriceStr.split('e');
                const mantissaNum = parseFloat(mantissa);
                const exp = parseInt(exponent);
                
                // 计算 mantissa * 2^96 * 10^exp
                const scaledMantissa = Math.floor(mantissaNum * 1e15); // 保留15位精度
                const mantissaBN = ethers.BigNumber.from(scaledMantissa.toString());
                const powerOf10 = ethers.BigNumber.from(10).pow(Math.abs(exp));
                
                if (exp < 0) {
                    sqrtPriceX96 = mantissaBN.mul(Q96).div(ethers.BigNumber.from(10).pow(15)).div(powerOf10);
                } else {
                    sqrtPriceX96 = mantissaBN.mul(Q96).mul(powerOf10).div(ethers.BigNumber.from(10).pow(15));
                }
                
            } else {
                // 价格大于等于1时的标准处理
                const sqrtPriceBN = ethers.BigNumber.from(Math.floor(sqrtPrice * 1e18));
                sqrtPriceX96 = sqrtPriceBN.mul(Q96).div(ethers.utils.parseUnits("1", 18));
            }
            
            // 验证范围
            const MIN_SQRT_RATIO = ethers.BigNumber.from("4295128739");
            const MAX_SQRT_RATIO = ethers.BigNumber.from("1461446703485210103287273052203988822378723970341");
            
            if (sqrtPriceX96.lt(MIN_SQRT_RATIO)) {
                console.log(`⚠️ 计算的价格过低，使用最小值`);
                sqrtPriceX96 = MIN_SQRT_RATIO;
            } else if (sqrtPriceX96.gt(MAX_SQRT_RATIO)) {
                console.log(`⚠️ 计算的价格过高，使用最大值`);
                sqrtPriceX96 = MAX_SQRT_RATIO;
            }
            
            console.log(`✅ sqrtPriceX96: ${sqrtPriceX96.toString()}`);
            
            // 验证计算结果
            this.validatePrice(sqrtPriceX96, decimals0, decimals1);
            
            return sqrtPriceX96;
            
        } catch (error) {
            console.log(`❌ 价格计算失败: ${error.message}`);
            console.log(`🔄 使用默认1:1价格`);
            return ethers.BigNumber.from(2).pow(96); // 默认 1:1
        }
    }

    // 验证价格计算的正确性
    validatePrice(sqrtPriceX96, decimals0, decimals1) {
        try {
            const Q96 = ethers.BigNumber.from(2).pow(96);
            const sqrtPrice = sqrtPriceX96.mul(ethers.utils.parseUnits("1", 18)).div(Q96);
            const price = sqrtPrice.mul(sqrtPrice).div(ethers.utils.parseUnits("1", 18));
            
            console.log(`🔍 价格验证:`);
            console.log(`   计算的价格比例: ${ethers.utils.formatUnits(price, 18)}`);
            
            if (CONFIG.HUMAN_RATIO) {
                const expectedPrice = Math.pow(10, decimals1 - decimals0);
                console.log(`   期望的价格比例: ${expectedPrice}`);
            }
        } catch (error) {
            console.log(`⚠️ 价格验证失败: ${error.message}`);
        }
    }

    // 计算最佳 tick 范围（修复版）
    getOptimalTickRange(fee, humanRatio = true, rangeMultiplier = 10) {
        let tickSpacing;
        if (fee === 500) tickSpacing = 10;
        else if (fee === 3000) tickSpacing = 60;
        else if (fee === 10000) tickSpacing = 200;
        else throw new Error("无效的手续费");

        // Uniswap V3 的实际最大/最小 tick（必须是 tickSpacing 的倍数）
        const MAX_TICK = 887272;
        const MIN_TICK = -887272;
        
        // 计算有效的最大/最小 tick（必须能被 tickSpacing 整除）
        const validMaxTick = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
        const validMinTick = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
        
        console.log(`🔧 Tick 约束: tickSpacing=${tickSpacing}, 有效范围=[${validMinTick}, ${validMaxTick}]`);

        let tickLower, tickUpper;
        
        if (humanRatio) {
            // 围绕 tick 0 创建对称范围（因为人类1:1对应 tick 0 附近）
            const rangeWidth = rangeMultiplier * tickSpacing;
            tickLower = -rangeWidth;
            tickUpper = rangeWidth;
            
            console.log(`💡 人类1:1模式: 围绕tick 0，范围宽度=${rangeWidth}`);
        } else {
            // 全范围流动性 - 使用有效的最大范围
            tickLower = validMinTick;
            tickUpper = validMaxTick;
            
            console.log(`🌍 全范围模式: 使用最大有效范围`);
        }
        
        // 确保 tick 是 tickSpacing 的倍数
        tickLower = Math.floor(tickLower / tickSpacing) * tickSpacing;
        tickUpper = Math.floor(tickUpper / tickSpacing) * tickSpacing;
        
        // 确保在有效范围内
        tickLower = Math.max(tickLower, validMinTick);
        tickUpper = Math.min(tickUpper, validMaxTick);
        
        // 额外验证：确保范围有效
        if (tickLower >= tickUpper) {
            console.log(`⚠️ Tick范围无效，强制使用最小有效范围`);
            tickLower = validMinTick;
            tickUpper = validMinTick + tickSpacing;
        }
        
        // 验证计算结果
        const isValidLower = (tickLower % tickSpacing === 0) && (tickLower >= validMinTick) && (tickLower <= validMaxTick);
        const isValidUpper = (tickUpper % tickSpacing === 0) && (tickUpper >= validMinTick) && (tickUpper <= validMaxTick);
        
        console.log(`🎯 Tick 范围: ${tickLower} 到 ${tickUpper} (间距: ${tickSpacing})`);
        console.log(`   范围类型: ${humanRatio ? '集中流动性' : '全范围'}`);
        console.log(`   范围宽度: ${tickUpper - tickLower} ticks`);
        console.log(`   验证结果: Lower=${isValidLower}, Upper=${isValidUpper}`);
        
        if (!isValidLower || !isValidUpper) {
            throw new Error(`Tick 验证失败: Lower=${tickLower}(${isValidLower}), Upper=${tickUpper}(${isValidUpper})`);
        }
        
        return { tickLower, tickUpper };
    }

    // 检查并处理代币授权
    async handleApproval(tokenAddress, symbol, amount) {
        const token = new ethers.Contract(tokenAddress, ABIS.ERC20, this.wallet);
        const allowance = await token.allowance(this.wallet.address, CONTRACTS.POSITION_MANAGER);
        
        if (allowance.gte(amount)) {
            console.log(`✅ ${symbol} 授权充足，跳过`);
            return;
        }
        
        console.log(`🔄 授权 ${symbol}...`);
        
        const gasPrice = await this.provider.getGasPrice();
        const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        
        const tx = await token.approve(CONTRACTS.POSITION_MANAGER, ethers.constants.MaxUint256, {
            nonce: nonce,
            gasLimit: 100000,
            gasPrice: gasPrice.mul(110).div(100)
        });
        
        console.log(`🔗 ${symbol} 授权交易: ${tx.hash}`);
        const receipt = await tx.wait(2);
        console.log(`${receipt.status === 1 ? '✅' : '❌'} ${symbol} 授权${receipt.status === 1 ? '成功' : '失败'}`);
    }

    // 检查代币余额
    async checkBalance(tokenAddress, requiredAmount, decimals, symbol) {
        const token = new ethers.Contract(tokenAddress, ABIS.ERC20, this.provider);
        const balance = await token.balanceOf(this.wallet.address);
        
        if (balance.lt(requiredAmount)) {
            throw new Error(`${symbol} 余额不足！需要 ${ethers.utils.formatUnits(requiredAmount, decimals)}，当前 ${ethers.utils.formatUnits(balance, decimals)}`);
        }
        
        console.log(`✅ ${symbol} 余额: ${ethers.utils.formatUnits(balance, decimals)}`);
    }

    // 验证新创建池子的状态
    async validateNewPool(poolAddress, expectedToken0, expectedToken1) {
        try {
            console.log("🔍 验证新创建的池子状态...");
            
            const poolContract = new ethers.Contract(poolAddress, ABIS.POOL, this.provider);
            
            // 读取池子基本信息
            const [slot0, token0, token1, fee, tickSpacing, liquidity] = await Promise.all([
                poolContract.slot0(),
                poolContract.token0(),
                poolContract.token1(),
                poolContract.fee(),
                poolContract.tickSpacing(),
                poolContract.liquidity()
            ]);

            console.log("📊 池子验证结果:");
            console.log(`   Token0: ${token0} (期望: ${expectedToken0}) ${token0.toLowerCase() === expectedToken0.toLowerCase() ? '✅' : '❌'}`);
            console.log(`   Token1: ${token1} (期望: ${expectedToken1}) ${token1.toLowerCase() === expectedToken1.toLowerCase() ? '✅' : '❌'}`);
            console.log(`   Fee: ${fee}`);
            console.log(`   Tick Spacing: ${tickSpacing}`);
            console.log(`   Current Tick: ${slot0.tick}`);
            console.log(`   Current Liquidity: ${liquidity.toString()}`);
            console.log(`   sqrtPriceX96: ${slot0.sqrtPriceX96.toString()}`);
            
            // 计算实际价格进行验证
            const Q96 = ethers.BigNumber.from(2).pow(96);
            const sqrtPrice = slot0.sqrtPriceX96.mul(ethers.utils.parseUnits("1", 18)).div(Q96);
            const price = sqrtPrice.mul(sqrtPrice).div(ethers.utils.parseUnits("1", 18));
            console.log(`   当前价格 (token1/token0): ${ethers.utils.formatUnits(price, 18)}`);
            
            // 验证 tick 范围的有效性
            const validMaxTick = Math.floor(887272 / tickSpacing) * tickSpacing;
            const validMinTick = Math.ceil(-887272 / tickSpacing) * tickSpacing;
            
            console.log(`   有效Tick范围: [${validMinTick}, ${validMaxTick}]`);
            console.log(`   当前Tick在有效范围内: ${slot0.tick >= validMinTick && slot0.tick <= validMaxTick ? '✅' : '❌'}`);
            
            return {
                isValid: true,
                poolState: { slot0, token0, token1, fee, tickSpacing, liquidity },
                constraints: { validMinTick, validMaxTick }
            };
            
        } catch (error) {
            console.error("❌ 池子验证失败:", error.message);
            return { isValid: false, error: error.message };
        }
    }
    async safeCreatePool(token0, token1, fee, sqrtPriceX96) {
        for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            try {
                console.log(`🎯 创建池子尝试 ${attempt}/${CONFIG.MAX_RETRIES}...`);
                
                const gasPrice = await this.provider.getGasPrice();
                const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
                
                // 尝试估算 gas
                let gasEstimate;
                try {
                    gasEstimate = await this.positionManager.estimateGas.createAndInitializePoolIfNecessary(
                        token0, token1, fee, sqrtPriceX96
                    );
                    console.log(`⛽ Gas 估算: ${gasEstimate.toString()}`);
                } catch (estimateError) {
                    console.log(`⚠️ Gas 估算失败，使用默认值`);
                    gasEstimate = ethers.BigNumber.from("2000000");
                }
                
                const tx = await this.positionManager.createAndInitializePoolIfNecessary(
                    token0, token1, fee, sqrtPriceX96,
                    { 
                        nonce: nonce,
                        gasLimit: gasEstimate.mul(120).div(100),
                        gasPrice: gasPrice.mul(110).div(100)
                    }
                );
                
                console.log(`🔗 创建池子交易: ${tx.hash}`);
                console.log("⏳ 等待确认...");
                
                const receipt = await tx.wait(2);
                
                if (receipt.status === 1) {
                    console.log("✅ 池子创建成功！");
                    return receipt;
                } else {
                    throw new Error("交易失败");
                }
                
            } catch (error) {
                console.log(`❌ 尝试 ${attempt} 失败: ${error.message}`);
                
                // 检查是否是池子已存在的错误
                if (error.message.includes("PoolAlreadyExists") || error.message.includes("already exists")) {
                    console.log("✅ 池子已存在！");
                    return { transactionHash: 'pool_exists' };
                }
                
                if (attempt === CONFIG.MAX_RETRIES) {
                    throw error;
                }
                
                if (CONFIG.AUTO_RETRY) {
                    console.log(`⏳ 等待 ${attempt * 3} 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, attempt * 3000));
                }
            }
        }
    }

    // ========== 池子诊断相关方法（来自第二份代码）==========
    
    // 详细分析池子状态
    async diagnosePool(poolAddress) {
        console.log("🔍 开始诊断池子状态...\n");

        try {
            const poolContract = new ethers.Contract(poolAddress, ABIS.POOL, this.provider);
            
            // 1. 读取池子基本信息
            const [slot0, token0, token1, fee, tickSpacing, liquidity] = await Promise.all([
                poolContract.slot0(),
                poolContract.token0(),
                poolContract.token1(),
                poolContract.fee(),
                poolContract.tickSpacing(),
                poolContract.liquidity()
            ]);

            console.log("📊 池子基本信息:");
            console.log(`   地址: ${poolAddress}`);
            console.log(`   Token0: ${token0}`);
            console.log(`   Token1: ${token1}`);
            console.log(`   Fee: ${fee} (${fee/10000}%)`);
            console.log(`   Tick Spacing: ${tickSpacing}`);
            console.log(`   Current Liquidity: ${liquidity.toString()}`);
            console.log("");

            // 2. 分析价格信息
            console.log("💰 价格信息:");
            console.log(`   Current Tick: ${slot0.tick}`);
            console.log(`   Current sqrtPriceX96: ${slot0.sqrtPriceX96.toString()}`);
            
            // 计算实际价格
            const Q96 = ethers.BigNumber.from(2).pow(96);
            const sqrtPrice = slot0.sqrtPriceX96.mul(ethers.utils.parseUnits("1", 18)).div(Q96);
            const price = sqrtPrice.mul(sqrtPrice).div(ethers.utils.parseUnits("1", 18));
            console.log(`   Calculated Price (token1/token0): ${ethers.utils.formatUnits(price, 18)}`);
            console.log("");

            // 3. 获取代币信息
            const [tokenAInfo, tokenBInfo] = await Promise.all([
                this.getTokenInfo(CONFIG.TOKEN_A),
                this.getTokenInfo(CONFIG.TOKEN_B)
            ]);

            console.log("🪙 代币信息:");
            console.log(`   Token A: ${tokenAInfo.symbol} (${tokenAInfo.decimals}位小数) - ${CONFIG.TOKEN_A}`);
            console.log(`   Token B: ${tokenBInfo.symbol} (${tokenBInfo.decimals}位小数) - ${CONFIG.TOKEN_B}`);
            console.log("");

            // 4. 分析代币顺序
            let decimals0, decimals1, symbol0, symbol1;
            if (token0.toLowerCase() === CONFIG.TOKEN_A.toLowerCase()) {
                decimals0 = tokenAInfo.decimals;
                decimals1 = tokenBInfo.decimals;
                symbol0 = tokenAInfo.symbol;
                symbol1 = tokenBInfo.symbol;
            } else {
                decimals0 = tokenBInfo.decimals;
                decimals1 = tokenAInfo.decimals;
                symbol0 = tokenBInfo.symbol;
                symbol1 = tokenAInfo.symbol;
            }

            console.log("🔄 池子中的代币顺序:");
            console.log(`   Token0: ${symbol0} (${decimals0}位小数)`);
            console.log(`   Token1: ${symbol1} (${decimals1}位小数)`);
            console.log("");

            // 5. 计算人类可读的价格比例
            const decimalDiff = decimals0 - decimals1;
            const humanPrice = parseFloat(ethers.utils.formatUnits(price, 18));
            const adjustedHumanPrice = humanPrice * Math.pow(10, decimalDiff);
            
            console.log("📈 人类可读的价格分析:");
            console.log(`   原始价格比例 (${symbol1}/${symbol0} in wei): ${humanPrice.toExponential()}`);
            console.log(`   调整精度后的比例 (${symbol1}/${symbol0} 人类可读): ${adjustedHumanPrice.toFixed(9)}`);
            console.log(`   这意味着: 1 ${symbol0} ≈ ${adjustedHumanPrice.toFixed(9)} ${symbol1}`);
            console.log("");

            // 6. 分析 tick 范围策略
            console.log("🎯 Tick 范围分析:");
            const currentTick = slot0.tick;
            const spacing = typeof tickSpacing === 'number' ? tickSpacing : tickSpacing.toNumber();
            
            // 计算多种范围策略
            const strategies = [
                { name: "极窄范围", multiplier: 1 },
                { name: "窄范围", multiplier: 3 },
                { name: "中等范围", multiplier: 10 },
                { name: "宽范围", multiplier: 50 },
                { name: "全范围", multiplier: 1000 }
            ];

            strategies.forEach(strategy => {
                const rangeWidth = strategy.multiplier * spacing;
                let tickLower = currentTick - rangeWidth;
                let tickUpper = currentTick + rangeWidth;
                
                // 标准化为 spacing 的倍数
                tickLower = Math.floor(tickLower / spacing) * spacing;
                tickUpper = Math.floor(tickUpper / spacing) * spacing;
                
                // 确保在有效范围内
                tickLower = Math.max(tickLower, -887200);
                tickUpper = Math.min(tickUpper, 887200);
                
                console.log(`   ${strategy.name}: ${tickLower} 到 ${tickUpper} (宽度: ${tickUpper - tickLower})`);
            });
            console.log("");

            // 7. 流动性建议
            console.log("💡 流动性添加建议:");
            
            if (liquidity.eq(0)) {
                console.log("   ⚠️ 池子当前没有流动性，你将是第一个LP");
                console.log("   📝 建议使用宽范围以确保成功");
                console.log("   🔧 推荐策略: 宽范围或全范围");
            } else {
                console.log("   ✅ 池子已有流动性");
                console.log("   📝 建议使用中等范围围绕当前价格");
                console.log("   🔧 推荐策略: 中等范围");
            }
            console.log("");

            return {
                poolState: { slot0, token0, token1, fee, tickSpacing, liquidity },
                tokenInfo: { decimals0, decimals1, symbol0, symbol1 },
                analysis: { currentTick, spacing, humanPrice: adjustedHumanPrice }
            };

        } catch (error) {
            console.error("❌ 诊断失败:", error.message);
            throw error;
        }
    }

    // ========== 流动性添加相关方法 ==========
    
    // 安全添加流动性（带全范围备选方案）
    async safeAddLiquidity(mintParams) {
        try {
            const gasPrice = await this.provider.getGasPrice();
            const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
            
            // 尝试估算 gas
            let gasEstimate;
            try {
                gasEstimate = await this.positionManager.estimateGas.mint(mintParams);
                console.log(`⛽ Mint Gas 估算: ${gasEstimate.toString()}`);
            } catch (estimateError) {
                console.log(`⚠️ Mint Gas 估算失败，使用默认值`);
                gasEstimate = ethers.BigNumber.from("3000000");
            }
            
            const mintTx = await this.positionManager.mint(mintParams, {
                nonce: nonce,
                gasLimit: gasEstimate.mul(120).div(100),
                gasPrice: gasPrice.mul(110).div(100)
            });
            
            console.log(`🔗 添加流动性交易: ${mintTx.hash}`);
            console.log("⏳ 等待确认...");
            
            const mintReceipt = await mintTx.wait(2);
            
            if (mintReceipt.status === 1) {
                console.log("🎉 流动性添加成功！");
                return mintReceipt;
            } else {
                throw new Error("流动性添加失败");
            }
            
        } catch (error) {
            console.error("❌ 流动性添加失败:", error.message);
            
            // 安全模式：尝试全范围流动性
            if (CONFIG.SAFE_MODE && mintParams.tickLower !== -887220 && mintParams.tickUpper !== 887220) {
                console.log("\n🛡️ 启动安全模式：尝试全范围流动性...");
                
                // 为 3000 fee (tickSpacing = 60) 计算有效的全范围
                const spacing = 60;
                const validMaxTick = Math.floor(887272 / spacing) * spacing; // 887220
                const validMinTick = Math.ceil(-887272 / spacing) * spacing; // -887220
                
                const safeMintParams = {
                    ...mintParams,
                    tickLower: validMinTick,
                    tickUpper: validMaxTick
                };
                
                console.log(`🔄 安全模式参数: tick范围 ${validMinTick} 到 ${validMaxTick}`);
                
                try {
                    return await this.safeAddLiquidity(safeMintParams);
                } catch (safeError) {
                    console.error("❌ 安全模式也失败了:", safeError.message);
                    throw error; // 抛出原始错误
                }
            }
            
            throw error;
        }
    }

    // 使用诊断结果添加流动性到现有池子
    async addLiquidityWithDiagnosis(poolAddress) {
        try {
            // 1. 诊断池子
            const diagnosis = await this.diagnosePool(poolAddress);
            const { poolState, tokenInfo, analysis } = diagnosis;

            // 2. 选择策略 - 使用宽范围确保成功
            console.log("🚀 开始添加流动性...");
            console.log("💡 策略: 使用宽范围围绕当前价格\n");

            const rangeMultiplier = poolState.liquidity.eq(0) ? 100 : 50; // 如果没有流动性用更宽的范围
            const rangeWidth = rangeMultiplier * analysis.spacing;
            
            let tickLower = analysis.currentTick - rangeWidth;
            let tickUpper = analysis.currentTick + rangeWidth;
            
            // 标准化
            tickLower = Math.floor(tickLower / analysis.spacing) * analysis.spacing;
            tickUpper = Math.floor(tickUpper / analysis.spacing) * analysis.spacing;
            
            // 限制范围
            tickLower = Math.max(tickLower, -887200);
            tickUpper = Math.min(tickUpper, 887200);

            console.log(`🎯 使用的 Tick 范围: ${tickLower} 到 ${tickUpper}`);
            console.log(`   宽度: ${tickUpper - tickLower} ticks`);
            console.log(`   当前价格在范围内: ${analysis.currentTick >= tickLower && analysis.currentTick <= tickUpper ? '✅' : '❌'}`);
            console.log("");

            // 3. 计算代币数量
            const amount0Desired = ethers.utils.parseUnits(CONFIG.AMOUNT_A, tokenInfo.decimals0);
            const amount1Desired = ethers.utils.parseUnits(CONFIG.AMOUNT_B, tokenInfo.decimals1);
            
            console.log(`💰 代币数量:`);
            console.log(`   Amount0 (${tokenInfo.symbol0}): ${ethers.utils.formatUnits(amount0Desired, tokenInfo.decimals0)}`);
            console.log(`   Amount1 (${tokenInfo.symbol1}): ${ethers.utils.formatUnits(amount1Desired, tokenInfo.decimals1)}`);
            console.log("");

            // 4. 检查授权
            console.log("🔐 检查授权...");
            await this.handleApproval(poolState.token0, tokenInfo.symbol0, amount0Desired);
            await this.handleApproval(poolState.token1, tokenInfo.symbol1, amount1Desired);
            console.log("");

            // 5. 准备交易参数
            const amount0Min = amount0Desired.mul(100 - CONFIG.SLIPPAGE).div(100);
            const amount1Min = amount1Desired.mul(100 - CONFIG.SLIPPAGE).div(100);
            const deadline = Math.floor(Date.now() / 1000) + 600;

            const mintParams = {
                token0: poolState.token0,
                token1: poolState.token1,
                fee: CONFIG.FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: this.wallet.address,
                deadline: deadline
            };

            console.log("📋 最终交易参数:");
            console.log(`   Tick Range: ${tickLower} to ${tickUpper}`);
            console.log(`   Amount0 Min: ${ethers.utils.formatUnits(amount0Min, tokenInfo.decimals0)} ${tokenInfo.symbol0}`);
            console.log(`   Amount1 Min: ${ethers.utils.formatUnits(amount1Min, tokenInfo.decimals1)} ${tokenInfo.symbol1}`);
            console.log(`   Slippage: ${CONFIG.SLIPPAGE}%`);
            console.log("");

            // 6. 执行交易
            const mintReceipt = await this.safeAddLiquidity(mintParams);
            console.log("");

            console.log("🎊 恭喜！流动性添加完成！");
            console.log("=" .repeat(50));
            console.log(`🏊 池子地址: ${poolAddress}`);
            console.log(`💱 代币对: ${tokenInfo.symbol0}/${tokenInfo.symbol1}`);
            console.log(`💸 手续费: ${CONFIG.FEE / 10000}%`);
            console.log(`🌊 添加的流动性: ${CONFIG.AMOUNT_A} ${tokenInfo.symbol0} + ${CONFIG.AMOUNT_B} ${tokenInfo.symbol1}`);
            console.log(`🎯 Tick 范围: ${tickLower} 到 ${tickUpper}`);
            console.log(`🔍 交易链接: https://sepolia.basescan.org/tx/${mintReceipt.transactionHash}`);
            console.log("=" .repeat(50));
            
            return true;

        } catch (error) {
            console.error("❌ 添加流动性失败:", error.message);
            return false;
        }
    }

    // ========== 主创建流程（整合第一份代码的逻辑）==========
    async createPoolWithInitialLiquidity() {
        try {
            console.log("🚀 开始创建优化的 Uniswap V3 池子...\n");

            // 1. 获取代币信息
            console.log("1️⃣ 获取代币信息...");
            const [tokenAInfo, tokenBInfo] = await Promise.all([
                this.getTokenInfo(CONFIG.TOKEN_A),
                this.getTokenInfo(CONFIG.TOKEN_B)
            ]);
            
            console.log(`代币A: ${tokenAInfo.symbol} (${tokenAInfo.decimals}位小数)`);
            console.log(`代币B: ${tokenBInfo.symbol} (${tokenBInfo.decimals}位小数)`);
            
            // 检查精度差异并给出提示
            const decimalDiff = Math.abs(tokenAInfo.decimals - tokenBInfo.decimals);
            if (decimalDiff > 0) {
                console.log(`⚠️ 检测到精度差异: ${decimalDiff}位`);
                console.log(`💡 将使用${CONFIG.HUMAN_RATIO ? '人类可读' : '原始单位'}1:1比例`);
            }
            console.log("");

            // 2. 确保代币顺序正确 (token0 < token1)
            let token0, token1, amount0, amount1, decimals0, decimals1, symbol0, symbol1;
            if (CONFIG.TOKEN_A.toLowerCase() < CONFIG.TOKEN_B.toLowerCase()) {
                token0 = CONFIG.TOKEN_A;
                token1 = CONFIG.TOKEN_B;
                amount0 = CONFIG.AMOUNT_A;
                amount1 = CONFIG.AMOUNT_B;
                decimals0 = tokenAInfo.decimals;
                decimals1 = tokenBInfo.decimals;
                symbol0 = tokenAInfo.symbol;
                symbol1 = tokenBInfo.symbol;
            } else {
                token0 = CONFIG.TOKEN_B;
                token1 = CONFIG.TOKEN_A;
                amount0 = CONFIG.AMOUNT_B;
                amount1 = CONFIG.AMOUNT_A;
                decimals0 = tokenBInfo.decimals;
                decimals1 = tokenAInfo.decimals;
                symbol0 = tokenBInfo.symbol;
                symbol1 = tokenAInfo.symbol;
            }

            console.log(`🔄 排序后: ${symbol0} (token0) < ${symbol1} (token1)\n`);

            // 3. 计算代币数量
            console.log("2️⃣ 计算代币数量...");
            const amount0Desired = ethers.utils.parseUnits(amount0.toString(), decimals0);
            const amount1Desired = ethers.utils.parseUnits(amount1.toString(), decimals1);
            
            console.log(`Amount0 Desired: ${ethers.utils.formatUnits(amount0Desired, decimals0)} ${symbol0}`);
            console.log(`Amount1 Desired: ${ethers.utils.formatUnits(amount1Desired, decimals1)} ${symbol1}`);
            console.log("");

            // 4. 检查余额
            console.log("3️⃣ 检查代币余额...");
            await this.checkBalance(token0, amount0Desired, decimals0, symbol0);
            await this.checkBalance(token1, amount1Desired, decimals1, symbol1);
            console.log("");

            // 5. 处理授权
            console.log("4️⃣ 处理代币授权...");
            await this.handleApproval(token0, symbol0, amount0Desired);
            await this.handleApproval(token1, symbol1, amount1Desired);
            console.log("");

            // 6. 计算价格和 tick 参数
            console.log("5️⃣ 计算池子参数...");
            const sqrtPriceX96 = this.calculateSqrtPriceX96(decimals0, decimals1, CONFIG.HUMAN_RATIO);
            const { tickLower, tickUpper } = this.getOptimalTickRange(CONFIG.FEE, CONFIG.HUMAN_RATIO);
            
            console.log(`📋 最终参数:`);
            console.log(`   sqrtPriceX96: ${sqrtPriceX96.toString()}`);
            console.log(`   Tick范围: ${tickLower} 到 ${tickUpper}`);
            console.log(`   比例类型: ${CONFIG.HUMAN_RATIO ? '人类1:1' : '原始1:1'}`);
            console.log("");

            // 7. 创建池子
            console.log("6️⃣ 创建池子...");
            const createReceipt = await this.safeCreatePool(token0, token1, CONFIG.FEE, sqrtPriceX96);
            
            // 获取新创建的池子地址
            const poolAddress = await this.factory.getPool(token0, token1, CONFIG.FEE);
            console.log(`🏊 新池子地址: ${poolAddress}\n`);
            
            // 8. 验证新创建的池子状态
            console.log("7️⃣ 验证池子状态...");
            const validation = await this.validateNewPool(poolAddress, token0, token1);
            
            if (!validation.isValid) {
                throw new Error(`池子验证失败: ${validation.error}`);
            }
            
            // 根据池子实际状态重新计算 tick 范围
            console.log("🔄 根据池子实际状态调整参数...");
            const { slot0 } = validation.poolState;
            const { validMinTick, validMaxTick } = validation.constraints;
            
            // 如果人类比例模式，围绕当前 tick 创建范围
            let adjustedTickLower, adjustedTickUpper;
            
            if (CONFIG.HUMAN_RATIO) {
                const rangeWidth = 10 * 60; // 对于 3000 fee，tickSpacing = 60
                adjustedTickLower = slot0.tick - rangeWidth;
                adjustedTickUpper = slot0.tick + rangeWidth;
                
                // 标准化为 tickSpacing 的倍数
                const spacing = 60; // CONFIG.FEE === 3000
                adjustedTickLower = Math.floor(adjustedTickLower / spacing) * spacing;
                adjustedTickUpper = Math.floor(adjustedTickUpper / spacing) * spacing;
                
                // 确保在有效范围内
                adjustedTickLower = Math.max(adjustedTickLower, validMinTick);
                adjustedTickUpper = Math.min(adjustedTickUpper, validMaxTick);
                
                console.log(`   调整后的Tick范围: ${adjustedTickLower} 到 ${adjustedTickUpper}`);
                console.log(`   围绕当前Tick(${slot0.tick})创建对称范围`);
            } else {
                // 全范围使用原来的计算
                adjustedTickLower = tickLower;
                adjustedTickUpper = tickUpper;
            }

            // 9. 添加流动性
            // 9. 添加流动性
            console.log("8️⃣ 添加流动性...");
            
            const amount0Min = amount0Desired.mul(100 - CONFIG.SLIPPAGE).div(100);
            const amount1Min = amount1Desired.mul(100 - CONFIG.SLIPPAGE).div(100);
            const deadline = Math.floor(Date.now() / 1000) + 600;

            const mintParams = {
                token0: token0,
                token1: token1,
                fee: CONFIG.FEE,
                tickLower: adjustedTickLower,  // 使用调整后的值
                tickUpper: adjustedTickUpper,  // 使用调整后的值
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: this.wallet.address,
                deadline: deadline
            };
            
            console.log("📋 最终 Mint 参数:");
            console.log(`   Token0: ${token0}`);
            console.log(`   Token1: ${token1}`);
            console.log(`   Fee: ${CONFIG.FEE}`);
            console.log(`   TickLower: ${adjustedTickLower}`);
            console.log(`   TickUpper: ${adjustedTickUpper}`);
            console.log(`   Amount0Desired: ${ethers.utils.formatUnits(amount0Desired, decimals0)} ${symbol0}`);
            console.log(`   Amount1Desired: ${ethers.utils.formatUnits(amount1Desired, decimals1)} ${symbol1}`);
            console.log(`   Amount0Min: ${ethers.utils.formatUnits(amount0Min, decimals0)} ${symbol0}`);
            console.log(`   Amount1Min: ${ethers.utils.formatUnits(amount1Min, decimals1)} ${symbol1}`);
            console.log("");

            const mintReceipt = await this.safeAddLiquidity(mintParams);
            console.log("");

            // 10. 显示最终结果
            console.log("🎊 恭喜！池子创建并添加流动性完成！");
            console.log("=" .repeat(60));
            console.log(`🏊 池子地址: ${poolAddress}`);
            console.log(`💱 代币对: ${symbol0}/${symbol1}`);
            console.log(`💸 手续费: ${CONFIG.FEE / 10000}%`);
            console.log(`🌊 初始流动性: ${amount0} ${symbol0} + ${amount1} ${symbol1}`);
            console.log(`🎯 价格比例: ${CONFIG.HUMAN_RATIO ? '人类1:1' : '原始1:1'}`);
            console.log(`📊 最终Tick范围: ${adjustedTickLower} 到 ${adjustedTickUpper}`);
            console.log(`🔧 当前池子Tick: ${slot0.tick}`);
            console.log(`🔍 Base Sepolia 浏览器: https://sepolia.basescan.org/address/${poolAddress}`);
            console.log(`💰 流动性交易: https://sepolia.basescan.org/tx/${mintReceipt.transactionHash}`);
            console.log("=" .repeat(60));

            return poolAddress;

        } catch (error) {
            console.error("❌ 创建失败:", error.message);
            
            console.log("\n🔧 问题排查建议:");
            console.log("1. 检查代币地址是否正确");
            console.log("2. 确保代币余额充足");
            console.log("3. 验证网络连接状态");
            console.log("4. 检查 gas 费用设置");
            console.log("5. 尝试降低流动性数量");
            console.log("6. 启用安全模式使用全范围流动性");
            console.log("7. 检查 tick 范围是否符合 tickSpacing 约束");
            
            throw error;
        }
    }

    // ========== 智能主流程 ==========
    async smartPoolManagement() {
        try {
            console.log("🤖 智能池子管理开始...\n");

            // 1. 检查池子是否已存在
            console.log("1️⃣ 检查池子是否存在...");
            const existingPool = await this.factory.getPool(CONFIG.TOKEN_A, CONFIG.TOKEN_B, CONFIG.FEE);
            
            if (existingPool !== ethers.constants.AddressZero) {
                console.log(`✅ 发现现有池子: ${existingPool}`);
                console.log("🔗 查看池子: https://sepolia.basescan.org/address/" + existingPool);
                console.log("");
                
                if (CONFIG.DETAILED_ANALYSIS) {
                    console.log("🔍 将进行详细池子分析...\n");
                    const success = await this.addLiquidityWithDiagnosis(existingPool);
                    return { action: 'ADD_LIQUIDITY', poolAddress: existingPool, success };
                } else {
                    console.log("⚡ 直接添加流动性（跳过详细分析）...\n");
                    // 这里可以添加简化版的流动性添加逻辑
                    return { action: 'ADD_LIQUIDITY_SIMPLE', poolAddress: existingPool };
                }
                
            } else {
                console.log("❌ 池子不存在");
                console.log("🚀 将创建新池子并添加初始流动性...\n");
                
                const poolAddress = await this.createPoolWithInitialLiquidity();
                return { action: 'CREATE_POOL', poolAddress, success: true };
            }

        } catch (error) {
            console.error("❌ 智能管理失败:", error.message);
            throw error;
        }
    }
}

// ========== 执行脚本 ==========
async function main() {
    console.log("=".repeat(60));
    console.log("🦄 智能 Uniswap V3 池子管理脚本");
    console.log("🌐 Base Sepolia 测试网");
    console.log("=".repeat(60));
    
    console.log("🧠 智能特性:");
    console.log("   ✅ 自动检测池子是否存在");
    console.log("   ✅ 池子不存在时自动创建");
    console.log("   ✅ 池子存在时智能添加流动性");
    console.log("   ✅ 智能精度处理");
    console.log("   ✅ 人类可读1:1比例");
    console.log("   ✅ 自动重试机制");
    console.log("   ✅ 详细池子诊断分析");
    console.log("   ✅ Tick范围验证和修复");
    console.log("   ✅ 安全模式备选方案");
    console.log("   ✅ 完整错误处理");
    console.log("");
    console.log("⚙️ 当前配置:");
    console.log(`   代币A: ${CONFIG.TOKEN_A}`);
    console.log(`   代币B: ${CONFIG.TOKEN_B}`);
    console.log(`   比例类型: ${CONFIG.HUMAN_RATIO ? '人类1:1' : '原始1:1'}`);
    console.log(`   手续费: ${CONFIG.FEE / 10000}%`);
    console.log(`   流动性: ${CONFIG.AMOUNT_A} + ${CONFIG.AMOUNT_B}`);
    console.log(`   安全模式: ${CONFIG.SAFE_MODE ? '启用' : '禁用'}`);
    console.log(`   详细分析: ${CONFIG.DETAILED_ANALYSIS ? '启用' : '禁用'}`);
    console.log("");
    console.log("⛽ 获取测试 ETH: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet");
    console.log("");

    try {
        const manager = new SmartPoolManager();
        const result = await manager.smartPoolManagement();
        
        console.log("\n🎯 执行结果:");
        console.log(`   动作: ${result.action}`);
        console.log(`   池子地址: ${result.poolAddress}`);
        console.log(`   状态: ${result.success ? '成功' : '失败'}`);
        
    } catch (error) {
        console.error("\n💥 脚本执行失败:", error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = SmartPoolManager;