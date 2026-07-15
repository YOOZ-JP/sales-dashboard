import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts', 'framer-motion', '@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-tabs', '@radix-ui/react-tooltip', '@radix-ui/react-toggle-group', '@radix-ui/react-dropdown-menu'],
  },
  outputFileTracingIncludes: {
    '/api/settlement/upload': [
      './src/features/settlement/data/aliases/**/*',
      // Local OCR for scanned PDFs (Shueisha): worker script, WASM core,
      // packaged language data, and the native canvas binding are loaded
      // at runtime, so the tracer cannot see them statically.
      './node_modules/tesseract.js/**/*',
      './node_modules/tesseract.js-core/**/*',
      './node_modules/@tesseract.js-data/**/*',
      './node_modules/@napi-rs/**/*',
    ],
    '/api/settlement/export-v2/[month]': [
      './src/features/settlement/data/templates/input_jp_2026_v3_template.xlsx',
    ],
    '/api/settlement/preview-v2/[month]': [
      './src/features/settlement/data/templates/input_jp_2026_v3_template.xlsx',
    ],
  },
  serverExternalPackages: ['exceljs', 'tesseract.js', '@napi-rs/canvas'],
};

export default nextConfig;
