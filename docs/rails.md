# Money rails

Checked 3 Oct 2026.

There is no custom Solana program. The server holds three wallets and a mint bank. The database is the per coin ledger. The vault wallet is the only pump.fun fee earner we set.

## Wallets

| Wallet | After we split | Job |
|---|---|---|
| Vault | Keeps 75% | pump.fun pays 100% of creator fees here. We send runway and platform out. We pay the builder on a pay vote. We buy $POS on a burn vote. We buy and burn the project coin on a miss, lapse, or abandon. |
| Builder | Gets 15% from us | Runway. We send this from the vault as fees land. Pay votes also send vault SOL here. |
| Platform | Gets 10% from us | Platform treasury. We send this from the vault as fees land. |
| Crank | Pending | Pays transaction fees when needed. |

pump.fun fee sharing on each mint is a single share: 10,000 bps to the vault `Fmfq7v3tZ6PkCPJ3VG1HwWqRVDyaRp1nAJ3Lrhkb2XgB`. The builder stays the creator. They do not receive creator fees from pump.fun.

Public addresses are on `GET /v1/treasury`. Secrets stay in Railway env vars: `VAULT_SECRET`, `PLATFORM_SECRET`, `CRANK_SECRET`.

## Mint bank

Every contract address ends in `PoS`. The server grinds keypairs in the background and keeps a ready pool. Launch pulls one instantly. The bank then grinds a replacement.

## Launch

`POST /v1/launch/submit` claims a mint from the bank, records the project as live, and stores the vault, platform, and crank addresses on the project.

## Pay, burn, miss

The ledger moves first. The crank then sends from the vault wallet.

1. Fees land in the vault. We send 15% to the builder and 10% to the platform. 75% stays.
2. Pay: 60% of the remaining vault is paid to the builder in SOL.
3. Burn vote: 60% buys $POS.
4. Miss, lapse, abandon: that slice buys the project coin and burns it.

If a send or swap fails, the bucket stays queued and the next crank retries.
