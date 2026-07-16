import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Read-only post-deploy check: confirms the deployed PotatoPad + locker are on
 * chain and wired to the correct Robinhood Chain Uniswap V3 (NPM + WETH) and the
 * 1% pool tier. No transactions are sent.
 *
 *   npx hardhat run scripts/verify-deploy.ts --network robinhoodMainnet
 */
const EXPECTED = {
  npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

async function main() {
  const file = path.join(__dirname, "../deployments.robinhoodMainnet.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const padCode = await ethers.provider.getCode(d.pad);
  const lockerCode = await ethers.provider.getCode(d.locker);
  console.log(`pad has code:    ${padCode.length > 2}`);
  console.log(`locker has code: ${lockerCode.length > 2}`);

  const pad = await ethers.getContractAt("PotatoPad", d.pad);
  const locker = await ethers.getContractAt("PotatoFeeLocker", d.locker);

  const [treasury, graduationEth, lockerAddr, totalSupply, curveSupply, poolFee] =
    await Promise.all([
      pad.treasury(),
      pad.graduationEth(),
      pad.locker(),
      pad.TOTAL_SUPPLY(),
      pad.CURVE_SUPPLY(),
      pad.POOL_FEE(),
    ]);
  const [lpPad, lpNpm, lpWeth] = await Promise.all([
    locker.pad(),
    locker.positionManager(),
    locker.weth(),
  ]);

  console.log(`\npad.treasury       = ${treasury}`);
  console.log(`pad.graduationEth  = ${ethers.formatEther(graduationEth)} ETH`);
  console.log(`pad.locker         = ${lockerAddr}`);
  console.log(`pad.TOTAL_SUPPLY   = ${ethers.formatUnits(totalSupply, 18)}`);
  console.log(`pad.CURVE_SUPPLY   = ${ethers.formatUnits(curveSupply, 18)}`);
  console.log(`pad.POOL_FEE       = ${poolFee.toString()} (10000 = 1% tier)`);
  console.log(`locker.pad         = ${lpPad}`);
  console.log(`locker.positionMgr = ${lpNpm}`);
  console.log(`locker.weth        = ${lpWeth}`);

  const checks = {
    "locker <-> pad linked":
      lockerAddr.toLowerCase() === d.locker.toLowerCase() &&
      lpPad.toLowerCase() === d.pad.toLowerCase(),
    "NPM matches Robinhood Uniswap V3":
      lpNpm.toLowerCase() === EXPECTED.npm.toLowerCase(),
    "WETH matches Robinhood WETH": lpWeth.toLowerCase() === EXPECTED.weth.toLowerCase(),
    "1% pool tier": poolFee.toString() === "10000",
    "supply 1B / curve 800M":
      ethers.formatUnits(totalSupply, 18) === "1000000000.0" &&
      ethers.formatUnits(curveSupply, 18) === "800000000.0",
  };
  console.log("");
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? "OK  " : "FAIL"} ${k}`);
    if (!v) allOk = false;
  }
  console.log(`\n${allOk ? "ALL CHECKS PASSED - deploy is correctly wired" : "SOME CHECKS FAILED - investigate before launching tokens"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
