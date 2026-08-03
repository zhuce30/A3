import { handleTutorVoicePreview } from '@/lib/server/a3-tutor-voice-preview-route-handler';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleTutorVoicePreview(request);
}
