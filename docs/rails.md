# Money rails

Checked 3 Oct 2026.

There is no custom Solana program. The server holds three wallets and a mint bank. The database is the per coin ledger. The vault wallet is where vault SOL lives and where payouts are sent from.

## Wallets

| Wallet | Share | Job |
|---|---|---|
| Vault | 75% | Receives the vault slice. Pays the builder in SOL on a pay vote. Buys $POS on a burn vote. Buys and burns the project coin on a miss, lapse, or abandon. |
| Builder | 15% | Runway. The connected wallet. Fees land here as the coin trades. Pay votes also send vault SOL here. |
| Platform | 10% | Platform treasury. |
| Crank | Pending | Pays transaction fees when the vault needs a separate fee payer. |

Public addresses are on `GET /v1/treasury`. Secrets stay in Railway env vars: `VAULT_SECRET`, `PLATFORM_SECRET`, `CRANK_SECRET`.

## Mint bank

Every contract address ends in `PoS`. The server grinds keypairs in the background and keeps a ready pool (`MINT_BANK_TARGET`, default 24). Launch pulls one instantly. The bank then grinds a replacement.

## Launch

`POST /v1/launch/submit` claims a mint from the bank, records the project as live, and stores the vault, platform, and crank addresses on the project. The builder stays the creator.

## Pay, burn, miss

The ledger moves first. The crank then sends from the vault wallet.

1. Pay: 60% of the vault is paid to the builder in SOL.
2. Burn vote: 60% buys $POS.
3. Miss, lapse, abandon: that slice buys the project coin and burns it.

If a send or swap fails, the bucket stays queued and the next crank retries.
