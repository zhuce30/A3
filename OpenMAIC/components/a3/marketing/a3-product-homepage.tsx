'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import {
  A3_HOMEPAGE_ACTIONS,
  A3_HOMEPAGE_BRAND,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_ROUTES,
} from './a3-homepage-content';
import { A3HomepageHero } from './a3-homepage-hero';
import { A3HomepageStory } from './a3-homepage-story';
import styles from './a3-product-homepage.module.css';

export function A3ProductHomepage() {
  const user = useA3CurrentUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const closeMenu = () => setMenuOpen(false);
  const closeMenuAndRestoreFocus = () => {
    setMenuOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }));
  };
  const workspaceHref = user ? A3_HOMEPAGE_ROUTES.workspace : A3_HOMEPAGE_ROUTES.login;
  const workspaceLabel = user
    ? A3_HOMEPAGE_ACTIONS.signedInWorkspace
    : A3_HOMEPAGE_ACTIONS.anonymousWorkspace;

  useEffect(() => {
    const desktopLayout = window.matchMedia('(min-width: 1121px)');
    let focusFrame: number | null = null;

    function closeMenuForDesktop(event: MediaQueryListEvent | MediaQueryList) {
      if (!event.matches) return;

      const activeElement = document.activeElement;
      const shouldMoveFocus =
        activeElement === menuButtonRef.current ||
        (activeElement instanceof Node && mobileNavRef.current?.contains(activeElement));

      setMenuOpen(false);
      if (shouldMoveFocus) {
        focusFrame = window.requestAnimationFrame(() => brandRef.current?.focus());
      }
    }

    closeMenuForDesktop(desktopLayout);
    desktopLayout.addEventListener('change', closeMenuForDesktop);
    return () => {
      desktopLayout.removeEventListener('change', closeMenuForDesktop);
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenuAndRestoreFocus();
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  return (
    <div className={styles.page} data-testid="a3-product-homepage">
      <header className={styles.header}>
        <Link ref={brandRef} href="/a3" className={styles.brand} aria-label="智学引擎首页">
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
          <Link className={styles.secondaryAction} href={workspaceHref}>
            {workspaceLabel}
          </Link>
          <Link className={styles.secondaryAction} href={A3_HOMEPAGE_ROUTES.review}>
            {A3_HOMEPAGE_ACTIONS.review}
          </Link>
          <Link className={styles.headerCta} href={A3_HOMEPAGE_ROUTES.register}>
            {A3_HOMEPAGE_ACTIONS.registerShort}
          </Link>
          <button
            ref={menuButtonRef}
            className={styles.menuButton}
            type="button"
            aria-label={menuOpen ? '关闭导航' : '打开导航'}
            aria-expanded={menuOpen}
            aria-controls="a3-homepage-mobile-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
        </div>
      </header>

      {menuOpen ? (
        <nav
          ref={mobileNavRef}
          id="a3-homepage-mobile-nav"
          className={styles.mobileNav}
          aria-label="移动端首页导航"
        >
          {A3_HOMEPAGE_NAV.map((item) => (
            <a key={item.href} href={item.href} onClick={closeMenuAndRestoreFocus}>
              {item.label}
            </a>
          ))}
          <Link href={workspaceHref} onClick={closeMenu}>
            {workspaceLabel}
          </Link>
          <Link href={A3_HOMEPAGE_ROUTES.review} onClick={closeMenu}>
            {A3_HOMEPAGE_ACTIONS.review}
          </Link>
        </nav>
      ) : null}

      <main>
        <A3HomepageHero />
        <A3HomepageStory />
      </main>
    </div>
  );
}
