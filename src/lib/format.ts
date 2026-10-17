export const money = (value = 0) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
export const compactMoney = (value = 0) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
export const number = (value = 0) => new Intl.NumberFormat('en-US').format(value);
export const date = (value: string) =>
  new Date(value.includes('T') ? value : `${value}T12:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
export const shortDate = (value: string) =>
  new Date(value.includes('T') ? value : `${value}T12:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
  });
export const initials = (name = '') =>
  name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function csv(name: string, columns: string[], rows: unknown[][]) {
  const safe = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+@\-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  download(
    name,
    '\ufeff' + [columns, ...rows].map((row) => row.map(safe).join(',')).join('\r\n'),
    'text/csv;charset=utf-8',
  );
}
