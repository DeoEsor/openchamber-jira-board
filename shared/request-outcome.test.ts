import { describe, expect, test } from 'bun:test';
import { hasUnknownOutcome, mutationTransportHasUnknownOutcome } from './request-outcome.ts';

describe('mutation request outcomes', () => {
  test('treats timeouts, transport failures, and oversized responses as uncertain', () => {
    for (const code of ['HOST_TIMEOUT', 'REQUEST_FAILED', 'RESPONSE_TOO_LARGE']) {
      const error = { name: 'HostRequestError', code };
      expect(hasUnknownOutcome(error)).toBe(true);
      expect(mutationTransportHasUnknownOutcome(error)).toBe(true);
    }
  });

  test('preserves definite SDK refusals so optimistic transitions roll back immediately', () => {
    for (const code of ['NO_SERVICE', 'SERVICE_FAILED', 'DISABLED', 'HOST_REJECTED', 'BAD_PATH', 'NOT_GRANTED']) {
      const error = { name: 'HostRequestError', code };
      expect(hasUnknownOutcome(error)).toBe(false);
      expect(mutationTransportHasUnknownOutcome(error)).toBe(false);
    }
  });

  test('keeps explicit service outcomes and unexpected exceptions uncertain', () => {
    expect(hasUnknownOutcome({ outcomeUnknown: true })).toBe(true);
    expect(hasUnknownOutcome({ outcomeUnknown: false })).toBe(false);
    expect(mutationTransportHasUnknownOutcome(new TypeError('unexpected transport failure'))).toBe(true);
  });
});
