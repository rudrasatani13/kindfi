import { logger } from '@/lib/logger'
import { getDiditSessionStatus } from '~/lib/services/didit'
import { findDiditSessionBySessionId } from './session-service'
import type { CanonicalKycStatus } from './types'
import { applyDiditStatusUpdate } from './webhook-service'

export type SessionStatusRefresh =
	| { applied: true; canonicalStatus: CanonicalKycStatus }
	| { applied: false; reason: 'not_found' | 'provider_unavailable' }

/**
 * Refresh a Didit session's stored status from the provider.
 *
 * Used by the two browser-facing entry points -- the callback route and the
 * profile return URL -- which both arrive with a session id the client chose.
 * The client supplies *which session*, never *what status*: a status the
 * browser can assert would let a user approve their own verification and
 * trigger wallet activation on the strength of a URL (issue #1022). The status
 * is read from Didit here, and the Didit webhook remains authoritative.
 *
 * A session id belonging to another user is reported exactly like one that
 * does not exist, so neither route can be used to probe for session ids.
 */
export const refreshDiditSessionStatusFromProvider = async (params: {
	sessionId: string
	userId: string
}): Promise<SessionStatusRefresh> => {
	const record = await findDiditSessionBySessionId(params.sessionId)

	if (!record || record.userId !== params.userId) {
		return { applied: false, reason: 'not_found' }
	}

	let providerStatus: string

	try {
		const provider = await getDiditSessionStatus(params.sessionId)
		providerStatus = provider.status
	} catch (error) {
		// Nothing is written on a provider failure: the webhook and the
		// check-status route are the other trusted paths, and either will
		// apply the real status when Didit is reachable again.
		logger.warn('[kyc] Didit status unavailable; leaving the stored status alone', {
			sessionId: params.sessionId,
			error: error instanceof Error ? error.message : String(error),
		})
		return { applied: false, reason: 'provider_unavailable' }
	}

	const result = await applyDiditStatusUpdate({
		sessionId: params.sessionId,
		diditStatus: providerStatus,
		userId: params.userId,
		source: 'callback',
		providerEventAt: new Date(),
	})

	return {
		applied: true,
		canonicalStatus: result.canonicalStatus ?? record.canonicalStatus,
	}
}
