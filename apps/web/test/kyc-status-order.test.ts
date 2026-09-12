import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Issue #1024: the KYC authorization check must run after transition
 * validation, so an invalid transition is never answered with a KYC denial.
 *
 * Asserted against the route source rather than by calling the route, because
 * `bun`'s `mock.module` is process-global: standing up this route's dependency
 * graph changes the outcome of unrelated test files (measured on this branch:
 * five failures in contributions/create resolved and four in quests/governance
 * appeared). A test that moves the failure set around is worse than one that
 * checks the ordering directly, and the ordering is the whole fix -- this fails
 * if it is undone.
 */
const ROUTE = new URL('../app/api/projects/[slug]/manage/status/route.ts', import.meta.url)
const source = readFileSync(ROUTE, 'utf8')

describe('project status route — validation before KYC authorization', () => {
	it('checks the transition before asking for KYC authorization', () => {
		const transitionCheck = source.indexOf('isAllowedStatusTransition({')
		const kycCheck = source.indexOf('requireKycAuthorization({')

		expect(transitionCheck).toBeGreaterThan(-1)
		expect(kycCheck).toBeGreaterThan(-1)
		expect(kycCheck).toBeGreaterThan(transitionCheck)
	})

	it('checks the transition before fetching the project row it validates against', () => {
		// The KYC call must also come after the project is read: the transition is
		// validated against the stored status, so a denial before that read would
		// again be answering a question nobody asked.
		const projectFetch = source.indexOf("from('projects')")
		const kycCheck = source.indexOf('requireKycAuthorization({')

		expect(projectFetch).toBeGreaterThan(-1)
		expect(kycCheck).toBeGreaterThan(projectFetch)
	})

	it('keeps the manager-only conditions on the KYC check', () => {
		const kycCheck = source.indexOf('requireKycAuthorization({')
		const guard = source.lastIndexOf(
			"if (!auth.access.isPlatformAdmin && nextStatus === 'review') {",
			kycCheck,
		)

		expect(guard).toBeGreaterThan(-1)
	})

	it('asks for the same KYC action as before', () => {
		expect(source).toContain("action: 'submit_campaign'")
	})
})
