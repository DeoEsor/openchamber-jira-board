const uncertainHostCodes = new Set(['HOST_TIMEOUT', 'REQUEST_FAILED', 'RESPONSE_TOO_LARGE']);

function hostErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function hasUnknownOutcome(error: unknown): boolean {
  if (error && typeof error === 'object' && 'outcomeUnknown' in error
    && (error as { outcomeUnknown: unknown }).outcomeUnknown === true) return true;
  const code = hostErrorCode(error);
  return code !== null && uncertainHostCodes.has(code);
}

export function mutationTransportHasUnknownOutcome(error: unknown): boolean {
  if (hasUnknownOutcome(error)) return true;
  // SDK host refusals with a definite code were rejected before an ambiguous
  // transport outcome. Preserve them so optimistic mutations roll back at once.
  return hostErrorCode(error) === null;
}
