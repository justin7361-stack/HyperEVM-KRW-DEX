import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import type { Config } from '../config/config.js'
import type { VaultClient } from './vaultClient.js'

export async function createOperatorWallet(
  config: Config,
  vault?: VaultClient | null,
) {
  let privateKey: Hex
  if (vault && config.vaultAddr) {
    const key = await vault.readSecret('krw-dex/operator-key')
    privateKey = key as Hex
  } else {
    privateKey = config.operatorPrivateKey
  }

  const account = privateKeyToAccount(privateKey)
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  })
  return { walletClient, account }
}

export type OperatorWallet = Awaited<ReturnType<typeof createOperatorWallet>>
