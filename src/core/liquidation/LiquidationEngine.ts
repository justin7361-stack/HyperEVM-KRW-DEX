import { EventEmitter } from 'events'
import type { MarginPosition, StoredOrder } from '../../types/order.js'
import type { MarkPriceOracle } from '../oracle/MarkPriceOracle.js'
import type { IInsuranceFund } from '../insurance/InsuranceFund.js'
import { v4 as uuid } from 'uuid'
import type { Hex } from 'viem'

export interface LiquidationEvent {
  position:  MarginPosition
  markPrice: bigint
  reason:    string
}

/**
 * A position eligible for liquidation, as returned by getLiquidatablePositions().
 * Used by the distributed liquidator API (S-3-1 — Orderly pattern).
 */
export interface LiquidatablePosition {
  maker:       string
  pairId:      string
  size:        bigint
  margin:      bigint
  minMargin:   bigint  // maintenance margin threshold
  markPrice:   bigint
  /** margin / minMargin — values < 1.0 are immediately liquidatable */
  healthRatio: number
}

/**
 * A single ADL candidate entry, ready for submission to on-chain settleADL().
 * Ranked by ADL score; lower index = higher priority (deleveraged first).
 *
 * ADL ranking algorithm (G-4):
 *   Score = effectiveLeverage = abs(size) × markPrice / 1e18 / margin
 *   Higher leverage → selected first.
 *   Reference:
 *     Hyperliquid — "고레버리지 고수익 포지션 우선" (high-leverage high-profit)
 *     dYdX v4    — ranked by unrealizedPnL% / margin ratio
 *   Without entry price, effectiveLeverage is the best available proxy.
 *
 * ADL direction rule:
 *   If the losing liquidated position was LONG  → select SHORT  candidates (they are profitable)
 *   If the losing liquidated position was SHORT → select LONG   candidates
 */
export interface ADLCandidate {
  maker:      string   // trader address
  pairId:     string
  quoteToken: string   // address of quoteToken (KRW stablecoin)
  amount:     bigint   // quoteToken amount to pull from this trader (≤ their margin)
  score:      bigint   // effectiveLeverage × SCALE; higher = higher priority
}

type SubmitFn = (order: StoredOrder, pairId: string) => Promise<void>

// Events: 'liquidation' (event: LiquidationEvent)
export class LiquidationEngine extends EventEmitter {
  private readonly liquidationSteps = new Map<string, number>()
  /** Mark price is considered stale after this many ms — liquidation is skipped until refreshed. */
  private readonly STALE_THRESHOLD_MS = 5 * 60 * 1000  // 5 minutes

  constructor(
    private readonly oracle:                 MarkPriceOracle,
    private readonly submitFn:               SubmitFn,
    private readonly maintenanceMarginBps = 250n,  // 2.5% = 250 bps
    private readonly insuranceFund?:         IInsuranceFund,
  ) {
    super()
  }

  async checkPositions(positions: MarginPosition[]): Promise<void> {
    for (const pos of positions) {
      if (pos.size === 0n) continue

      // SUG-1: use timestamped mark price to guard against stale oracle data
      const { price: markPrice, ts: markTs } = this.oracle.getMarkPriceWithTs(pos.pairId)
      if (markPrice === 0n) continue
      if (markTs > 0 && Date.now() - markTs > this.STALE_THRESHOLD_MS) {
        console.warn(`[LiquidationEngine] stale mark price for ${pos.pairId} (${Date.now() - markTs}ms old) — skipping liquidation check`)
        continue
      }

      const absSize  = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * markPrice / 10n ** 18n
      const minMargin = notional * this.maintenanceMarginBps / 10000n

      if (pos.margin < minMargin) {
        const posKey = `${pos.maker}:${pos.pairId}`
        const step = this.liquidationSteps.get(posKey) ?? 0

        // step is 0-indexed count of completed liquidations; cap at 5 (steps 0–4 = 5 total)
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
        if (this.insuranceFund) {
          // Speculative loss reservation: uses margin shortfall as a proxy for the
          // actual realised loss. True loss (debt minus liquidation proceeds) is only
          // known post-settlement. This pre-funds the insurance pool conservatively;
          // any over-reservation is corrected when the liquidation order settles.
          const estimatedLoss = minMargin - pos.margin
          if (estimatedLoss > 0n) {
            void this.insuranceFund.cover(pos.pairId, estimatedLoss)
          }
        }
      }
    }
  }

  /**
   * Returns all positions currently eligible for liquidation (health < 1.0).
   * Pure read — no side effects. Used by GET /liquidatable-positions.
   */
  getLiquidatablePositions(positions: MarginPosition[]): LiquidatablePosition[] {
    const result: LiquidatablePosition[] = []
    for (const pos of positions) {
      if (pos.size === 0n) continue
      const { price: markPrice, ts: markTs } = this.oracle.getMarkPriceWithTs(pos.pairId)
      if (markPrice === 0n) continue
      if (markTs > 0 && Date.now() - markTs > this.STALE_THRESHOLD_MS) continue
      const absSize  = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * markPrice / 10n ** 18n
      const minMargin = notional * this.maintenanceMarginBps / 10000n
      if (minMargin === 0n) continue
      if (pos.margin < minMargin) {
        result.push({
          maker:      pos.maker,
          pairId:     pos.pairId,
          size:       pos.size,
          margin:     pos.margin,
          minMargin,
          markPrice,
          healthRatio: Number(pos.margin) / Number(minMargin),
        })
      }
    }
    return result
  }

  /**
   * Trigger liquidation for a specific position from an external liquidator.
   * Validates the position is liquidatable, then executes via existing logic.
   * Returns true if liquidation was triggered, false if position is healthy.
   */
  async triggerExternalLiquidation(
    pos:      MarginPosition,
    liquidator: string,
  ): Promise<{ triggered: boolean; reason: string }> {
    if (pos.size === 0n) return { triggered: false, reason: 'position is flat' }

    const { price: markPrice, ts: markTs } = this.oracle.getMarkPriceWithTs(pos.pairId)
    if (markPrice === 0n) return { triggered: false, reason: 'no mark price' }
    if (markTs > 0 && Date.now() - markTs > this.STALE_THRESHOLD_MS) {
      return { triggered: false, reason: 'mark price stale' }
    }

    const absSize   = pos.size < 0n ? -pos.size : pos.size
    const notional  = absSize * markPrice / 10n ** 18n
    const minMargin = notional * this.maintenanceMarginBps / 10000n

    if (pos.margin >= minMargin) {
      return { triggered: false, reason: `position healthy (margin ${pos.margin} >= minMargin ${minMargin})` }
    }

    // Position is liquidatable — execute via existing internal logic
    const posKey = `${pos.maker}:${pos.pairId}`
    const step = (this.liquidationSteps.get(posKey) ?? 0) + 1
    this.liquidationSteps.set(posKey, step)
    if (step >= 5) this.liquidationSteps.delete(posKey)

    this.emit('liquidation', {
      position: pos, markPrice,
      reason: `external liquidator ${liquidator} (step ${step}/5)`,
    } satisfies LiquidationEvent)
    await this.submitLiquidationOrder(pos, markPrice)

    if (this.insuranceFund) {
      const estimatedLoss = minMargin - pos.margin
      if (estimatedLoss > 0n) void this.insuranceFund.cover(pos.pairId, estimatedLoss)
    }

    return { triggered: true, reason: `liquidated at step ${step}/5` }
  }

  resetSteps(maker: string, pairId: string): void {
    const posKey = `${maker}:${pairId}`
    this.liquidationSteps.delete(posKey)
  }

  /**
   * Select and rank ADL candidates when InsuranceFund is exhausted.
   *
   * Algorithm (G-4 — reference: Hyperliquid + dYdX v4):
   *   1. Filter positions for the given pairId that are on the OPPOSITE side
   *      from the losing liquidated position (they are the profitable counterparties).
   *   2. Score each candidate by effective leverage = abs(size) × markPrice / 1e18 / margin.
   *      (Proxy for "most leveraged = most profit relative to margin = fairest to deleverage first".)
   *   3. Sort descending by score (highest leverage = first ADL target).
   *   4. Accumulate candidates until their margin sum covers totalLoss.
   *   5. Each candidate's amount = min(pos.margin, remaining_loss_needed).
   *
   * @param positions       All open positions across all pairs.
   * @param pairId          Trading pair in distress.
   * @param quoteToken      Quote token address (for ADLEntry.quoteToken).
   * @param lossDirection   Direction of the LOSING position ('long'|'short').
   *                        ADL targets are the opposite direction.
   * @param totalLoss       Total quoteToken amount needed to cover the loss.
   * @param markPrice       Current mark price for the pair (18 decimals).
   * @returns               Ranked ADLCandidate[], highest priority first.
   *                        Empty if no eligible candidates.
   */
  selectADLTargets(
    positions:     MarginPosition[],
    pairId:        string,
    quoteToken:    string,
    lossDirection: 'long' | 'short',
    totalLoss:     bigint,
    markPrice:     bigint,
  ): ADLCandidate[] {
    if (totalLoss <= 0n || markPrice === 0n) return []

    const SCALE = 10n ** 18n

    // Step 1: filter to opposite-side, non-zero positions for this pairId with margin > 0
    // "long" loser → select "short" candidates (size < 0), and vice versa
    const targetSide = lossDirection === 'long' ? 'short' : 'long'
    const eligible = positions.filter(pos => {
      if (pos.pairId !== pairId) return false
      if (pos.size === 0n)       return false
      if (pos.margin <= 0n)      return false
      const isShort = pos.size < 0n
      return targetSide === 'short' ? isShort : !isShort
    })

    if (eligible.length === 0) return []

    // Step 2: compute score = effectiveLeverage × SCALE = absSize × markPrice / margin
    // (scaled to avoid integer truncation losses when margin >> notional)
    const scored = eligible.map(pos => {
      const absSize = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * markPrice / SCALE   // baseToken units → quoteToken-scaled
      // effectiveLeverage = notional / margin (both in quoteToken units)
      // Multiply first to preserve precision: score = notional * SCALE / margin
      const score = pos.margin > 0n ? notional * SCALE / pos.margin : 0n
      return { pos, score }
    })

    // Step 3: sort descending by score (highest leverage first)
    scored.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0))

    // Step 4 & 5: accumulate until totalLoss is covered
    const candidates: ADLCandidate[] = []
    let remaining = totalLoss

    for (const { pos, score } of scored) {
      if (remaining <= 0n) break
      // Each candidate contributes at most their full margin
      const amount = pos.margin < remaining ? pos.margin : remaining
      candidates.push({
        maker:      pos.maker,
        pairId:     pos.pairId,
        quoteToken,
        amount,
        score,
      })
      remaining -= amount
    }

    return candidates
  }

  /**
   * Submits a partial liquidation market order for 20% of the position size.
   * IMP-4: uses markPrice as the order price (previously hardcoded to 0n).
   * Design: the engine does not track remaining size — callers must pass the
   * updated position on each checkPositions() call.
   */
  private async submitLiquidationOrder(pos: MarginPosition, markPrice: bigint): Promise<void> {
    // IMP-4 guard: if mark price is somehow 0 at this point, skip rather than submit a broken order
    if (markPrice === 0n) return

    const LIQUIDATOR = '0x000000000000000000000000000000000000dead' as Hex
    const absSize = pos.size < 0n ? -pos.size : pos.size
    const partialAmount = absSize * 20n / 100n
    // Fallback: integer truncation would produce 0 for tiny positions
    const amount = partialAmount === 0n ? absSize : partialAmount
    const now = BigInt(Date.now())
    const closeOrder: StoredOrder = {
      id:           uuid(),
      maker:        LIQUIDATOR,
      taker:        '0x0000000000000000000000000000000000000000' as Hex,
      baseToken:    pos.pairId.split('/')[0] as Hex,
      quoteToken:   pos.pairId.split('/')[1] as Hex,
      price:        markPrice,  // IMP-4: use current mark price (not 0n)
      amount,
      isBuy:        pos.size < 0n,   // short position → buy to close
      nonce:        now,
      expiry:       now / 1000n + 60n,
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
