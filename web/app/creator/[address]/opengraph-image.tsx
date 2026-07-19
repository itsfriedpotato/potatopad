import { ImageResponse } from "next/og";
import { isAddress, getAddress } from "viem";

export const runtime = "edge";
export const alt = "PotatoPad creator profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Props = { params: Promise<{ address: string }> };

export default async function Image({ params }: Props) {
  const { address: raw } = await params;
  const valid = isAddress(raw);
  const label = valid
    ? `${getAddress(raw).slice(0, 6)}…${getAddress(raw).slice(-4)}`
    : "Invalid address";

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#050505",
          color: "#f5f5f5",
          padding: 64,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 28, color: "#a3a3a3", letterSpacing: 2 }}>POTATOPAD</div>
          <div style={{ fontSize: 56, fontWeight: 700 }}>Planter profile</div>
          <div
            style={{
              fontSize: 40,
              fontFamily: "ui-monospace, monospace",
              color: "#f59e0b",
            }}
          >
            {label}
          </div>
        </div>
        <div style={{ fontSize: 24, color: "#737373" }}>
          Coins planted on Robinhood Chain · existence metrics only
        </div>
      </div>
    ),
    { ...size },
  );
}
