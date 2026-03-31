import { EventEmitter } from 'events'
import type { PublicClient, Address } from 'viem'
import { ORDER_SETTLEMENT_ABI } from '../../chain/abis.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'

// Events:
//   'orderFilled'    ({ maker, taker, baseToken, fillAmount, fee })
//   'orderCancelled' ({ user, nonce })
export class ChainWatcher extends EventEmitter {
  private unwatchFilled:    (() => void) | null = null
  private unwatchCancelled: (() => void) | null = null

  constructor(
    private readonly publicClient: PublicClient,
    private readonly contractAddress: Address,
    private readonly store: IOrderBookStore,
  ) {
    super()
  }

  start(): void {
    if (this.unwatchFilled !== null || this.unwatchCancelled !== null) {
      throw new Error('ChainWatcher.start() called while already running')
    }

    this.unwatchFilled = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: ORDER_SETTLEMENT_ABI,
      eventName: 'OrderFilled',
      onLogs: (logs) => {
        for (const log of logs) {
          const { maker, taker, baseToken, fillAmount, fee } = log.args as {
            maker: Address; taker: Address; baseToken: Address
            fillAmount: bigint; fee: bigint
          }
          this.emit('orderFilled', { maker, taker, baseToken, fillAmount, fee })
        }
      },
    })

    this.unwatchCancelled = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: ORDER_SETTLEMENT_ABI,
      eventName: 'OrderCancelled',
      onLogs: (logs) => {
        void (async () => {
          for (const log of logs) {
            try {
              const { user, nonce } = log.args as { user: Address; nonce: bigint }
              // Remove matching open orders from store
              const orders = await this.store.getOrdersByMaker(user)
              for (const o of orders) {
                if (o.nonce === nonce) {
                  await this.store.updateOrder(o.id, { status: 'cancelled' })
                }
              }
              this.emit('orderCancelled', { user, nonce })
            } catch (err) {
              this.emit('error', err)
            }
          }
        })()
      },
    })
  }

  stop(): void {
    this.unwatchFilled?.()
    this.unwatchCancelled?.()
    this.unwatchFilled = null
    this.unwatchCancelled = null
  }
}
