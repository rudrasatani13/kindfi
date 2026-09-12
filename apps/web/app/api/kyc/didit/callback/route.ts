import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { logger } from '@/lib/logger'
import { nextAuthOption } from '~/lib/auth/auth-options'
import { refreshDiditSessionStatusFromProvider } from '~/lib/kyc/refresh-session-status'
import { withRateLimit } from '~/lib/middleware/rate-limit'

interface DiditCallbackBody {
	/** Which session the browser came back from. Never a status: see below. */
	verificationSessionId: string
}

const isValidCallbackBody = (data: unknown): data is DiditCallbackBody =>
	typeof data === 'object' &&
	data !== null &&
	typeof (data as DiditCallbackBody).verificationSessionId === 'string' &&
	(data as DiditCallbackBody).verificationSessionId.length > 0

/**
 * POST /api/kyc/didit/callback
 *
 * Handles the browser returning from Didit.
 *
 * The body carries the session id and nothing else. The status is read from
 * Didit here, because a status the browser can assert is one a user can approve
 * themselves with (issue #1022); the Didit webhook stays authoritative, and the
 * session must belong to the authenticated user.
 */
async function diditCallbackHandler(req: NextRequest): Promise<NextResponse> {
	let body: unknown
	try {
		body = await req.json()
	} catch {
		return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
	}

	if (!isValidCallbackBody(body)) {
		return NextResponse.json(
			{ error: 'Missing or invalid verificationSessionId or status' },
			{ status: 400 },
		)
	}

	try {
		const session = await getServerSession(nextAuthOption)

		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}

		const { verificationSessionId } = body
		const refresh = await refreshDiditSessionStatusFromProvider({
			sessionId: verificationSessionId,
			userId: session.user.id,
		})

		if (!refresh.applied && refresh.reason === 'not_found') {
			// Unknown session, or a session that belongs to somebody else: the two
			// are deliberately indistinguishable, so this cannot probe for session ids.
			return NextResponse.json({ error: 'Unknown verification session' }, { status: 403 })
		}

		if (!refresh.applied) {
			return NextResponse.json(
				{
					success: false,
					applied: false,
					reason: 'provider_unavailable',
					message: 'Didit status is temporarily unavailable; the webhook will confirm it.',
				},
				{ status: 202 },
			)
		}

		return NextResponse.json({
			success: true,
			applied: true,
			status: refresh.canonicalStatus,
			canonicalStatus: refresh.canonicalStatus,
		})
	} catch (error) {
		logger.error('Error processing Didit callback:', error)
		return NextResponse.json({ error: 'Failed to process callback' }, { status: 500 })
	}
}

export const POST = withRateLimit(
	{
		preset: 'moderate',
		identifier: async (req) => {
			const session = await getServerSession(nextAuthOption)
			return session?.user?.id ?? req.ip ?? 'anonymous'
		},
	},
	diditCallbackHandler,
)
