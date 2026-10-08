/**
 * The box beside a subnet — scan all of it. One line for what a
 * ticked subnet's sweep found, the same in the crawl, the collector's log
 * and the Discover status.
 */
import { t } from '../i18n';

export function sweptLine(e: { subnet: string; tried: number; answered: number }): string {
  return e.answered === 0
    ? t('scan.sweptNone', { subnet: e.subnet, tried: e.tried })
    : t('scan.swept', { subnet: e.subnet, tried: e.tried, count: e.answered });
}

/** The ticked subnets that are still listed, each once. */
export function scannedOf(subnets: string[], ticked: string[]): string[] {
  const listed = new Set(subnets.map((s) => s.trim()).filter(Boolean));
  return [...new Set(ticked.map((s) => s.trim()))].filter((s) => listed.has(s));
}
