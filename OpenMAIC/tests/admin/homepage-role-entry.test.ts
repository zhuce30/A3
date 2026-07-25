import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const marketingRoot = path.join(root, 'components/a3/marketing');

const contentSource = fs.readFileSync(path.join(marketingRoot, 'a3-homepage-content.ts'), 'utf8');
const homepageSource = fs.readFileSync(
  path.join(marketingRoot, 'a3-product-homepage.tsx'),
  'utf8',
);
const mobileNavSource = fs.readFileSync(
  path.join(marketingRoot, 'a3-homepage-mobile-nav.tsx'),
  'utf8',
);
const roleEntryPath = path.join(marketingRoot, 'a3-homepage-role-entry.tsx');
const roleEntrySource = fs.existsSync(roleEntryPath) ? fs.readFileSync(roleEntryPath, 'utf8') : '';
const stylesSource = fs.readFileSync(
  path.join(marketingRoot, 'a3-product-homepage.module.css'),
  'utf8',
);

describe('A3 homepage role workspace entry', () => {
  it('defines the three concise role intents with exact login routes', () => {
    expect(contentSource).toContain('A3_HOMEPAGE_ROLE_ENTRIES');
    expect(contentSource).toContain("label: '学生', href: '/a3/login?workspace=student'");
    expect(contentSource).toContain("label: '教师', href: '/a3/login?workspace=teacher'");
    expect(contentSource).toContain("label: '管理员', href: '/a3/login?workspace=admin'");
  });

  it('renders one shared Lucide role entry in desktop and mobile navigation', () => {
    expect(roleEntrySource).toContain("from 'lucide-react'");
    expect(roleEntrySource).toContain('GraduationCap');
    expect(roleEntrySource).toContain('Presentation');
    expect(roleEntrySource).toContain('ShieldCheck');
    expect(roleEntrySource).toContain('A3_HOMEPAGE_ROLE_ENTRIES.map');
    expect(roleEntrySource).not.toContain('<p');
    expect(roleEntrySource).not.toMatch(/角色卡片|权限说明|角色说明/);

    expect(homepageSource).toContain('<A3HomepageRoleEntries />');
    expect(mobileNavSource).toContain('<A3HomepageRoleEntries mobile');
  });

  it('keeps login and student registration while removing the duplicate workspace action', () => {
    expect(homepageSource).toContain('A3_HOMEPAGE_ROUTES.login');
    expect(homepageSource).toContain('A3_HOMEPAGE_ROUTES.register');
    expect(mobileNavSource).toContain('A3_HOMEPAGE_ROUTES.login');
    expect(mobileNavSource).toContain('A3_HOMEPAGE_ROUTES.register');
    expect(homepageSource).not.toContain('A3_HOMEPAGE_ROUTES.workspace');
    expect(mobileNavSource).not.toContain('A3_HOMEPAGE_ROUTES.workspace');
    expect(contentSource).not.toContain("workspace: '进入学习区'");
  });

  it('provides compact overflow-safe role controls for desktop and 390px mobile menus', () => {
    expect(stylesSource).toMatch(/\.roleEntries\s*\{[\s\S]*?display:\s*flex/);
    expect(stylesSource).toMatch(/\.roleEntry\s*\{[\s\S]*?min-width:\s*0/);
    expect(stylesSource).toMatch(
      /\.mobileRoleEntries\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(stylesSource).toMatch(/@media \(max-width:\s*1240px\)[\s\S]*?\.roleEntries\s*\{[\s\S]*?display:\s*none/);
    expect(stylesSource).toContain('@media (max-width: 390px)');

    const roleControlStyles = stylesSource.match(
      /\.(?:roleEntries|roleEntry|mobileRoleEntries)[\s\S]*?(?=@media \(min-width: 1200px\))/,
    )?.[0];
    expect(roleControlStyles).not.toMatch(/(?:blue|#(?:0{0,2}[0-9a-f]?f{2}|[0-9a-f]{2}[0-9a-f]{2}f{2}))/i);
  });
});
