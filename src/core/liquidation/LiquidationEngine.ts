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
        this.emit('liquidation', {
          position: pos, markPrice,
          reason: `margin ${pos.margin} < maintenance ${minMargin}`,
        } satisfies LiquidationEvent)
        await this.submitLiquidationOrder(pos, markPrice)
      }
    }
  }

  private async submitLiquidationOrder(pos: MarginPosition, _markPrice: bigint): Promise<void> {
    const LIQUIDATOR = '0x000000000000000000000000000000000000dead' as Hex
    const closeOrder: StoredOrder = {
      id:           uuid(),
      maker:        LIQUIDATOR,
      taker:        '0x0000000000000000000000000000000000000000' as Hex,
      baseToken:    pos.pairId.split('/')[0] as Hex,
      quoteToken:   pos.pairId.split('/')[1] as Hex,
      price:        0n,
      amount:       pos.size < 0n ? -pos.size : pos.size,
      isBuy:        pos.size < 0n,   // short position → buy to close
      nonce:        BigInt(Date.now()),
      expiry:       BigInt(Math.floor(Date.now() / 1000) + 60),
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
