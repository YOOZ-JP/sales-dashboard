import StandaloneInputPreviewShell from '@/features/settlement/components/StandaloneInputPreviewShell';

export default async function SettlementPreviewStandalonePage({
  params,
}: {
  params: Promise<{ month: string }>;
}) {
  const { month } = await params;
  return <StandaloneInputPreviewShell month={month} />;
}
