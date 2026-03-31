import type { WalletClient, Address, Hex } from 'viem'
import { ORDER_SETTLEMENT_ABI } from '../../chain/abis.js'
import type { MatchResult } from '../../types/order.js'

export async function settleBatch(
  walletClient: WalletClient,
  contractAddress: Address,
  batch: MatchResult[],
): Promise<Hex> {
  if (batch.length === 0) throw new Error('Empty batch')

  // Group by taker order: one taker, multiple makers
  // For MVP: treat each match as single-maker-single-taker (settle one taker per batch)
  // Production: group by takerOrder.id for true batch efficiency
  const takerOrder   = batch[0].takerOrder
  const takerSig     = batch[0].takerOrder.signature
  const makerOrders  = batch.map(m => m.makerOrder)
  const makerSigs    = batch.map(m => m.makerOrder.signature)
  const fillAmounts  = batch.map(m => m.fillAmount)

  const hash = await walletClient.writeContract({
    chain: undefined,
    account: walletClient.account!,
    address: contractAddress,
    abi: ORDER_SETTLEMENT_ABI,
    functionName: 'settleBatch',
    args: [
      makerOrders.map(o => ({
        maker: o.maker, taker: o.taker,
        baseToken: o.baseToken, quoteToken: o.quoteToken,
        price: o.price, amount: o.amount, isBuy: o.isBuy,
        nonce: o.nonce, expiry: o.expiry,
      })),
      {
        maker: takerOrder.maker, taker: takerOrder.taker,
        baseToken: takerOrder.baseToken, quoteToken: takerOrder.quoteToken,
        price: takerOrder.price, amount: takerOrder.amount, isBuy: takerOrder.isBuy,
        nonce: takerOrder.nonce, expiry: takerOrder.expiry,
      },
      fillAmounts,
      makerSigs,
      takerSig,
    ],
  })

  return hash
}
