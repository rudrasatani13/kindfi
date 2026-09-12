import { beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Issue #1022: the browser may say which session it came back from, never what
 * the status is. These tests cover the shared refresh path that both the
 * callback route and the profile return URL call.
 */

let sessionRecord: Record<string, unknown> | null = null
let providerStatus: string | null = null
let providerError: Error | null = null
const appliedUpdates: Array<Record<string, unknown>> = []

mock.module('~/lib/logger', () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

mock.module('~/lib/kyc/session-service', () => ({
	findDiditSessionBySessionId: async () => sessionRecord,
}))

mock.module('~/lib/services/didit', () => ({
	getDiditSessionStatus: async () => {
		if (providerError) throw providerError
		return {
			session_id: 'session-1',
			status: providerStatus,
			created_at: '2026-09-01T00:00:00Z',
		}
	},
}))

mock.module('~/lib/kyc/webhook-service', () => ({
	applyDiditStatusUpdate: async (input: Record<string, unknown>) => {
		appliedUpdates.push(input)
		return { applied: true, canonicalStatus: 'approved', userId: input.userId }
	},
}))

const { refreshDiditSessionStatusFromProvider } = await import('~/lib/kyc/refresh-session-status')

const ownedSession = {
	id: 'row-1',
	userId: 'user-1',
	kycReviewId: 'review-1',
	sessionId: 'session-1',
	verificationUrl: null,
	diditStatus: 'In Progress',
	canonicalStatus: 'pending' as const,
	lastProviderEventId: null,
	lastProviderEventAt: null,
}

describe('refreshDiditSessionStatusFromProvider', () => {
	beforeEach(() => {
		sessionRecord = ownedSession
		providerStatus = 'Approved'
		providerError = null
		appliedUpdates.length = 0
	})

	it('applies the status Didit reports, not one the caller supplies', async () => {
		providerStatus = 'Approved'

		const result = await refreshDiditSessionStatusFromProvider({
			sessionId: 'session-1',
			userId: 'user-1',
		})

		expect(result).toEqual({ applied: true, canonicalStatus: 'approved' })
		expect(appliedUpdates).toHaveLength(1)
		expect(appliedUpdates[0]).toMatchObject({
			sessionId: 'session-1',
			diditStatus: 'Approved',
			userId: 'user-1',
			source: 'callback',
		})
	})

	it('writes nothing for a session that belongs to another user', async () => {
		sessionRecord = { ...ownedSession, userId: 'someone-else' }

		const result = await refreshDiditSessionStatusFromProvider({
			sessionId: 'session-1',
			userId: 'user-1',
		})

		expect(result).toEqual({ applied: false, reason: 'not_found' })
		expect(appliedUpdates).toHaveLength(0)
	})

	it('writes nothing for an unknown session', async () => {
		sessionRecord = null

		const result = await refreshDiditSessionStatusFromProvider({
			sessionId: 'does-not-exist',
			userId: 'user-1',
		})

		expect(result).toEqual({ applied: false, reason: 'not_found' })
		expect(appliedUpdates).toHaveLength(0)
	})

	it('writes nothing when the provider cannot be reached', async () => {
		providerError = new Error('didit unavailable')

		const result = await refreshDiditSessionStatusFromProvider({
			sessionId: 'session-1',
			userId: 'user-1',
		})

		expect(result).toEqual({ applied: false, reason: 'provider_unavailable' })
		expect(appliedUpdates).toHaveLength(0)
	})

	it('never reads a status from the request it was given', async () => {
		providerStatus = 'Declined'

		const result = await refreshDiditSessionStatusFromProvider({
			sessionId: 'session-1',
			userId: 'user-1',
		})

		expect(appliedUpdates[0]).toMatchObject({ diditStatus: 'Declined' })
		expect(result.applied).toBe(true)
	})
})
