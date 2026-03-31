import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Config } from '../config/config.js'

export function createOperatorWallet(config: Config) {
  const account = privateKeyToAccount(config.operatorPrivateKey)
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  })
  return { walletClient, account }
}

export type OperatorWallet = ReturnType<typeof createOperatorWallet>
