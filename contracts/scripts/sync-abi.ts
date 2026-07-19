/**
 * Regenerates the ABI blocks in `web/lib/abi.ts` from the compiled artifacts.
 *
 *   npx hardhat compile && npx ts-node scripts/sync-abi.ts
 *
 * `abi.ts` says "do not hand-edit" but had no tool to regenerate it, which is
 * how a hand-pasted block ended up indented differently from the rest. This
 * rewrites each `export const <name> = [...] as const;` block in place, so the
 * file keeps its comments, ordering and formatting.
 */
import * as fs from "fs";
import * as path from "path";

/** exported const name -> contract artifact name */
const BLOCKS: Record<string, string> = {
  potatoPadAbi: "PotatoPad",
  potatoTokenAbi: "PotatoToken",
  potatoRewardTokenAbi: "PotatoRewardToken",
  potatoFeeLockerAbi: "PotatoFeeLocker",
};

const ROOT = path.join(__dirname, "..");
const ABI_FILE = path.join(ROOT, "..", "web", "lib", "abi.ts");

function artifactAbi(name: string): unknown[] {
  const p = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`missing artifact: ${p} (run: npx hardhat compile)`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

/**
 * JSON at the file's house style. `JSON.stringify(_, null, 2)` already puts array
 * elements at two spaces, which is exactly what the rest of abi.ts uses — adding
 * another level here is what produced the four-space block in the first place.
 */
function render(abi: unknown[]): string {
  return JSON.stringify(abi, null, 2);
}

function main() {
  let src = fs.readFileSync(ABI_FILE, "utf8");
  let changed = 0;

  for (const [constName, contract] of Object.entries(BLOCKS)) {
    // Delimit by BLOCK BOUNDARIES rather than by matching the terminator.
    // Terminator matching is fragile here: a hand-pasted block had an indented
    // `] as const;`, so both a greedy and a column-anchored pattern ran past it
    // and swallowed the following block entirely. The next `export const` is an
    // unambiguous end marker regardless of how the block itself is indented.
    const start = src.search(new RegExp(`^export const ${constName} = \\[`, "m"));
    if (start < 0) {
      console.log(`  SKIP  ${constName} (block not found)`);
      continue;
    }
    const rest = src.slice(start + 1);
    const nextExport = rest.search(/^export const /m);
    const spanEnd = nextExport < 0 ? src.length : start + 1 + nextExport;

    const span = src.slice(start, spanEnd);
    const termIdx = span.lastIndexOf("] as const;");
    if (termIdx < 0) {
      console.log(`  SKIP  ${constName} (no terminator inside its span)`);
      continue;
    }

    const next = `export const ${constName} = ${render(artifactAbi(contract))} as const;`;
    src = src.slice(0, start) + next + span.slice(termIdx + "] as const;".length) + src.slice(spanEnd);
    changed++;
    console.log(`  ok    ${constName}  <- ${contract}`);
  }

  // Guard against exactly the failure above: never write a file that lost a
  // block. Cheap, and it turns a silent deletion into a loud abort.
  for (const constName of Object.keys(BLOCKS)) {
    if (!src.includes(`export const ${constName} = [`)) {
      throw new Error(`refusing to write: ${constName} disappeared from abi.ts`);
    }
  }

  fs.writeFileSync(ABI_FILE, src);
  console.log(`\n  rewrote ${changed} block(s) in web/lib/abi.ts`);
}

main();
