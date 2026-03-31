import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  TraderKeyStore,
  createTraderAuth,
  apiKeyManagementRoutes,
} from './traderAuth.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(keyStore: TraderKeyStore) {
  const fastify = Fastify()

  // Wire the preHandler for /orders mutations (mirrors server.ts logic)
  const auth = createTraderAuth(keyStore, true)
  fastify.addHook('preHandler', async (req, reply) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.url.startsWith('/orders')) {
      await auth(req, reply)
    }
  })

  // Stub route so we get a real response on success
  fastify.post('/orders', async (_req, reply) => reply.status(201).send({ ok: true }))
  fastify.get('/orders',  async (_req, reply) => reply.status(200).send({ orders: [] }))

  return fastify
}

// ── TraderKeyStore unit tests ─────────────────────────────────────────────────

describe('TraderKeyStore', () => {
  it('register() normalizes maker to lowercase', () => {
    const store = new TraderKeyStore()
    store.register({ key: 'k1', role: 'trade', maker: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' })
    const record = store.get('k1')
    expect(record?.maker).toBe('0xabcdef1234567890abcdef1234567890abcdef12')
  })

  it('revoke() removes the key', () => {
    const store = new TraderKeyStore()
    store.register({ key: 'k2', role: 'read', maker: '0xabc' })
    store.revoke('k2')
    expect(store.get('k2')).toBeUndefined()
  })
})

// ── createTraderAuth preHandler tests ─────────────────────────────────────────

describe('createTraderAuth preHandler', () => {
  let store: TraderKeyStore

  beforeEach(() => {
    store = new TraderKeyStore()
    store.register({ key: 'read-key',  role: 'read',  maker: '0xaaa' })
    store.register({ key: 'trade-key', role: 'trade', maker: '0xbbb' })
  })

  it('returns 401 when X-Api-Key header is missing on POST /orders', async () => {
    const app = buildApp(store)
    const res = await app.inject({ method: 'POST', url: '/orders', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Missing X-Api-Key header' })
  })

  it('returns 401 for an unknown API key on POST /orders', async () => {
    const app = buildApp(store)
    const res = await app.inject({
      method: 'POST', url: '/orders', payload: {},
      headers: { 'x-api-key': 'unknown-key' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid API key' })
  })

  it('returns 403 for a read-only key on POST /orders', async () => {
    const app = buildApp(store)
    const res = await app.inject({
      method: 'POST', url: '/orders', payload: {},
      headers: { 'x-api-key': 'read-key' },
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Read-only API key cannot submit orders' })
  })

  it('passes auth for a trade key on POST /orders', async () => {
    const app = buildApp(store)
    const res = await app.inject({
      method: 'POST', url: '/orders', payload: {},
      headers: { 'x-api-key': 'trade-key' },
    })
    // Auth passed; route stub returns 201
    expect(res.statusCode).toBe(201)
  })

  it('passes auth for a read-only key on GET /orders (no auth required)', async () => {
    const app = buildApp(store)
    const res = await app.inject({
      method: 'GET', url: '/orders',
      headers: { 'x-api-key': 'read-key' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('passes auth for GET /orders even with no key (read endpoints are open)', async () => {
    const app = buildApp(store)
    const res = await app.inject({ method: 'GET', url: '/orders' })
    expect(res.statusCode).toBe(200)
  })
})

// ── Admin route tests ─────────────────────────────────────────────────────────

describe('apiKeyManagementRoutes', () => {
  const ADMIN_KEY = 'super-secret-admin'

  function buildAdminApp() {
    const keyStore = new TraderKeyStore()
    const fastify = Fastify()
    fastify.register(apiKeyManagementRoutes(keyStore, ADMIN_KEY))
    return { fastify, keyStore }
  }

  it('POST /admin/api-keys with correct Bearer token returns 201', async () => {
    const { fastify } = buildAdminApp()
    const res = await fastify.inject({
      method:  'POST',
      url:     '/admin/api-keys',
      payload: { key: 'new-key', role: 'trade', maker: '0xCCC' },
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toMatchObject({ registered: true })
  })

  it('POST /admin/api-keys with wrong Bearer token returns 401', async () => {
    const { fastify } = buildAdminApp()
    const res = await fastify.inject({
      method:  'POST',
      url:     '/admin/api-keys',
      payload: { key: 'new-key', role: 'trade', maker: '0xDDD' },
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthorized' })
  })

  it('DELETE /admin/api-keys/:key with correct Bearer token returns 200 and removes the key', async () => {
    const { fastify, keyStore } = buildAdminApp()
    // Pre-register a key so there is something to revoke
    keyStore.register({ key: 'key-to-revoke', role: 'trade', maker: '0xEEE' })
    const res = await fastify.inject({
      method:  'DELETE',
      url:     '/admin/api-keys/key-to-revoke',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ revoked: true })
    expect(keyStore.get('key-to-revoke')).toBeUndefined()
  })

  it('DELETE /admin/api-keys/:key with wrong Bearer token returns 401', async () => {
    const { fastify } = buildAdminApp()
    const res = await fastify.inject({
      method:  'DELETE',
      url:     '/admin/api-keys/any-key',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Unauthorized' })
  })
})
