import Link from 'next/link';
import { A3_HOMEPAGE_RESOURCE_TYPES } from './a3-homepage-content';
import { A3HomepageProductMedia } from './a3-homepage-product-media';
import styles from './a3-product-homepage.module.css';

type ResourceStoryItem = {
  id: string;
  index: string;
  title: string;
  summary: string;
  media: string;
  alt: string;
};

export function A3HomepageResourceShowcase({ item }: { item: ResourceStoryItem }) {
  return (
    <section
      id={item.id}
      className={styles.resourceShowcase}
      data-story={item.id}
      data-testid="a3-homepage-resources"
    >
      <div className={styles.resourceIntro}>
        <p className={styles.eyebrow}>{item.index}</p>
        <h2>{item.title}</h2>
        <p>{item.summary}</p>
      </div>

      <ol className={styles.resourceIndex} aria-label="多模态资源类型">
        {A3_HOMEPAGE_RESOURCE_TYPES.map((resource, index) => (
          <li key={resource.type}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{resource.label}</strong>
            <p>{resource.use}</p>
          </li>
        ))}
      </ol>

      <figure className={styles.resourceProductFrame}>
        <A3HomepageProductMedia
          src={item.media}
          alt={item.alt}
          sizes="(max-width: 767px) calc(100vw - 36px), 68vw"
        />
      </figure>

      <Link
        className={`${styles.sectionLink} ${styles.resourceCta}`}
        href="/a3/recommendations"
        prefetch={false}
      >
        查看个性化资源
      </Link>
    </section>
  );
}
