import type { Hex } from 'viem'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { Order } from '../types/order.js'

// Future: snarkjs + circom based proof verification
// Swap this for EIP712Verifier in config when ZKP is ready.
export class ZKVerifier implements IOrderVerifier {
  async verify(_order: Order, _proof: Hex): Promise<boolean> {
    throw new Error('ZKVerifier not yet implemented')
  }
}
