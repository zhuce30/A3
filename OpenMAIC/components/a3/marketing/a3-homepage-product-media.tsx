'use client';

import Image from 'next/image';
import { useState } from 'react';
import styles from './a3-product-homepage.module.css';

type A3HomepageProductMediaProps = {
  src: string;
  alt: string;
  sizes: string;
  priority?: boolean;
  fallbackKind?: 'product' | 'teacher';
};

export function A3HomepageProductMedia({
  src,
  alt,
  sizes,
  priority = false,
  fallbackKind = 'product',
}: A3HomepageProductMediaProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className={styles.mediaFallback} role="img" aria-label={alt}>
        <strong>{fallbackKind === 'teacher' ? '数字教师画面暂未加载' : '产品界面暂未加载'}</strong>
        <span>你仍可继续浏览完整学习流程。</span>
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      priority={priority}
      sizes={sizes}
      onError={() => setFailed(true)}
    />
  );
}
