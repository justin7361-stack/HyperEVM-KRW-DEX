import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VaultClient, createVaultClient } from '../../src/chain/vaultClient.js'

describe('createVaultClient', () => {
  it('returns null when env vars missing', () => {
    expect(createVaultClient({})).toBeNull()
    expect(createVaultClient({ vaultAddr: 'http://vault' })).toBeNull()
    expect(createVaultClient({ vaultAddr: 'http://vault', vaultRoleId: 'rid' })).toBeNull()
  })

  it('returns VaultClient when all vars set', () => {
    const c = createVaultClient({
      vaultAddr: 'http://vault',
      vaultRoleId: 'rid',
      vaultSecretId: 'sid',
    })
    expect(c).toBeInstanceOf(VaultClient)
  })
})

describe('VaultClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('login() posts to /v1/auth/approle/login', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: 'tok123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { value: '0xsecret' } } }),
      })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await client.readSecret('krw-dex/operator-key')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [loginUrl, loginOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(loginUrl).toBe('http://vault/v1/auth/approle/login')
    expect(loginOpts.method).toBe('POST')
    expect(JSON.parse(loginOpts.body as string)).toEqual({
      role_id: 'rid',
      secret_id: 'sid',
    })
  })

  it('readSecret() returns data.data.value', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: 'tok' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { value: '0xdeadbeef' } } }),
      })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    expect(await client.readSecret('krw-dex/operator-key')).toBe('0xdeadbeef')
  })

  it('readSecret() calls correct KV v2 path', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: 'tok' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { value: '0xabc' } } }),
      })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await client.readSecret('krw-dex/operator-key')

    const [secretUrl, secretOpts] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(secretUrl).toBe('http://vault/v1/secret/data/krw-dex/operator-key')
    expect(secretOpts.method).toBe('GET')
    expect((secretOpts.headers as Record<string, string>)['X-Vault-Token']).toBe('tok')
  })

  it('readSecret() throws on non-ok response after re-login', async () => {
    fetchMock
      // initial login
      .mockResolvedValueOnce({ ok: true, json: async () => ({ auth: { client_token: 'tok' } }) })
      // first secret fetch → 403
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      // re-login after 403
      .mockResolvedValueOnce({ ok: true, json: async () => ({ auth: { client_token: 'tok2' } }) })
      // retry secret fetch → still 403
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await expect(client.readSecret('bad/path')).rejects.toThrow('Vault secret read failed')
  })

  it('readSecret() re-logins on 403 and succeeds on retry', async () => {
    fetchMock
      // initial login
      .mockResolvedValueOnce({ ok: true, json: async () => ({ auth: { client_token: 'tok' } }) })
      // first secret fetch → 403
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      // re-login
      .mockResolvedValueOnce({ ok: true, json: async () => ({ auth: { client_token: 'tok2' } }) })
      // retry succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { value: '0xrecovered' } } }),
      })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    const result = await client.readSecret('krw-dex/operator-key')
    expect(result).toBe('0xrecovered')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('login() throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await expect(client.readSecret('some/path')).rejects.toThrow('Vault AppRole login failed')
  })

  it('renewToken() calls /v1/auth/token/renew-self', async () => {
    // first login for readSecret to prime the token
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ auth: { client_token: 'tok' } }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { value: 'v' } } }),
      })
      // renewToken call
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await client.readSecret('some/path')
    await client.renewToken()

    const [renewUrl, renewOpts] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(renewUrl).toBe('http://vault/v1/auth/token/renew-self')
    expect(renewOpts.method).toBe('PUT')
    expect((renewOpts.headers as Record<string, string>)['X-Vault-Token']).toBe('tok')
  })

  it('renewToken() throws on failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })

    const client = new VaultClient({ addr: 'http://vault', roleId: 'rid', secretId: 'sid' })
    await expect(client.renewToken()).rejects.toThrow('Vault token renewal failed')
  })
})
