import SettlementClient from '@/features/settlement/components/SettlementClient';

type SettlementTab = 'work' | 'compare';

function validMonth(month: string) {
  if (!/^\d{6}$/.test(month)) return false;
  const m = Number(month.slice(4, 6));
  return m >= 1 && m <= 12;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettlementPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const month = firstParam(params.month);
  const tab = firstParam(params.tab);
  const initialMonth = month && validMonth(month) ? month : currentMonth();
  const initialTab: SettlementTab = tab === 'compare' ? 'compare' : 'work';

  return <SettlementClient initialMonth={initialMonth} initialTab={initialTab} />;
}
