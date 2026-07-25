import Link from 'next/link';
import {
  A3_HOMEPAGE_ACTIONS,
  A3_HOMEPAGE_BRAND,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_ROUTES,
} from './a3-homepage-content';
import { A3HomepageHero } from './a3-homepage-hero';
import { A3HomepageMobileNav } from './a3-homepage-mobile-nav';
import { A3HomepageRoleEntries } from './a3-homepage-role-entry';
import { A3HomepageStory } from './a3-homepage-story';
import styles from './a3-product-homepage.module.css';

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: '智学引擎',
  applicationCategory: 'EducationalApplication',
  operatingSystem: 'Web',
  description:
    '把学习诊断、今日计划、本地资料、AI 辅导、测评复习和学习报告连接起来的个性化学习产品。',
  inLanguage: 'zh-CN',
  url: 'https://a3.zhuce.work/a3',
};

export function A3ProductHomepage() {
  return (
    <div className={styles.page} data-testid="a3-product-homepage">
      <a className={styles.skipLink} href="#main-content">
        跳到主要内容
      </a>

      <header className={styles.header}>
        <Link href="/a3" className={styles.brand} aria-label="智学引擎首页" data-homepage-brand>
          {A3_HOMEPAGE_BRAND}
        </Link>

        <nav className={styles.desktopNav} aria-label="首页导航">
          {A3_HOMEPAGE_NAV.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.headerActions}>
          <A3HomepageRoleEntries />
          <Link className={styles.secondaryAction} href={A3_HOMEPAGE_ROUTES.login}>
            {A3_HOMEPAGE_ACTIONS.login}
          </Link>
          <Link className={styles.headerCta} href={A3_HOMEPAGE_ROUTES.register}>
            {A3_HOMEPAGE_ACTIONS.registerShort}
          </Link>
          <A3HomepageMobileNav />
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <A3HomepageHero />
        <A3HomepageStory />
      </main>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
    </div>
  );
}
