/**
 * Orderbook State Root computation (S-2-1 — Lighter pattern).
 *
 * Produces a deterministic keccak256 hash of the current open orderbook state
 * for a given pair. This root is periodically posted on-chain via
 * OracleAdmin.postOrderbookRoot() to provide an auditable trail of the
 * off-chain orderbook state without storing full order data on-chain.
 *
 * Algorithm:
 *   1. Filter open/partial orders for the pair.
 *   2. Sort by (id ASC) — UUID v4 strings are deterministic for a given set.
 *   3. For each order, compute leaf = keccak256(id ‖ maker ‖ price ‖ remaining ‖ isBuy).
 *   4. Return keccak256 of the concatenated 32-byte leaves (like a flat Merkle preimage).
 *      Returns bytes32(0) if no open orders exist.
 *
 * Reference: Lighter v2 off-chain order hash commitment scheme.
 */

import { keccak256, encodePacked, getAddress } from 'viem'
import type { StoredOrder } from '../../types/order.js'

/**
 * Compute the orderbook state root for a specific pair.
 *
 * @param orders  All orders to consider (will be filtered by pairId + status).
 * @param pairId  Off-chain pair identifier, e.g. "0xBASE/0xQUOTE".
 * @returns       0x-prefixed 32-byte hex string; all-zeros if no open orders.
 */
export function computeOrderbookStateRoot(
  orders: StoredOrder[],
  pairId: string,
): `0x${string}` {
  const ZERO_ROOT = `0x${'0'.repeat(64)}` as `0x${string}`

  const openOrders = orders
    .filter(o => {
      const oPairId = `${o.baseToken}/${o.quoteToken}`
      return oPairId === pairId && (o.status === 'open' || o.status === 'partial')
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  if (openOrders.length === 0) return ZERO_ROOT

  // Compute per-order leaf hashes
  const leaves = openOrders.map(o => {
    const remaining = o.amount - o.filledAmount
    // Encode: id (string), maker (address), price (uint256), remaining (uint256), isBuy (bool)
    return keccak256(encodePacked(
      ['string', 'address', 'uint256', 'uint256', 'bool'],
      [o.id, getAddress(o.maker), o.price, remaining, o.isBuy],
    ))
  })

  // Root = keccak256 of all leaves concatenated
  const concatenated = leaves.map(h => h.slice(2)).join('')  // strip 0x, join
  return keccak256(`0x${concatenated}` as `0x${string}`)
}
