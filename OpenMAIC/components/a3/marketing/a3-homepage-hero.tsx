import Link from 'next/link';
import {
  A3_HOMEPAGE_HERO,
  A3_HOMEPAGE_HERO_MEDIA,
  A3_HOMEPAGE_ROUTES,
} from './a3-homepage-content';
import { A3HomepageProductMedia } from './a3-homepage-product-media';
import styles from './a3-product-homepage.module.css';

export function A3HomepageHero() {
  return (
    <section className={styles.hero} aria-labelledby="a3-homepage-title">
      <div className={styles.heroCopy}>
        <p className={styles.heroKicker}>为持续学习设计，不止回答一次问题</p>
        <h1 id="a3-homepage-title">
          <span>{A3_HOMEPAGE_HERO.titleLines[0]}</span>
          <span>{A3_HOMEPAGE_HERO.titleLines[1]}</span>
        </h1>
        <p className={styles.heroSupport}>{A3_HOMEPAGE_HERO.support}</p>
        <div className={styles.heroActions}>
          <Link className={styles.primaryCta} href={A3_HOMEPAGE_ROUTES.register}>
            {A3_HOMEPAGE_HERO.cta}
          </Link>
          <a className={styles.secondaryCta} href={A3_HOMEPAGE_HERO.secondaryCta.href}>
            {A3_HOMEPAGE_HERO.secondaryCta.label}
          </a>
        </div>
        <ul className={styles.heroTrust} aria-label="产品可信特性">
          <li>资料来源可追溯</li>
          <li>学习结果会回流</li>
          <li>教师可以介入</li>
        </ul>
      </div>

      <div
        className={styles.heroStage}
        data-testid="a3-homepage-hero-stage"
        aria-label="智学引擎真实产品界面展示"
      >
        {A3_HOMEPAGE_HERO_MEDIA.map((item, index) => (
          <figure key={item.src} className={styles.heroScreen} data-screen={index + 1}>
            <A3HomepageProductMedia
              src={item.src}
              alt={item.alt}
              priority={index === 0}
              sizes="(max-width: 767px) calc(100vw - 62px), (min-width: 1600px) 920px, 68vw"
            />
          </figure>
        ))}
      </div>
    </section>
  );
}
