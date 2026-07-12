import type { Metadata } from 'next';
import { A3_HOMEPAGE_METADATA } from '@/components/a3/marketing/a3-homepage-content';
import { A3ProductHomepage } from '@/components/a3/marketing/a3-product-homepage';

export const metadata: Metadata = A3_HOMEPAGE_METADATA;

export default function A3IndexPage() {
  return <A3ProductHomepage />;
}
