import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      // Uniswap V4 uses transient storage (tstore/tload); Cancun is required for
      // the imported v4-core libraries to compile and run.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // Uniswap V4 pool ops are gas-heavy; keep generous limits for the demo.
      allowUnlimitedContractSize: false,
      blockGasLimit: 30_000_000,
      // The in-process EVM must support transient storage for the V4 singleton.
      hardfork: "cancun",
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // Robinhood Chain mainnet (Arbitrum Orbit L2, chainId 4663). Uniswap V3 is
    // live here at non-canonical addresses; see scripts/deploy.ts CANONICAL map.
    // Put your funded deployer key + Alchemy RPC in contracts/.env (gitignored).
    robinhoodMainnet: {
      url: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    // Robinhood Chain TESTNET (chainId 46630). NOTE: there is no canonical Uniswap
    // V3 deployment here, and no script in scripts/ currently provisions one, so a
    // Uniswap stack (WETH + factory + NPM + router) must be deployed to this network
    // before any launch will work.
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Blockscout accepts any non-empty key. Robinhood's explorer is Blockscout.
    apiKey: {
      robinhoodMainnet: process.env.ETHERSCAN_API_KEY || "blockscout",
    },
    customChains: [
      {
        network: "robinhoodMainnet",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
};

export default config;
