import Image from 'next/image';
import styles from './a3-product-homepage.module.css';

type A3HomepageProductMediaProps = {
  src: string;
  alt: string;
  sizes: string;
  priority?: boolean;
};

export function A3HomepageProductMedia({
  src,
  alt,
  sizes,
  priority = false,
}: A3HomepageProductMediaProps) {
  return (
    <>
      <div className={styles.mediaFallback} aria-hidden="true">
        <strong>产品界面暂未加载</strong>
        <span>你仍可继续浏览完整学习流程。</span>
      </div>
      <Image src={src} alt={alt} fill priority={priority} sizes={sizes} />
    </>
  );
}
