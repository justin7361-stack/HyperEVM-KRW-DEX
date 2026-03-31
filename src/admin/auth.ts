import type { FastifyRequest, FastifyReply } from 'fastify'

export function createAdminAuth(adminApiKey: string) {
  return async function adminAuth(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers['authorization']
    if (!auth || auth !== `Bearer ${adminApiKey}`) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}
