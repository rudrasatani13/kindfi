import { beforeEach, describe, expect, it, mock } from 'bun:test'

/**
 * Issue #1023: an existing session may only be handed back while the provider
 * still considers it open. These tests cover the decision itself; the route
 * wiring that consumes it is exercised in rate-limited-routes.test.ts.
 */

let providerStatus: string | null = null
let providerError: Error | null = null
const saveCalls: Array<Record<string, unknown>> = []
const transitionCalls: Array<Record<string, unknown>> = []

mock.module('~/lib/logger', () => ({
	logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

mock.module('~/lib/services/didit', () => ({
	getDiditSessionStatus: async () => {
		if (providerError) throw providerError
		return {
			session_id: 'didit-session-1',
			status: providerStatus,
			created_at: '2026-09-01T00:00:00Z',
		}
	},
}))

mock.module('~/lib/kyc/session-service', () => ({
	saveDiditSession: async (params: Record<string, unknown>) => {
		saveCalls.push(params)
		return null
	},
	recordKycStatusTransition: async (params: Record<string, unknown>) => {
		transitionCalls.push(params)
	},
}))

const { decideDiditSessionReuse } = await import('~/lib/kyc/session-reuse')

const RECORD = {
	id: 'row-1',
	userId: 'user-1',
	kycReviewId: 'review-1',
	sessionId: 'didit-session-1',
	verificationUrl: 'https://verify.didit.me/session/abc',
	diditStatus: 'In Progress',
	canonicalStatus: 'pending' as const,
	lastProviderEventId: null,
	lastProviderEventAt: null,
}

describe('decideDiditSessionReuse', () => {
	beforeEach(() => {
		providerStatus = null
		providerError = null
		saveCalls.length = 0
		transitionCalls.length = 0
	})

	it('reuses a session the provider still reports as open', async () => {
		providerStatus = 'In Progress'

		expect(await decideDiditSessionReuse(RECORD)).toEqual({ kind: 'reuse' })
		expect(saveCalls).toHaveLength(0)
		expect(transitionCalls).toHaveLength(0)
	})

	it('reuses a session that has not been started yet', async () => {
		providerStatus = 'Not Started'

		expect(await decideDiditSessionReuse(RECORD)).toEqual({ kind: 'reuse' })
		expect(saveCalls).toHaveLength(0)
	})

	it('replaces an abandoned session and records it as expired', async () => {
		providerStatus = 'Abandoned'

		expect(await decideDiditSessionReuse(RECORD)).toEqual({
			kind: 'replace',
			canonicalStatus: 'expired',
		})
		expect(saveCalls).toHaveLength(1)
		expect(saveCalls[0]).toMatchObject({
			sessionId: 'didit-session-1',
			diditStatus: 'Abandoned',
			canonicalStatus: 'expired',
		})
		expect(transitionCalls[0]).toMatchObject({
			fromCanonicalStatus: 'pending',
			toCanonicalStatus: 'expired',
			toDiditStatus: 'Abandoned',
			source: 'create_session',
		})
	})

	it('replaces a declined session', async () => {
		providerStatus = 'Declined'

		expect(await decideDiditSessionReuse(RECORD)).toEqual({
			kind: 'replace',
			canonicalStatus: 'rejected',
		})
		expect(saveCalls[0]).toMatchObject({ canonicalStatus: 'rejected' })
	})

	it('reports an approval the local row had not caught up with', async () => {
		providerStatus = 'Approved'

		expect(await decideDiditSessionReuse(RECORD)).toEqual({
			kind: 'verified',
			canonicalStatus: 'approved',
		})
		expect(saveCalls[0]).toMatchObject({ canonicalStatus: 'approved' })
		expect(transitionCalls[0]).toMatchObject({ toCanonicalStatus: 'approved' })
	})

	it('keeps the existing link when the provider cannot be reached', async () => {
		providerError = new Error('didit unavailable')

		expect(await decideDiditSessionReuse(RECORD)).toEqual({ kind: 'reuse' })
		expect(saveCalls).toHaveLength(0)
	})
})
