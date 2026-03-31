import { EventEmitter } from 'events'
import type { MarginPosition, StoredOrder } from '../../types/order.js'
import type { MarkPriceOracle } from '../oracle/MarkPriceOracle.js'
import { v4 as uuid } from 'uuid'
import type { Hex } from 'viem'

export interface LiquidationEvent {
  position:  MarginPosition
  markPrice: bigint
  reason:    string
}

type SubmitFn = (order: StoredOrder, pairId: string) => Promise<void>

// Events: 'liquidation' (event: LiquidationEvent)
export class LiquidationEngine extends EventEmitter {
  private readonly liquidationSteps = new Map<string, number>()

  constructor(
    private readonly oracle:                 MarkPriceOracle,
    private readonly submitFn:               SubmitFn,
    private readonly maintenanceMarginBps = 250n,  // 2.5% = 250 bps
  ) {
    super()
  }

  async checkPositions(positions: MarginPosition[]): Promise<void> {
    for (const pos of positions) {
      if (pos.size === 0n) continue
      const markPrice = this.oracle.getMarkPrice(pos.pairId)
      if (markPrice === 0n) continue

      const absSize  = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * markPrice / 10n ** 18n
      const minMargin = notional * this.maintenanceMarginBps / 10000n

      if (pos.margin < minMargin) {
        const posKey = `${pos.maker}:${pos.pairId}`
        const step = this.liquidationSteps.get(posKey) ?? 0

        if (step >= 5) continue  // max steps reached — needs ADL or manual resolution

        const newStep = step + 1
        this.liquidationSteps.set(posKey, newStep)
        // Auto-cleanup on final step — position handed to ADL/manual resolution
        if (newStep >= 5) this.liquidationSteps.delete(posKey)
        this.emit('liquidation', {
          position: pos, markPrice,
          reason: `margin ${pos.margin} < maintenance ${minMargin} (step ${newStep}/5)`,
        } satisfies LiquidationEvent)
        await this.submitLiquidationOrder(pos, markPrice)
      }
    }
  }

  resetSteps(maker: string, pairId: string): void {
    const posKey = `${maker}:${pairId}`
    this.liquidationSteps.delete(posKey)
  }

  /**
   * Submits a partial liquidation market order for 20% of the position size.
   * Design: the engine does not track remaining size — callers must pass the
   * updated position on each checkPositions() call.
   */
  private async submitLiquidationOrder(pos: MarginPosition, _markPrice: bigint): Promise<void> {
    const LIQUIDATOR = '0x000000000000000000000000000000000000dead' as Hex
    const absSize = pos.size < 0n ? -pos.size : pos.size
    const partialAmount = absSize * 20n / 100n
    // Fallback: integer truncation would produce 0 for tiny positions
    const amount = partialAmount === 0n ? absSize : partialAmount
    const closeOrder: StoredOrder = {
      id:           uuid(),
      maker:        LIQUIDATOR,
      taker:        '0x0000000000000000000000000000000000000000' as Hex,
      baseToken:    pos.pairId.split('/')[0] as Hex,
      quoteToken:   pos.pairId.split('/')[1] as Hex,
      price:        0n,
      amount,
      isBuy:        pos.size < 0n,   // short position → buy to close
      nonce:        BigInt(Date.now()),
      expiry:       BigInt(Date.now()) / 1000n + 60n,
      signature:    '0x' as Hex,
      submittedAt:  Date.now(),
      filledAmount: 0n,
      status:       'open',
      makerIp:      'liquidation-engine',
      orderType:    'market',
    }
    await this.submitFn(closeOrder, pos.pairId)
  }
}
