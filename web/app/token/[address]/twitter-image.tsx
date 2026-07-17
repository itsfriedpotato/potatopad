import Image from "./opengraph-image";

// Twitter/X uses the same branded card as OpenGraph. Config is declared locally
// (Next can't statically read a re-exported `runtime`); only the renderer is shared.
export const runtime = "nodejs";
export const alt = "PotatoPad token";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default Image;
