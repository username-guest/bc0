/**
 * Storefront chrome shared by the Next.js tenant layout and the browser test harness:
 * white-label brand variables, masthead, and the presentation-only flag context.
 */
import { contrastRatio, relLuminance } from '@/imaging/compose';
import { parseHex } from '@/imaging/palette';
import { FlagsProvider, type PublicConfig } from './flags';

/** Black or white text on the brand colour — whichever has the better WCAG contrast. */
export function inkOn(hex: string): string {
  const l = relLuminance(...parseHex(hex));
  return contrastRatio(l, 1) >= contrastRatio(l, 0) ? '#FFFFFF' : '#16191D';
}

export function TenantShell({ config, children, section = 'Logo studio' }: { config: PublicConfig; children: React.ReactNode; section?: string }) {
  const b = config.branding;
  const style = {
    '--brand': b.primaryHex,
    '--brand-ink': inkOn(b.primaryHex),
    '--brand-deep': b.secondaryHex,
    '--font-display': `"${b.fontFamily}", ui-sans-serif, system-ui, sans-serif`,
  } as React.CSSProperties;
  return (
    <div className="shell" style={style}>
      <header className="masthead">
        <span className="wordmark">{b.displayName}</span>
        <span className="masthead-note">{section}</span>
      </header>
      <FlagsProvider config={config}>{children}</FlagsProvider>
    </div>
  );
}
