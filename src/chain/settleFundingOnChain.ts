// src/chain/settleFundingOnChain.ts
//
// Wires off-chain FundingPayment events to the on-chain
// OrderSettlement.settleFunding(FundingPayment[], address reserve) call.
//
// Contract signature (OrderSettlement.sol):
//   struct FundingPayment {
//     address maker;
//     address quoteToken;   // KRW stablecoin
//     int256  amount;       // scaled 1e18; positive = maker receives, negative = maker pays
//     bytes32 pairId;       // keccak256(abi.encodePacked(baseToken, quoteToken))
//     uint256 timestamp;
//   }
//   function settleFunding(FundingPayment[] calldata payments, address reserve) external;
//
// The server-side pairId is the off-chain string "0xBASE/0xQUOTE".
// We parse quoteToken from it and compute the on-chain bytes32 pairId.

import { keccak256, encodePacked } from 'viem'
import type { WalletClient } from 'viem'
import type { FundingPayment } from '../core/funding/FundingRateEngine.js'
import { ORDER_SETTLEMENT_ABI } from './abis.js'

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
 * Submit a single funding payment to the on-chain OrderSettlement.settleFunding().
 *
 * Errors are caught and logged — this function never throws so a failed
 * funding settlement cannot crash the server.
 *
 * @param walletClient     viem WalletClient (operator account)
 * @param contractAddress  OrderSettlement contract address
 * @param payment          Off-chain FundingPayment emitted by FundingRateEngine
 * @param reserve          Protocol reserve address (holds funds for outgoing payments)
 */
export async function settleFundingOnChain(
  walletClient: WalletClient,
  contractAddress: `0x${string}`,
  payment: FundingPayment,
  reserve: `0x${string}`,
): Promise<void> {
  try {
    // Skip zero-amount payments — the contract also skips them, but saves gas.
    if (payment.amount === 0n) return

    // Derive base/quoteToken from the off-chain pairId string.
    const parsed = parsePairId(payment.pairId)
    if (!parsed) {
      console.warn(`[Funding] settleFundingOnChain: cannot parse pairId "${payment.pairId}", skipping`)
      return
    }

    // Compute the on-chain bytes32 pairId: keccak256(abi.encodePacked(base, quote))
    const onChainPairId = keccak256(encodePacked(
      ['address', 'address'],
      [parsed.base, parsed.quote],
    ))

    const hash = await walletClient.writeContract({
      chain:        undefined,
      account:      walletClient.account!,
      address:      contractAddress,
      abi:          ORDER_SETTLEMENT_ABI,
      functionName: 'settleFunding',
      args: [
        [
          {
            maker:      payment.maker as `0x${string}`,
            quoteToken: parsed.quote,
            amount:     payment.amount,       // int256 — bigint, signed
            pairId:     onChainPairId,
            timestamp:  BigInt(payment.timestamp),
          },
        ],
        reserve,
      ],
    })

    console.log(`[Funding] settled on-chain txHash=${hash}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Funding] on-chain settlement failed: ${message}`)
  }
}
