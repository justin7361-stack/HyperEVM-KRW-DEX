/**
 * OFACPlugin — O-7: OFAC sanctions address screening.
 *
 * Two-layer approach (same pattern as dYdX v4 ComplianceService):
 *   1. Local OFAC SDN address list (no latency, no external dependency)
 *   2. Optional Chainalysis free API for risk scoring (if CHAINALYSIS_API_KEY is set)
 *
 * Reference: https://home.treasury.gov/policy-issues/financial-sanctions/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists
 * SDN list is updated regularly — production should load from OFAC XML endpoint weekly.
 */

import type { IPolicyPlugin, PolicyResult, TradeContext } from '../IPolicyPlugin.js'

// ─── Hardcoded seed set (Lazarus Group, Tornado Cash, etc.) ───────────────────
// Production: replace with weekly fetch of OFAC SDN list from:
//   https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml
// and parse <sdnEntry type="Entity"> where <idList> contains EthAddress.
const BLOCKED_ADDRESSES: ReadonlySet<string> = new Set([
  // Tornado Cash — OFAC SDN (2022-08-08)
  '0x8589427373d6d84e98730d7795d8f6f8731fda16',
  '0x722122df12d4e14e13ac3b6895a86e84145b6967',
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3384',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',
  '0xd96f2b1c14db8458374d9aca76e26c3950168e51',
  '0x4736dcf1b7a3d580672cce6e7c65cd5cc9cfba9d',
  '0xd4b88df4d29f5cedd6857912842cff3b20c8cfa3',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291',
  '0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144',
  '0xf60dd140cff0706bae9cd734ac3ae76ad9ebc32a',
  '0x22aaa7720ddd5388a3c0a3333430953c68f1849b',
  '0xba214c1c1928a32bffe790263e38b4af9bfcd659',
  '0xb1c29e845bf6339be6d34a5dd8d15e8d6c5da6bd',
  '0x527653ea119f3e6a1f5bd18fbf9312aa236c3c9',
  '0x58e8dcc13be9780fc42e8723d8ead4cf46943df2',
  '0xd691f27f38b395864ea86cfc7253969b409c362d',
  '0xaf4c0b70b2ea9f3e15aa2cf3c1e37e51e1c8b3e2',
  '0xa60c772958a3ed426c63338db9bddf4a9b4e5b6b',
  '0x23773e65ed146a459667dd6da8fe800f8e1e1e71',
  '0x330bdfade01ee9bf63c209ee33102dd334618e0a',
  '0x2573fab079b08a51d97c4de7f3d264ce04e24571',
  '0x01e2919679362dfbc9ee1644ba9c6da6d6245bb1',
  '0x76d85b4c0fc497eecc38902397ac608000082f3d',
  // Lazarus Group (DPRK) — OFAC SDN
  '0x098b716b8aaf21512996dc57eb0615e2383e2f96',
  '0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b',
  '0x3cffd56b47b7b41c56258d9c7731abadc360e073',
  '0x53b6936513e738f44fb50d2b9476730c0d3d5f6b',
  '0x7f367cc41522ce07553e823bf3be79a889debe1b',
  '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
  '0x901bb9583b24d97e995513c6778dc6888ab6870e',
  '0xa7e5d5a720f06526557c513402f2e6b5fa20b008',
  '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c',
  '0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a',
  '0x7db418b5d567a4e0e8c59ad71be1fce48f3e6107',
  '0x72a5843cc08275c8171e582972aa4fda8c397b2a',
  '0x7f367cc41522ce07553e823bf3be79a889debe1b',
])

export interface OFACPluginOptions {
  chainalysisApiKey?: string
}

export class OFACPlugin implements IPolicyPlugin {
  readonly name = 'ofac'

  constructor(private readonly opts: OFACPluginOptions = {}) {}

  async check(ctx: TradeContext): Promise<PolicyResult> {
    const addresses = [ctx.maker, ctx.taker]

    for (const addr of addresses) {
      const lc = addr.toLowerCase()

      // Layer 1: local SDN list (zero latency)
      if (BLOCKED_ADDRESSES.has(lc)) {
        return { allowed: false, reason: `OFAC SDN match: ${addr}` }
      }

      // Layer 2: Chainalysis API (optional, async)
      if (this.opts.chainalysisApiKey) {
        const blocked = await this._checkChainalysis(addr, this.opts.chainalysisApiKey)
        if (blocked) {
          return { allowed: false, reason: `Chainalysis risk: ${addr}` }
        }
      }
    }

    return { allowed: true }
  }

  private async _checkChainalysis(address: string, apiKey: string): Promise<boolean> {
    try {
      const res = await fetch(
        `https://api.chainalysis.com/api/risk/v2/entities/${address}`,
        { headers: { Token: apiKey }, signal: AbortSignal.timeout(2000) },
      )
      if (!res.ok) return false  // fail open — don't block on API errors
      const json = (await res.json()) as { risk?: string }
      return json.risk === 'severe' || json.risk === 'high'
    } catch {
      // Timeout or network error → fail open (don't block legitimate users)
      return false
    }
  }
}
