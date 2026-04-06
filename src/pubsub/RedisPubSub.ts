/**
 * RedisPubSub — O-2: Redis-backed pub/sub for WebSocket broadcasting.
 *
 * Replaces in-process EventEmitter broadcasting so that multiple server
 * instances (horizontal scaling) all receive and forward market data events.
 *
 * Pattern: dYdX v4 "Socks" service uses Redis pub/sub for WS fan-out.
 * Reference: https://github.com/dydxprotocol/v4-chain/tree/main/indexer/services/socks
 *
 * Install: npm install ioredis
 *
 * Falls back to a local EventEmitter if REDIS_URL is not set or ioredis
 * is not installed — server runs as single-instance without Redis.
 */

import { EventEmitter } from 'events'

export type PubSubChannel =
  | 'orderbook'   // { pairId, bids, asks }
  | 'trade'       // { pairId, price, amount, isBuyerMaker, tradedAt }
  | 'candle'      // { pairId, resolution, candle }
  | 'mark_price'  // { pairId, markPrice }
  | 'funding'     // { pairId, rate, nextFunding }

export interface IPubSub {
  publish(channel: PubSubChannel, pairId: string, data: unknown): Promise<void>
  subscribe(channel: PubSubChannel, pairId: string, handler: (data: unknown) => void): () => void
  close(): Promise<void>
}

/** Local EventEmitter fallback — single process, no Redis required */
class LocalPubSub implements IPubSub {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)  // many WS clients subscribe
  }

  async publish(channel: PubSubChannel, pairId: string, data: unknown): Promise<void> {
    this.emitter.emit(`${channel}:${pairId}`, data)
  }

  subscribe(channel: PubSubChannel, pairId: string, handler: (data: unknown) => void): () => void {
    const event = `${channel}:${pairId}`
    this.emitter.on(event, handler)
    return () => this.emitter.off(event, handler)
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners()
  }
}

/** Redis-backed pub/sub for multi-instance deployment */
class RedisPubSubImpl implements IPubSub {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pub: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sub: any
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(Redis: any, redisUrl: string) {
    this.pub = new Redis(redisUrl)
    this.sub = new Redis(redisUrl)

    this.sub.on('message', (rawChannel: string, rawMsg: string) => {
      const handlers = this.handlers.get(rawChannel)
      if (!handlers) return
      try {
        const data = JSON.parse(rawMsg) as unknown
        for (const h of handlers) h(data)
      } catch {
        // ignore malformed messages
      }
    })
  }

  async publish(channel: PubSubChannel, pairId: string, data: unknown): Promise<void> {
    const key = `${channel}:${pairId}`
    await this.pub.publish(key, JSON.stringify(data))
  }

  subscribe(channel: PubSubChannel, pairId: string, handler: (data: unknown) => void): () => void {
    const key = `${channel}:${pairId}`
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set())
      void this.sub.subscribe(key)
    }
    this.handlers.get(key)!.add(handler)

    return () => {
      this.handlers.get(key)?.delete(handler)
      if (this.handlers.get(key)?.size === 0) {
        this.handlers.delete(key)
        void this.sub.unsubscribe(key)
      }
    }
  }

  async close(): Promise<void> {
    await this.pub.quit()
    await this.sub.quit()
  }
}

/**
 * Create a pub/sub instance.
 * Uses Redis if REDIS_URL is set and ioredis is installed; otherwise falls back
 * to a local EventEmitter (single-process mode).
 */
export async function createPubSub(redisUrl: string | undefined): Promise<IPubSub> {
  if (!redisUrl) {
    console.log('[PubSub] REDIS_URL not set — using local EventEmitter (single-process mode)')
    return new LocalPubSub()
  }

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional peer dependency; not installed until `npm install ioredis`
    const { default: Redis } = await import('ioredis') as { default: unknown }
    const pubsub = new RedisPubSubImpl(Redis, redisUrl)
    console.log('[PubSub] Redis connected:', redisUrl.replace(/:[^:@]*@/, ':***@'))
    return pubsub
  } catch (err) {
    console.warn('[PubSub] ioredis not installed — falling back to local EventEmitter. Run: npm install ioredis')
    console.warn('[PubSub] Error:', (err as Error).message)
    return new LocalPubSub()
  }
}
