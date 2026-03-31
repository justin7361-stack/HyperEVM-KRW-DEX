import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export type ApiKeyRole = 'read' | 'trade'

export interface ApiKeyRecord {
  key:    string
  role:   ApiKeyRole
  maker:  string    // Ethereum address (lowercase)
  label?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyRecord?: ApiKeyRecord
  }
}

// In-memory key store. In production, replace with DB or encrypted config.
export class TraderKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>()

  register(record: ApiKeyRecord): void {
    this.keys.set(record.key, { ...record, maker: record.maker.toLowerCase() })
  }

  get(key: string): ApiKeyRecord | undefined {
    return this.keys.get(key)
  }

  revoke(key: string): void {
    this.keys.delete(key)
  }
}

// Fastify preHandler hook factory.
// requireTrade: if true, read-only keys are rejected.
export function createTraderAuth(keyStore: TraderKeyStore, requireTrade = false) {
  return async function traderAuth(req: FastifyRequest, reply: FastifyReply) {
    const key = req.headers['x-api-key']
    if (!key || typeof key !== 'string') {
      return reply.status(401).send({ error: 'Missing X-Api-Key header' })
    }

    const record = keyStore.get(key)
    if (!record) {
      return reply.status(401).send({ error: 'Invalid API key' })
    }

    if (requireTrade && record.role === 'read') {
      return reply.status(403).send({ error: 'Read-only API key cannot submit orders' })
    }

    // Attach to request for use in route handlers
    req.apiKeyRecord = record
  }
}

// Admin routes for key management
export function apiKeyManagementRoutes(keyStore: TraderKeyStore, adminApiKey: string) {
  return async function (fastify: FastifyInstance) {
    fastify.addHook('preHandler', async (req, reply) => {
      if (req.headers['authorization'] !== `Bearer ${adminApiKey}`) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    })

    fastify.post<{ Body: ApiKeyRecord }>('/admin/api-keys', async (req, reply) => {
      keyStore.register(req.body)
      return reply.status(201).send({ registered: true })
    })

    fastify.delete<{ Params: { key: string } }>('/admin/api-keys/:key', async (req, reply) => {
      keyStore.revoke(req.params.key)
      return reply.send({ revoked: true })
    })
  }
}
