import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoBinaryAsDataUrl, fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import { buildA3CoachingContextPrompt, buildA3VisionFallbackReply } from '@/lib/server/a3-coaching-context';
import type { ClassroomContext } from '@/lib/a3/classroom-types';

type ClassroomContextResponse = {
  success?: boolean;
  error?: string;
  classroom?: ClassroomContext;
};

type VerificationCitation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  score?: number | null;
  snippet?: string;
  previewUrl?: string;
  sourceOrigin?: string;
};

type VerificationResponse = {
  success?: boolean;
  error?: string;
  answer?: string;
  citations?: VerificationCitation[];
  verified?: boolean;
  safety?: {
    safe: boolean;
    category: string;
    reason: string;
  };
  refusalReason?: string;
  claims?: Array<{
    id: string;
    text: string;
    verified: boolean;
    overlap: number;
    citation?: VerificationCitation | null;
  }>;
};

type A3FollowUpSuggestion = {
  label: string;
  question: string;
  type: 'concept' | 'example' | 'practice' | 'evidence' | 'clarify' | string;
  reason: string;
};

type AnswerA3VisionQuestionInput = {
  cookieHeader: string | null;
  image: string;
  message: string;
};

type AnswerA3TextQuestionWithVisualEvidenceInput = {
  cookieHeader: string | null;
  message: string;
};

type A3VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type A3VisionKnowledgeEvidence = {
  title: string;
  location: string;
  snippet: string;
  modality: string;
  previewUrl: string;
  dataUrl?: string;
  score?: number | null;
};

type KnowledgeSearchResponse = {
  success?: boolean;
  results?: Array<{
    score?: number | null;
    text?: string;
    metadata?: Record<string, unknown>;
    resourceName?: string;
    modality?: string;
    location?: { page?: number | null; slide?: number | null };
    previewUrl?: string;
    asset?: { previewUrl?: string; mimeType?: string; kind?: string } | null;
  }>;
};

const A3_TEXT_VISUAL_EVIDENCE_SYSTEM_PROMPT = [
  'You are the A3 classroom tutor. Answer in Simplified Chinese.',
  'Use both the learner question and the local knowledge-base visual evidence images.',
  'Do not invent source names, pages, slides, or citations.',
  'If the retrieved image evidence is unclear or insufficient, say which part is uncertain.',
  'Use strict Markdown. Never wrap Chinese prose, headings, conclusions, or table text in $$ delimiters.',
  'Use $...$ only for short inline formulas and $$...$$ only for standalone formula-only blocks.',
  'If you output a table, use a standard Markdown table with one row per line and a separator row like | --- | --- |.',
  'Organize the answer as: conclusion, explanation, next practice step.',
].join('\n');

const DEFAULT_TEXT_VISUAL_EVIDENCE_TIMEOUT_MS = 6_000;
const MAX_IMAGE_DATA_URL_LENGTH = 7_000_000;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;
const A3_VISION_SOLVER_SYSTEM_PROMPT = `你是“智学引擎”的图片解题助教，请使用简体中文回答。
要求：
1. 先完整转写图片中的题干、公式、图表文字或关键已知条件；如果看不清，明确说明看不清的位置。
2. 再判断题型和考查知识点，不要把当前课堂主题强行套到无关图片上。
3. 给出完整解题步骤，包括关键公式、代入过程、结论和易错提醒。
4. 如果图片内容不足以唯一求解，列出还缺少哪些条件，并给出下一步需要学生补充的内容。
5. 输出必须是严格 Markdown：中文解释、标题、结论、表格文字不能包在 $$ 里。
6. 短公式使用 $...$，独立公式块只在整块完全是公式时使用 $$...$$。
7. 表格必须一行一行输出标准 Markdown 表格，并包含 | --- | --- | 分隔行，不要把多行表格压成一行。
8. 只有在图片涉及学习内容时回答；不要描述学生外貌、环境隐私或无关背景。`;

export async function answerA3TextQuestionWithVisualEvidence({ cookieHeader, message }: AnswerA3TextQuestionWithVisualEvidenceInput) {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) return null;

  const apiKey = process.env.A3_VISION_COACHING_API_KEY || process.env.A3_COACHING_API_KEY || process.env.QWEN_API_KEY || process.env.ASR_QWEN_API_KEY;
  if (!apiKey) return null;

  try {
    const [classroomResult, knowledgeEvidence] = await Promise.all([
      fetchA3DjangoJson<ClassroomContextResponse>('/api/learning/classroom/', cookieHeader),
      fetchA3VisionKnowledgeEvidence(cookieHeader, normalizedMessage),
    ]);
    if (!classroomResult.success || !classroomResult.classroom || knowledgeEvidence.length === 0) {
      return null;
    }

    const baseUrl = (process.env.A3_VISION_COACHING_BASE_URL || process.env.A3_COACHING_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = process.env.A3_VISION_COACHING_MODEL || 'qwen-vl-plus';
    const contextPrompt = buildA3CoachingContextPrompt(classroomResult.classroom);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages: [
          { role: 'system', content: A3_TEXT_VISUAL_EVIDENCE_SYSTEM_PROMPT },
          ...(contextPrompt ? [{ role: 'system' as const, content: contextPrompt }] : []),
          {
            role: 'user',
            content: buildA3TextQuestionVisualEvidenceContent(normalizedMessage, knowledgeEvidence),
          },
        ],
      }),
      signal: AbortSignal.timeout(resolveTextVisualEvidenceTimeoutMs()),
    });

    const result = await response.json().catch(() => ({})) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!response.ok) return null;

    const reply = result.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;

    const verification = await verifyVisionReply(cookieHeader, normalizedMessage, reply, classroomResult.classroom, knowledgeEvidence);
    const mergedCitations = mergeA3VisionCitations(verification.citations ?? [], knowledgeEvidence);
    return apiSuccess({
      reply: verification.answer || reply,
      verified: Boolean(verification.verified),
      citations: mergedCitations,
      claims: mergeA3VisionClaimCitations(verification.claims ?? [], mergedCitations),
      safety: verification.safety,
      refusalReason: verification.refusalReason ?? '',
      degraded: false,
      retrievalMode: 'hybrid_visual',
      visualEvidenceCount: knowledgeEvidence.length,
      followUps: buildA3VisionFollowUps({
        verified: Boolean(verification.verified),
        citations: mergedCitations,
        message: normalizedMessage,
      }),
    });
  } catch {
    return null;
  }
}

export async function answerA3VisionQuestion({ cookieHeader, image, message }: AnswerA3VisionQuestionInput) {
  const normalizedImage = image.trim();
  const normalizedMessage = message.trim() || '请观察这张课堂图片，识别与学习相关的题目、公式或板书，并结合当前学习目标给出解答。';

  if (!normalizedImage) return apiError('MISSING_REQUIRED_FIELD', 400, '请提供图片附件');
  if (normalizedImage.length > MAX_IMAGE_DATA_URL_LENGTH || !IMAGE_DATA_URL_PATTERN.test(normalizedImage)) {
    return apiError('INVALID_REQUEST', 400, '图片格式或大小不符合要求');
  }

  const classroomResult = await fetchA3DjangoJson<ClassroomContextResponse>('/api/learning/classroom/', cookieHeader);
  if (!classroomResult.success || !classroomResult.classroom) {
    return apiError('UPSTREAM_ERROR', 502, classroomResult.error || '课堂上下文加载失败');
  }

  const apiKey = process.env.A3_VISION_COACHING_API_KEY || process.env.A3_COACHING_API_KEY || process.env.QWEN_API_KEY || process.env.ASR_QWEN_API_KEY;
  if (!apiKey) {
    const reply = buildA3VisionFallbackReply(normalizedMessage, classroomResult.classroom);
    const verification = await verifyVisionReply(cookieHeader, normalizedMessage, reply, classroomResult.classroom);
    return apiSuccess({
      reply: verification.answer || reply,
      verified: Boolean(verification.verified),
      citations: verification.citations ?? [],
      claims: verification.claims ?? [],
      safety: verification.safety ?? { safe: true, category: 'vision_fallback', reason: '视觉模型未配置，已降级为文本学习指导' },
      refusalReason: verification.refusalReason ?? 'vision_model_unavailable',
      degraded: true,
      followUps: buildA3VisionFollowUps({
        verified: false,
        citations: verification.citations ?? [],
        message: normalizedMessage,
      }),
    });
  }

  const baseUrl = (process.env.A3_VISION_COACHING_BASE_URL || process.env.A3_COACHING_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const model = process.env.A3_VISION_COACHING_MODEL || 'qwen-vl-plus';
  const contextPrompt = buildA3CoachingContextPrompt(classroomResult.classroom);
  const knowledgeEvidence = await fetchA3VisionKnowledgeEvidence(cookieHeader, normalizedMessage);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      messages: [
        { role: 'system', content: A3_VISION_SOLVER_SYSTEM_PROMPT },
        ...(contextPrompt ? [{ role: 'system' as const, content: contextPrompt }] : []),
        {
          role: 'user',
          content: buildA3VisionUserContent(normalizedMessage, normalizedImage, knowledgeEvidence),
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) return apiError('UPSTREAM_ERROR', 502, result.error?.message || '视觉辅导服务请求失败');

  const reply = result.choices?.[0]?.message?.content?.trim();
  if (!reply) return apiError('UPSTREAM_ERROR', 502, '视觉辅导服务未返回有效内容');

  const verification = await verifyVisionReply(cookieHeader, normalizedMessage, reply, classroomResult.classroom, knowledgeEvidence);
  const mergedCitations = mergeA3VisionCitations(verification.citations ?? [], knowledgeEvidence);
  return apiSuccess({
    reply: verification.answer || reply,
    verified: Boolean(verification.verified),
    citations: mergedCitations,
    claims: mergeA3VisionClaimCitations(verification.claims ?? [], mergedCitations),
    safety: verification.safety,
    refusalReason: verification.refusalReason ?? '',
    degraded: false,
    followUps: buildA3VisionFollowUps({
      verified: Boolean(verification.verified),
      citations: mergedCitations,
      message: normalizedMessage,
    }),
  });
}

export function buildA3VisionUserContent(message: string, image: string, evidence: A3VisionKnowledgeEvidence[] = []): A3VisionContentPart[] {
  const evidenceText = evidence.length
    ? `\n\n知识库视觉证据：\n${evidence.map((item, index) => `[KB${index + 1}] ${item.title} · ${item.location} · ${item.modality}\nOCR/摘要：${item.snippet}`).join('\n')}\n请同时检查学生上传图片和上述本地知识库页面证据；如果两者冲突，要说明不确定处。`
    : '';
  return [
    { type: 'text', text: `${message}${evidenceText}\n请按“题干转写 / 解题步骤 / 答案 / 易错提醒”组织输出。` },
    { type: 'image_url', image_url: { url: image } },
    ...evidence.filter((item) => item.dataUrl).slice(0, 2).map((item) => ({
      type: 'image_url' as const,
      image_url: { url: item.dataUrl as string },
    })),
  ];
}

export function buildA3TextQuestionVisualEvidenceContent(message: string, evidence: A3VisionKnowledgeEvidence[] = []): A3VisionContentPart[] {
  const evidenceText = evidence.length
    ? `\n\nLocal knowledge-base visual evidence:\n${evidence.map((item, index) => `[KB${index + 1}] ${item.title} / ${item.location} / ${item.modality}\nOCR or summary: ${item.snippet}`).join('\n')}`
    : '';
  return [
    { type: 'text', text: `${message}${evidenceText}\nUse the attached local KB page or slide images as evidence. If evidence is insufficient, say it is unverified.` },
    ...evidence.filter((item) => item.dataUrl).slice(0, 2).map((item) => ({
      type: 'image_url' as const,
      image_url: { url: item.dataUrl as string },
    })),
  ];
}

export function buildA3VisionEvidenceCitations(evidence: A3VisionKnowledgeEvidence[]) {
  return evidence.map((item, index) => ({
    id: `kb-visual-${index + 1}`,
    title: item.title,
    location: item.location,
    type: item.modality,
    modality: item.modality,
    score: item.score ?? null,
    snippet: item.snippet,
    previewUrl: item.previewUrl,
    sourceOrigin: '本地知识库视觉证据',
  }));
}

async function fetchA3VisionKnowledgeEvidence(cookieHeader: string | null, query: string): Promise<A3VisionKnowledgeEvidence[]> {
  const search = await fetchA3DjangoJson<KnowledgeSearchResponse>(
    `/api/kb/search/?q=${encodeURIComponent(query)}&top_k=3&include_assets=1&fast=1`,
    cookieHeader,
  );
  if (!search.success || !Array.isArray(search.results)) return [];
  const evidence: A3VisionKnowledgeEvidence[] = [];
  for (const result of search.results) {
    const previewUrl = result.asset?.previewUrl || result.previewUrl || '';
    const mimeType = result.asset?.mimeType || '';
    if (!previewUrl || (mimeType && !mimeType.toLowerCase().startsWith('image/'))) continue;
    const binary = await fetchA3DjangoBinaryAsDataUrl(previewUrl, cookieHeader);
    if (!binary.success || !binary.dataUrl) continue;
    evidence.push({
      title: result.resourceName || String(result.metadata?.original_name || result.metadata?.title || '本地知识库证据'),
      location: formatVisionEvidenceLocation(result.location, result.metadata),
      snippet: String(result.text || result.metadata?.snippet || '').slice(0, 500),
      modality: result.modality || String(result.asset?.kind || 'visual_evidence'),
      previewUrl,
      dataUrl: binary.dataUrl,
      score: result.score ?? null,
    });
    if (evidence.length >= 2) break;
  }
  return evidence;
}

function resolveTextVisualEvidenceTimeoutMs() {
  const value = Number.parseInt(process.env.A3_TEXT_VISUAL_EVIDENCE_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TEXT_VISUAL_EVIDENCE_TIMEOUT_MS;
}

function formatVisionEvidenceLocation(location?: { page?: number | null; slide?: number | null }, metadata?: Record<string, unknown>) {
  if (location?.slide) return `第 ${location.slide} 张幻灯片`;
  if (location?.page) return `第 ${location.page} 页`;
  if (metadata?.display_location) return String(metadata.display_location);
  return '本地知识库';
}

function mergeA3VisionCitations(citations: VerificationResponse['citations'], evidence: A3VisionKnowledgeEvidence[]) {
  return [...(citations ?? []), ...buildA3VisionEvidenceCitations(evidence)];
}

export function mergeA3VisionClaimCitations(
  claims: NonNullable<VerificationResponse['claims']>,
  citations: NonNullable<VerificationResponse['citations']>,
) {
  const visualCitations = citations.filter((citation) => Boolean(citation.previewUrl));
  if (!visualCitations.length) return claims;
  return claims.map((claim) => {
    if (!claim.citation || claim.citation.previewUrl) return claim;
    const matched = findA3VisionCitationMatch(claim.citation, visualCitations);
    if (!matched) return claim;
    return {
      ...claim,
      citation: {
        ...matched,
        ...claim.citation,
        previewUrl: matched.previewUrl,
        sourceOrigin: matched.sourceOrigin || claim.citation.sourceOrigin,
      },
    };
  });
}

function findA3VisionCitationMatch(
  citation: NonNullable<NonNullable<VerificationResponse['claims']>[number]['citation']>,
  candidates: NonNullable<VerificationResponse['citations']>,
) {
  const normalizedTitle = normalizeCitationMatchText(citation.title);
  const normalizedLocation = normalizeCitationMatchText(citation.location);
  const titleAndLocationMatch = candidates.find((candidate) => {
    const candidateTitle = normalizeCitationMatchText(candidate.title);
    const candidateLocation = normalizeCitationMatchText(candidate.location);
    return Boolean(
      normalizedTitle
        && candidateTitle
        && normalizedLocation
        && candidateLocation
        && normalizedTitle === candidateTitle
        && normalizedLocation === candidateLocation,
    );
  });
  if (titleAndLocationMatch) return titleAndLocationMatch;

  if (normalizedLocation) {
    const locationMatch = candidates.find((candidate) => normalizeCitationMatchText(candidate.location) === normalizedLocation);
    if (locationMatch) return locationMatch;
  }

  if (!normalizedTitle) return undefined;
  return candidates.find((candidate) => {
    const candidateTitle = normalizeCitationMatchText(candidate.title);
    return Boolean(candidateTitle && (normalizedTitle === candidateTitle || normalizedTitle.includes(candidateTitle) || candidateTitle.includes(normalizedTitle)));
  });
}

function normalizeCitationMatchText(value?: string) {
  return String(value || '').trim().toLowerCase();
}

function buildA3VisionFollowUps({
  verified,
  citations,
  message,
}: {
  verified?: boolean;
  citations?: unknown[];
  message: string;
}): A3FollowUpSuggestion[] {
  if (!verified || !Array.isArray(citations) || citations.length === 0) {
    return [
      { label: '补充资料', question: '我需要补充哪类图片或课件才能验证这道题？', type: 'evidence', reason: '视觉回答证据不足' },
      { label: '换个问法', question: '能不能只根据图片中可见的信息讲解解题思路？', type: 'clarify', reason: '降低误识别风险' },
    ];
  }
  return [
    { label: '讲关键步骤', question: '能不能把这道题的关键步骤再拆细一点？', type: 'concept', reason: '巩固图片题解题流程' },
    { label: '换一道同类题', question: '能不能基于这道题生成一道同类练习？', type: 'practice', reason: '进入练习闭环' },
    { label: '查易错点', question: `这类题最容易错在哪里？原问题：${message.slice(0, 80)}`, type: 'example', reason: '定位错因' },
  ];
}

async function verifyVisionReply(
  cookieHeader: string | null,
  question: string,
  answer: string,
  classroom: ClassroomContext,
  evidence: A3VisionKnowledgeEvidence[] = [],
): Promise<VerificationResponse> {
  const verification = await postA3DjangoJson<VerificationResponse>('/api/verify/answer/', cookieHeader, {
    question,
    answer,
    sources: [
      ...(classroom.sources ?? []),
      ...buildA3VisionEvidenceCitations(evidence),
    ],
  });
  if (!verification.success) {
    return {
      answer,
      verified: false,
      citations: [],
      claims: [],
      safety: { safe: false, category: 'verifier_unavailable', reason: verification.error || '验证服务暂时不可用' },
      refusalReason: 'verifier_unavailable',
    };
  }
  return verification;
}
