/**
 * Submit the off-chain orderbook state root for a pair to OracleAdmin.postOrderbookRoot().
 * S-2-1 — Lighter pattern: on-chain audit trail without storing full orderbook state.
 */

import { keccak256, encodePacked } from 'viem'
import type { WalletClient } from 'viem'
import { ORACLE_ADMIN_ABI } from './abis.js'
import { computeOrderbookStateRoot } from '../core/orderbook/OrderbookStateRoot.js'
import type { StoredOrder } from '../types/order.js'

const ZERO_ROOT = `0x${'0'.repeat(64)}` as `0x${string}`

/**
 * Parse the off-chain pairId string "0xBASE/0xQUOTE" into base and quote addresses.
 * Returns null if the format is unrecognised (e.g. "ETH/KRW" without 0x addresses).
 */
function parsePairId(offChainPairId: string): { base: `0x${string}`; quote: `0x${string}` } | null {
  const parts = offChainPairId.split('/')
  if (parts.length !== 2) return null
  const base  = parts[0]
  const quote = parts[1]
  if (!base  || !base.startsWith('0x')  || base.length  !== 42) return null
  if (!quote || !quote.startsWith('0x') || quote.length !== 42) return null
  return { base: base as `0x${string}`, quote: quote as `0x${string}` }
}

/**
 * Compute the state root for `pairId` and post it on-chain.
 * Skips submission if there are no open orders (root would be zero).
 * Never throws — errors are logged only.
 */
export async function submitOrderbookRoot(
  walletClient:    WalletClient,
  contractAddress: `0x${string}`,
  orders:          StoredOrder[],
  offChainPairId:  string,
): Promise<void> {
  try {
    const parsed = parsePairId(offChainPairId)
    if (!parsed) {
      console.warn(`[OrderbookRoot] cannot parse pairId "${offChainPairId}", skipping`)
      return
    }

    const root = computeOrderbookStateRoot(orders, offChainPairId)
    if (root === ZERO_ROOT) {
      // No open orders — skip to avoid unnecessary gas
      return
    }

    const onChainPairId = keccak256(encodePacked(
      ['address', 'address'],
      [parsed.base, parsed.quote],
    ))

    const hash = await walletClient.writeContract({
      chain:        undefined,
      account:      walletClient.account!,
      address:      contractAddress,
      abi:          ORACLE_ADMIN_ABI,
      functionName: 'postOrderbookRoot',
      args:         [onChainPairId, root],
    })

    console.log(`[OrderbookRoot] posted root=${root.slice(0, 10)}… for ${offChainPairId} txHash=${hash}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[OrderbookRoot] failed to post root for ${offChainPairId}: ${message}`)
  }
}
