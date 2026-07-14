'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { A3_HOMEPAGE_ACTIONS, A3_HOMEPAGE_NAV, A3_HOMEPAGE_ROUTES } from './a3-homepage-content';
import styles from './a3-product-homepage.module.css';

export function A3HomepageMobileNav() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() =>
      navRef.current?.querySelector<HTMLElement>('a')?.focus(),
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1121px)');
    const closeForDesktop = (event: MediaQueryListEvent | MediaQueryList) => {
      if (!event.matches || !open) return;
      setOpen(false);
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-homepage-brand]')?.focus(),
      );
    };
    desktop.addEventListener('change', closeForDesktop);
    return () => desktop.removeEventListener('change', closeForDesktop);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        className={styles.menuButton}
        type="button"
        aria-label={open ? '关闭导航' : '打开导航'}
        aria-expanded={open}
        aria-controls="a3-homepage-mobile-nav"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </button>

      {open ? (
        <nav
          ref={navRef}
          id="a3-homepage-mobile-nav"
          className={styles.mobileNav}
          aria-label="移动端首页导航"
        >
          {A3_HOMEPAGE_NAV.map((item) => (
            <a key={item.href} href={item.href} onClick={() => close(true)}>
              {item.label}
            </a>
          ))}
          <Link href={A3_HOMEPAGE_ROUTES.login} onClick={() => close()}>
            {A3_HOMEPAGE_ACTIONS.login}
          </Link>
          <Link href={A3_HOMEPAGE_ROUTES.workspace} prefetch={false} onClick={() => close()}>
            {A3_HOMEPAGE_ACTIONS.workspace}
          </Link>
        </nav>
      ) : null}
    </>
  );
}
