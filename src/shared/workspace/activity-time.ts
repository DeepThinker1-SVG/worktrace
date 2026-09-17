import type { AppLocale } from '../i18n';

const minuteMs = 60_000;

export function formatRelativeActivityTime(timestamp: number, now = Date.now(), locale: AppLocale = 'zh-CN'): string {
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / minuteMs);

  if (minutes < 1) {
    return locale === 'en' ? 'just now' : '刚刚';
  }

  if (minutes < 60) {
    return locale === 'en' ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago` : `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return locale === 'en' ? `${hours} ${hours === 1 ? 'hour' : 'hours'} ago` : `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return locale === 'en' ? `${days} ${days === 1 ? 'day' : 'days'} ago` : `${days} 天前`;
  }

  return formatActivityDateOnly(timestamp, locale);
}

export function formatActivityDateTime(timestamp: number, locale: AppLocale = 'zh-CN'): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatActivityDateOnly(timestamp: number, locale: AppLocale = 'zh-CN'): string {
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'en-CA' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}
