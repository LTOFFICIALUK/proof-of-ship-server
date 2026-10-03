import { publicImage } from "./presenters.js";

export type MarketSnapshot = {
  image: string | null;
  website: string | null;
  x: string | null;
  marketCapUsd: number | null;
  athUsd: number | null;
  volumeUsd: number | null;
  holders: number | null;
};

const empty = (): MarketSnapshot => ({
  image: null,
  website: null,
  x: null,
  marketCapUsd: null,
  athUsd: null,
  volumeUsd: null,
  holders: null,
});

const cache = new Map<string, { at: number; data: MarketSnapshot }>();
const CACHE_MS = 20_000;

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const httpsUrl = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const isXHost = (value: string) => {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host === "x.com" || host === "twitter.com";
  } catch {
    return false;
  }
};

const asX = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  const url = httpsUrl(raw);
  if (url) {
    return isXHost(url) ? url : null;
  }
  const handle = raw.replace(/^@/, "");
  if (!/^[\w.]{1,30}$/.test(handle)) {
    return null;
  }
  return `https://x.com/${handle}`;
};

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(2500),
    headers: {
      accept: "application/json",
      "user-agent": "proof-of-ship",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error("market lookup failed");
  }
  return response.json() as Promise<unknown>;
};

type PumpCoin = {
  image_uri?: unknown;
  website?: unknown;
  twitter?: unknown;
  usd_market_cap?: unknown;
  ath_market_cap?: unknown;
  volume_1h_usd?: unknown;
};

type DexPair = {
  marketCap?: unknown;
  volume?: { h24?: unknown };
  info?: {
    imageUrl?: unknown;
    websites?: { url?: unknown }[];
    socials?: { url?: unknown; type?: unknown }[];
  };
};

const loadFresh = async (mint: string): Promise<MarketSnapshot> => {
  const [pumpResult, dexResult, holderResult] = await Promise.allSettled([
    fetchJson("https://frontend-api-v3.pump.fun/coins/mints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mints: [mint] }),
    }),
    fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`),
    fetchJson(`https://advanced-api-v2.pump.fun/coins/top-holders-and-sol-balance/${mint}`),
  ]);

  const pump = pumpResult.status === "fulfilled" && Array.isArray(pumpResult.value)
    ? (pumpResult.value[0] as PumpCoin | undefined)
    : undefined;
  const pairs = dexResult.status === "fulfilled" &&
    dexResult.value &&
    typeof dexResult.value === "object" &&
    Array.isArray((dexResult.value as { pairs?: unknown }).pairs)
    ? ((dexResult.value as { pairs: DexPair[] }).pairs)
    : [];
  const pair = pairs.find((item) => num(item.marketCap) != null) ?? pairs[0];
  const holders = holderResult.status === "fulfilled" &&
    holderResult.value &&
    typeof holderResult.value === "object"
    ? num((holderResult.value as { totalHolders?: unknown }).totalHolders)
    : null;

  const websiteRaw = httpsUrl(pump?.website);
  const dexSite = pair?.info?.websites?.map((item) => httpsUrl(item.url)).find(Boolean) ?? null;
  const dexX = pair?.info?.socials?.find((item) => item.type === "twitter" || item.type === "x");
  const x = asX(pump?.twitter) ?? (websiteRaw && isXHost(websiteRaw) ? websiteRaw : null) ?? asX(dexX?.url);
  const website = websiteRaw && !isXHost(websiteRaw) ? websiteRaw : dexSite && !isXHost(dexSite) ? dexSite : null;

  return {
    image: publicImage(httpsUrl(pump?.image_uri) ?? httpsUrl(pair?.info?.imageUrl) ?? "") || null,
    website,
    x,
    marketCapUsd: num(pump?.usd_market_cap) ?? num(pair?.marketCap),
    athUsd: num(pump?.ath_market_cap),
    volumeUsd: num(pair?.volume?.h24) ?? num(pump?.volume_1h_usd),
    holders: pump || pairs.length ? holders : null,
  };
};

export const loadMarket = async (mint: string): Promise<MarketSnapshot> => {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.data;
  }
  try {
    const data = await loadFresh(mint);
    cache.set(mint, { at: Date.now(), data });
    return data;
  } catch {
    return empty();
  }
};
