import { notFound } from 'next/navigation';
import { HelpArticleView } from '@/components/a3/features/help/help-article-view';
import { getA3HelpArticle } from '@/lib/a3/help-content';

export default async function A3HelpArticlePage({
  params,
}: {
  params: Promise<{ articleId: string }>;
}) {
  const { articleId } = await params;
  const article = getA3HelpArticle(articleId);
  if (!article) notFound();
  return <HelpArticleView article={article} />;
}
