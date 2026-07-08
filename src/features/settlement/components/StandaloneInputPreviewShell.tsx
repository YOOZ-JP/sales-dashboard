'use client';

import { AppProvider } from '@/context/AppContext';
import InputPreviewWindow from './InputPreviewWindow';

export default function StandaloneInputPreviewShell({ month }: { month: string }) {
  return (
    <AppProvider>
      <main className="h-screen overflow-hidden bg-slate-50 p-3 text-slate-950 dark:bg-slate-950 dark:text-white">
        <InputPreviewWindow month={month} />
      </main>
    </AppProvider>
  );
}
