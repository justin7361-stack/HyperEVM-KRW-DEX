import type { MatchResult, StoredOrder, OrderBookDepth } from '../../types/order.js'
import type { IOrderBookStore } from './IOrderBookStore.js'

export class OrderBook {
  constructor(
    private readonly store: IOrderBookStore,
    private readonly pairId: string,
  ) {}

  // Submit an order, run matching, return all matches produced
  async submit(order: StoredOrder): Promise<MatchResult[]> {
    await this.store.addOrder(order)
    return this.runMatching(order)
  }

  async getDepth(levels: number): Promise<OrderBookDepth> {
    return this.store.getDepth(this.pairId, levels)
  }

  async removeOrder(orderId: string): Promise<void> {
    await this.store.removeOrder(orderId)
  }

  private async runMatching(incoming: StoredOrder): Promise<MatchResult[]> {
    const results: MatchResult[] = []

    while (true) {
      const incoming_ = await this.store.getOrder(incoming.id)
      if (!incoming_ || (incoming_.status !== 'open' && incoming_.status !== 'partial')) break

      const remaining = incoming_.amount - incoming_.filledAmount
      if (remaining <= 0n) break

      // Find counterparty
      const counter = incoming_.isBuy
        ? await this.store.getBestAsk(this.pairId)
        : await this.store.getBestBid(this.pairId)

      if (!counter || counter.id === incoming_.id) break

      // Price check: buy price must be >= sell price
      const bid = incoming_.isBuy ? incoming_ : counter
      const ask = incoming_.isBuy ? counter   : incoming_

      if (bid.price < ask.price) break

      // Fill at maker (ask) price — the ask is always the maker in price-time priority
      const execPrice   = ask.price
      const counterRem  = counter.amount - counter.filledAmount
      const fillAmount  = remaining < counterRem ? remaining : counterRem

      // Update both orders
      const newIncomingFill = incoming_.filledAmount + fillAmount
      const newCounterFill  = counter.filledAmount  + fillAmount

      await this.store.updateOrder(incoming_.id, {
        filledAmount: newIncomingFill,
        status: newIncomingFill >= incoming_.amount ? 'filled' : 'partial',
      })
      await this.store.updateOrder(counter.id, {
        filledAmount: newCounterFill,
        status: newCounterFill >= counter.amount ? 'filled' : 'partial',
      })

      const makerOrder = incoming_.isBuy ? counter    : incoming_
      const takerOrder = incoming_.isBuy ? incoming_  : counter

      results.push({
        makerOrder, takerOrder,
        fillAmount,
        price: execPrice,
        matchedAt: Date.now(),
      })
    }

    return results
  }
}
