# Rail spikes

Checked 2 Oct 2026 against the public Pump fees docs. No devnet or mainnet transaction was sent. A throwaway coin needs a funded signer, and this pass stops before `ship_vault`.

Sources: [CREATOR_FEE_SHARING.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATOR_FEE_SHARING.md) and the Pump fees IDL notes.

## What the docs say

1. `create_fee_sharing_config` creates a sharing config for the mint. The first shareholder list is the creator at 10,000 bps. It points the bonding curve creator, and the AMM coin creator after graduation, at that config.
2. `update_fee_shares_v2` replaces that list and sets `admin_revoked = true` in the same instruction. A second update should fail. Shares must be unique, each above 0, at most 10 addresses, and sum to exactly 10,000. 7,500 / 1,500 / 1,000 fits that rule.
3. The shareholder field is an address. The brief's vault has to be a system account with no data, because a system transfer cannot pay an account owned by another program. That part is still unproven against Pump's actual transfer.
4. Pump's public fee program is documented for mainnet. These docs do not describe a devnet deployment, so spike 1 cannot be treated as a devnet exercise until a devnet program id is confirmed.
5. `getMinimumDistributableFee`, the token program used by new mints, and the burn route (Jupiter versus a direct curve buy, then an SPL burn from a PDA) were not executed.

## Not run

| Spike | Result |
|---|---|
| PDA shareholder receives SOL on the curve and after graduation | Not run |
| Second `update_fee_shares_v2` fails after revoke | Not run. Docs say the first v2 update revokes admin |
| create, config, update, and buy in one transaction or bundle | Not run |
| Real `getMinimumDistributableFee` value | Not run |
| Token program for burns | Not run |
| Burn route and PDA token account | Not run |

## Conflict with the brief

The brief is right that the vault address is permanent once admin is revoked, so it cannot be a server wallet we plan to migrate later. It is not yet proven that Pump will pay a system PDA on both the curve and after graduation. Do not build `ship_vault` until those two transfers are seen on a throwaway mainnet coin.

`POST /v1/launch/build` returns the decoded steps. `POST /v1/launch/submit` still creates a demo project. Neither sends a pump.fun transaction.
