import { GraduationCap, Presentation, ShieldCheck, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { A3_HOMEPAGE_ROLE_ENTRIES } from './a3-homepage-content';
import styles from './a3-product-homepage.module.css';

const ROLE_ICONS: Record<(typeof A3_HOMEPAGE_ROLE_ENTRIES)[number]['role'], LucideIcon> = {
  student: GraduationCap,
  teacher: Presentation,
  admin: ShieldCheck,
};

type A3HomepageRoleEntriesProps = {
  mobile?: boolean;
  onNavigate?: () => void;
};

export function A3HomepageRoleEntries({
  mobile = false,
  onNavigate,
}: A3HomepageRoleEntriesProps) {
  return (
    <div
      className={mobile ? styles.mobileRoleEntries : styles.roleEntries}
      role="group"
      aria-label="选择工作区"
    >
      {A3_HOMEPAGE_ROLE_ENTRIES.map((entry) => {
        const Icon = ROLE_ICONS[entry.role];
        return (
          <Link
            key={entry.role}
            className={styles.roleEntry}
            href={entry.href}
            onClick={onNavigate}
            data-workspace-role={entry.role}
          >
            <Icon aria-hidden="true" strokeWidth={1.8} />
            <span>{entry.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
