// Minimal ERC-20 ABI — only the Transfer event. Every PotatoToken is a standard
// ERC-20, so holder balances are derived from these logs.
export const Erc20Abi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
    anonymous: false,
  },
] as const;
