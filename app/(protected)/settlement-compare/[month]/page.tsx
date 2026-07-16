import { notFound, redirect } from "next/navigation";

function validMonth(month: string) {
  if (!/^\d{6}$/.test(month)) return false;
  const m = Number(month.slice(4, 6));
  return m >= 1 && m <= 12;
}

export default async function SettlementComparePage({
  params,
}: {
  params: Promise<{ month: string }>;
}) {
  const { month } = await params;
  if (!validMonth(month)) notFound();
  redirect(`/settlement?month=${month}&tab=compare`);
}
