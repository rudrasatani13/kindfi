import { logger } from '@/lib/logger'
import { getDiditSessionStatus } from '~/lib/services/didit'
import type { DiditSessionRecord } from './session-service'
import { recordKycStatusTransition, saveDiditSession } from './session-service'
import { isActiveDiditSessionStatus, toCanonicalKycStatus } from './status'
import type { CanonicalKycStatus } from './types'

/**
 * Whether an existing Didit session may be handed back to the user.
 *
 * A row only leaves the active set when something writes a new status to it --
 * a webhook, a callback, or a status check. A user who abandons the Didit flow
 * by closing the tab produces none of those, so the row stays active and
 * create-session keeps returning a link that no longer works. The provider is
 * the authority on its own sessions, so ask it before reusing one (issue #1023).
 */
export type DiditSessionReuseDecision =
	/** Still open at the provider: return the stored link. */
	| { kind: 'reuse' }
	/** The provider already approved it: nothing to verify, say so. */
	| { kind: 'verified'; canonicalStatus: CanonicalKycStatus }
	/** No longer usable: persist the provider's answer and create a new session. */
	| { kind: 'replace'; canonicalStatus: CanonicalKycStatus }

export const decideDiditSessionReuse = async (
	record: DiditSessionRecord,
): Promise<DiditSessionReuseDecision> => {
	let providerStatus: string

	try {
		const provider = await getDiditSessionStatus(record.sessionId)
		providerStatus = provider.status
	} catch (error) {
		// The provider could not be asked. Keep the link the user already has
		// rather than blocking them: a create-session call against the same
		// unavailable API would fail as well, and the next attempt re-checks.
		logger.warn('[kyc] Could not confirm Didit session state before reuse', {
			sessionId: record.sessionId,
			error: error instanceof Error ? error.message : String(error),
		})
		return { kind: 'reuse' }
	}

	const canonicalStatus = toCanonicalKycStatus(providerStatus)
	if (isActiveDiditSessionStatus(canonicalStatus)) {
		return { kind: 'reuse' }
	}

	/**
	 * Persist before returning. Without this the row keeps its old status, the
	 * next lookup finds it active again, and the same dead link is offered for
	 * every subsequent request.
	 */
	await saveDiditSession({
		userId: record.userId,
		sessionId: record.sessionId,
		verificationUrl: record.verificationUrl ?? undefined,
		diditStatus: providerStatus,
		canonicalStatus,
		kycReviewId: record.kycReviewId,
	})
	await recordKycStatusTransition({
		userId: record.userId,
		sessionId: record.sessionId,
		fromDiditStatus: record.diditStatus,
		toDiditStatus: providerStatus,
		fromCanonicalStatus: record.canonicalStatus,
		toCanonicalStatus: canonicalStatus,
		source: 'create_session',
	})

	return canonicalStatus === 'approved'
		? { kind: 'verified', canonicalStatus }
		: { kind: 'replace', canonicalStatus }
}
