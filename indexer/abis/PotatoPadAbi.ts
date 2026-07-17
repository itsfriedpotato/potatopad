// Minimal PotatoPad ABI — only the TokenCreated event the indexer needs. Kept in
// sync with contracts/contracts/PotatoPad.sol (event TokenCreated).
export const PotatoPadAbi = [
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol", type: "string" },
      { indexed: false, name: "pool", type: "address" },
      { indexed: false, name: "imageURI", type: "string" },
      { indexed: false, name: "website", type: "string" },
      { indexed: false, name: "twitter", type: "string" },
      { indexed: false, name: "telegram", type: "string" },
    ],
    anonymous: false,
  },
] as const;
