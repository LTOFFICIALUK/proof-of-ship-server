export const POS_MINT = "H49xNgg1hMV6LqXK6if2g8CYnrvp7CxQ5SJTnDRwPoS";
export const POS_DECIMALS = 6;

const SOL_MINT = "So11111111111111111111111111111111111111112";

export type PosQuoter = (lamports: bigint) => Promise<bigint>;

const jupiterQuote: PosQuoter = async (lamports) => {
  const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", SOL_MINT);
  url.searchParams.set("outputMint", POS_MINT);
  url.searchParams.set("amount", lamports.toString());
  url.searchParams.set("slippageBps", "100");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("POS quote failed");
  }
  const body = (await response.json()) as { outAmount?: unknown };
  if (typeof body.outAmount !== "string" || !/^[0-9]+$/.test(body.outAmount)) {
    throw new Error("POS quote failed");
  }
  const out = BigInt(body.outAmount);
  if (out <= 0n) {
    throw new Error("POS quote failed");
  }
  return out;
};

let quoter: PosQuoter = jupiterQuote;

export const setPosQuoter = (next: PosQuoter) => {
  quoter = next;
};

export const quotePosOut = (lamports: bigint) => quoter(lamports);
