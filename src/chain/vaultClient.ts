// src/chain/vaultClient.ts

export interface VaultConfig {
  addr:     string   // VAULT_ADDR e.g. https://vault.hyperkrw.xyz
  roleId:   string   // VAULT_ROLE_ID (not secret — safe in env)
  secretId: string   // VAULT_SECRET_ID (treat as password)
}

export class VaultClient {
  private token: string | null = null

  constructor(private cfg: VaultConfig) {}

  /** AppRole login → returns vault token. Caches in this.token */
  private async login(): Promise<string> {
    const res = await fetch(`${this.cfg.addr}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_id: this.cfg.roleId, secret_id: this.cfg.secretId }),
    })
    if (!res.ok) {
      throw new Error(`Vault AppRole login failed: HTTP ${res.status}`)
    }
    const json = (await res.json()) as { auth: { client_token: string } }
    this.token = json.auth.client_token
    return this.token
  }

  /** Read KV v2 secret. Returns data.data.value field. */
  async readSecret(path: string): Promise<string> {
    if (!this.token) {
      await this.login()
    }

    const result = await this._fetchSecret(path)
    if (result.status === 403) {
      // Token may have expired — re-login once and retry
      await this.login()
      const retry = await this._fetchSecret(path)
      if (!retry.ok) {
        throw new Error(`Vault secret read failed: HTTP ${retry.status} for path ${path}`)
      }
      return retry.value
    }

    if (!result.ok) {
      throw new Error(`Vault secret read failed: HTTP ${result.status} for path ${path}`)
    }

    return result.value
  }

  private async _fetchSecret(
    path: string,
  ): Promise<{ ok: boolean; status: number; value: string }> {
    const res = await fetch(`${this.cfg.addr}/v1/secret/data/${path}`, {
      method: 'GET',
      headers: {
        'X-Vault-Token': this.token ?? '',
      },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, value: '' }
    }
    const json = (await res.json()) as { data: { data: { value: string } } }
    return { ok: true, status: res.status, value: json.data.data.value }
  }

  /** Renew the current token. Call periodically to keep alive. */
  async renewToken(): Promise<void> {
    const res = await fetch(`${this.cfg.addr}/v1/auth/token/renew-self`, {
      method: 'PUT',
      headers: {
        'X-Vault-Token': this.token ?? '',
      },
    })
    if (!res.ok) {
      throw new Error(`Vault token renewal failed: HTTP ${res.status}`)
    }
  }
}

/**
 * Returns VaultClient if VAULT_ADDR + VAULT_ROLE_ID + VAULT_SECRET_ID are set,
 * otherwise returns null (server falls back to OPERATOR_PRIVATE_KEY env var).
 */
export function createVaultClient(config: {
  vaultAddr?:     string
  vaultRoleId?:   string
  vaultSecretId?: string
}): VaultClient | null {
  if (!config.vaultAddr || !config.vaultRoleId || !config.vaultSecretId) return null
  return new VaultClient({
    addr:     config.vaultAddr,
    roleId:   config.vaultRoleId,
    secretId: config.vaultSecretId,
  })
}
