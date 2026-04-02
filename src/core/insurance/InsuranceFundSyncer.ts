import { EventEmitter } from 'events'
import type { PublicClient, Address } from 'viem'
import { ORDER_SETTLEMENT_ABI } from '../../chain/abis.js'
import type { IInsuranceFund } from './InsuranceFund.js'

/**
 * Resolves an on-chain bytes32 pairId (keccak256(baseToken + quoteToken))
 * to the off-chain string pairId used by the in-memory InsuranceFund.
 * Returns undefined if the pairId is not registered.
 */
export type PairIdResolver = (onChainPairId: `0x${string}`) => string | undefined

/**
 * Listens for `LiquidationFeeRouted` events from OrderSettlement on-chain
 * and applies the deposit to the in-memory InsuranceFund (G-9).
 *
 * This keeps the off-chain fund balance in sync with on-chain fee routing
 * so the liquidation engine can correctly assess cover capacity.
 *
 * Events emitted:
 *   'synced'  ({ onChainPairId, pairId, amount }) — deposit applied to fund
 *   'unknown' ({ onChainPairId, amount })          — pairId not in resolver; skipped
 *   'error'   (err: unknown)                       — watchContractEvent error
 */
export class InsuranceFundSyncer extends EventEmitter {
  private unwatch: (() => void) | null = null

  constructor(
    private readonly publicClient: PublicClient,
    private readonly contractAddress: Address,
    private readonly fund: IInsuranceFund,
    private readonly resolvePairId: PairIdResolver,
  ) {
    super()
  }

  start(): void {
    if (this.unwatch !== null) {
      throw new Error('InsuranceFundSyncer.start() called while already running')
    }

    this.unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: ORDER_SETTLEMENT_ABI,
      eventName: 'LiquidationFeeRouted',
      onLogs: (logs) => {
        for (const log of logs) {
          try {
            const { pairId: onChainPairId, amount } = log.args as {
              pairId: `0x${string}`
              token:  Address
              amount: bigint
            }
            const pairId = this.resolvePairId(onChainPairId)
            if (pairId === undefined) {
              this.emit('unknown', { onChainPairId, amount })
              continue
            }
            this.fund.deposit(pairId, amount)
            this.emit('synced', { onChainPairId, pairId, amount })
          } catch (err) {
            this.emit('error', err)
          }
        }
      },
      onError: (err) => {
        this.emit('error', err)
      },
    })
  }

  stop(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  get isRunning(): boolean {
    return this.unwatch !== null
  }
}
