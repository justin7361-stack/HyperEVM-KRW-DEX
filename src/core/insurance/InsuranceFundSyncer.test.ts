import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InsuranceFundSyncer, type PairIdResolver } from './InsuranceFundSyncer.js'
import { InsuranceFund } from './InsuranceFund.js'
import type { PublicClient, Address } from 'viem'

const CONTRACT = '0x1234567890123456789012345678901234567890' as Address
const PAIR_BYTES32 = '0xabcdef1234567890000000000000000000000000000000000000000000000001' as `0x${string}`
const PAIR_STRING  = 'ETH/KRW'
const TOKEN        = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address

/**
 * Build a mock viem PublicClient whose watchContractEvent captures the onLogs callback.
 * Returns { client, triggerLog } so tests can fire synthetic log events.
 */
function makePublicClient() {
  let capturedOnLogs: ((logs: unknown[]) => void) | null = null
  let capturedOnError: ((err: unknown) => void) | null = null
  const unwatch = vi.fn()

  const client = {
    watchContractEvent: vi.fn().mockImplementation(({ onLogs, onError }: {
      onLogs:   (logs: unknown[]) => void
      onError?: (err: unknown) => void
    }) => {
      capturedOnLogs  = onLogs
      capturedOnError = onError ?? null
      return unwatch
    }),
  } as unknown as PublicClient

  function triggerLog(args: { pairId: `0x${string}`; token: Address; amount: bigint }) {
    capturedOnLogs?.([{ args }])
  }

  function triggerError(err: unknown) {
    capturedOnError?.(err)
  }

  return { client, triggerLog, triggerError, unwatch }
}

describe('InsuranceFundSyncer (G-9)', () => {
  let fund: InsuranceFund
  let resolver: PairIdResolver

  beforeEach(() => {
    fund = new InsuranceFund()
    resolver = (id) => (id === PAIR_BYTES32 ? PAIR_STRING : undefined)
  })

  it('start() calls watchContractEvent with LiquidationFeeRouted', () => {
    const { client } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)
    syncer.start()
    expect(client.watchContractEvent).toHaveBeenCalledOnce()
    expect((client.watchContractEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].eventName)
      .toBe('LiquidationFeeRouted')
    syncer.stop()
  })

  it('applies deposit to InsuranceFund when known pairId event fires', () => {
    const { client, triggerLog } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)
    syncer.start()

    triggerLog({ pairId: PAIR_BYTES32, token: TOKEN, amount: 500n })

    expect(fund.getBalance(PAIR_STRING)).toBe(500n)
    syncer.stop()
  })

  it("emits 'synced' event with correct fields", () => {
    const { client, triggerLog } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)

    const synced: Array<{ onChainPairId: string; pairId: string; amount: bigint }> = []
    syncer.on('synced', (e) => synced.push(e))
    syncer.start()

    triggerLog({ pairId: PAIR_BYTES32, token: TOKEN, amount: 250n })

    expect(synced).toHaveLength(1)
    expect(synced[0]).toEqual({ onChainPairId: PAIR_BYTES32, pairId: PAIR_STRING, amount: 250n })
    syncer.stop()
  })

  it("emits 'unknown' event and skips deposit when pairId not in resolver", () => {
    const { client, triggerLog } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)

    const unknown: unknown[] = []
    syncer.on('unknown', (e) => unknown.push(e))
    syncer.start()

    const unknownId = '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`
    triggerLog({ pairId: unknownId, token: TOKEN, amount: 100n })

    expect(unknown).toHaveLength(1)
    expect(fund.getBalance(PAIR_STRING)).toBe(0n)  // no deposit made
    syncer.stop()
  })

  it('accumulates multiple deposits from successive events', () => {
    const { client, triggerLog } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)
    syncer.start()

    triggerLog({ pairId: PAIR_BYTES32, token: TOKEN, amount: 100n })
    triggerLog({ pairId: PAIR_BYTES32, token: TOKEN, amount: 200n })
    triggerLog({ pairId: PAIR_BYTES32, token: TOKEN, amount: 50n  })

    expect(fund.getBalance(PAIR_STRING)).toBe(350n)
    syncer.stop()
  })

  it('stop() calls unwatch and sets isRunning=false', () => {
    const { client, unwatch } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)
    syncer.start()
    expect(syncer.isRunning).toBe(true)
    syncer.stop()
    expect(unwatch).toHaveBeenCalledOnce()
    expect(syncer.isRunning).toBe(false)
  })

  it('start() throws if called while already running', () => {
    const { client } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)
    syncer.start()
    expect(() => syncer.start()).toThrow('already running')
    syncer.stop()
  })

  it("emits 'error' on watchContractEvent onError callback", () => {
    const { client, triggerError } = makePublicClient()
    const syncer = new InsuranceFundSyncer(client, CONTRACT, fund, resolver)

    const errors: unknown[] = []
    syncer.on('error', (e) => errors.push(e))
    syncer.start()

    triggerError(new Error('rpc error'))

    expect(errors).toHaveLength(1)
    syncer.stop()
  })
})
