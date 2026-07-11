'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import {
  A3_HOMEPAGE_HERO,
  A3_HOMEPAGE_HERO_MEDIA,
  A3_HOMEPAGE_ROUTES,
} from './a3-homepage-content';
import styles from './a3-product-homepage.module.css';

export function A3HomepageHero() {
  const reduceMotion = useReducedMotion();

  return (
    <section className={styles.hero} aria-labelledby="a3-homepage-title">
      <div className={styles.heroCopy}>
        <h1 id="a3-homepage-title">
          {A3_HOMEPAGE_HERO.titleLines[0]}
          <br />
          {A3_HOMEPAGE_HERO.titleLines[1]}
        </h1>
        <p className={styles.heroSupport}>{A3_HOMEPAGE_HERO.support}</p>
        <Link className={styles.primaryCta} href={A3_HOMEPAGE_ROUTES.register}>
          {A3_HOMEPAGE_HERO.cta}
        </Link>
      </div>

      <motion.div
        className={styles.heroStage}
        initial={reduceMotion ? false : { opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.8, ease: [0.22, 1, 0.36, 1] }}
        data-testid="a3-homepage-hero-stage"
        tabIndex={0}
        aria-label="智学引擎产品界面展示"
      >
        {A3_HOMEPAGE_HERO_MEDIA.map((item, index) => (
          <figure key={item.src} className={styles.heroScreen} data-screen={index + 1}>
            <Image
              src={item.src}
              alt={item.alt}
              fill
              priority={index === 0}
              sizes="(max-width: 767px) 92vw, 62vw"
            />
          </figure>
        ))}
      </motion.div>
    </section>
  );
}
