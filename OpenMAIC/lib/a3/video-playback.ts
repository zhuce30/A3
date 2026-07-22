export type VideoPlaybackState = 'available' | 'remote' | 'expired' | 'unavailable';

const PROVIDER_URL_MAX_AGE_MS = 25 * 60 * 60 * 1000;

export function getVideoPlaybackState(
  videoUrl: string | undefined,
  artifactCreatedAt?: string,
  now = new Date(),
): VideoPlaybackState {
  const value = String(videoUrl || '').trim();
  if (!value) return 'unavailable';
  if (value.startsWith('/api/a3/resources/video-playback/')) return 'available';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'unavailable';
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) return 'unavailable';

  const expiry = signedUrlExpiry(parsed);
  if (expiry !== null) return expiry <= now.getTime() ? 'expired' : 'remote';

  const createdAt = Date.parse(String(artifactCreatedAt || ''));
  if (Number.isFinite(createdAt) && now.getTime() - createdAt > PROVIDER_URL_MAX_AGE_MS) {
    return 'expired';
  }
  return 'remote';
}

function signedUrlExpiry(url: URL): number | null {
  const query = new Map<string, string>();
  url.searchParams.forEach((value, key) => query.set(key.toLowerCase(), value));

  for (const key of ['expires', 'x-oss-expires', 'x-tos-expires-at']) {
    const raw = query.get(key);
    if (raw && /^\d+$/.test(raw) && Number(raw) > 1_000_000_000) {
      return Number(raw) * 1000;
    }
  }

  const dateValue = query.get('x-tos-date') || query.get('x-amz-date');
  const ttlValue = query.get('x-tos-expires') || query.get('x-amz-expires');
  const dateMatch = dateValue?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!dateMatch || !ttlValue || !/^\d+$/.test(ttlValue)) return null;
  const [, year, month, day, hour, minute, second] = dateMatch;
  const issuedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return issuedAt + Number(ttlValue) * 1000;
}
